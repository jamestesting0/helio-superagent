#!/usr/bin/env python3
"""Persist task questions, deliver them to Discord, and watch for answers."""
from __future__ import annotations
import argparse, hashlib, json, os, re, sqlite3, sys, time, urllib.error, urllib.request, uuid
from pathlib import Path
from datetime import datetime

BASE='https://discord.com/api/v10'
ID=re.compile(r'^[0-9]{1,30}$'); LANE=re.compile(r'^[a-z0-9][a-z0-9._-]{1,60}$')
STATE=Path(os.environ.get('DORI_STATE_DIR',''))
TOKEN=os.environ.get('DORI_DISCORD_TOKEN','')
OWNER=os.environ.get('DORI_DISCORD_OWNER_ID','')
ALLOWED=set(x.strip() for x in os.environ.get('DORI_DISCORD_ALLOWED','').split(',') if x.strip())
STAFF=os.environ.get('HELIO_STAFF_CHAT','').strip()

def trusted_now():
 return {x.strip() for x in os.environ.get('DORI_DISCORD_TRUSTED_IDS','').split(',') if ID.fullmatch(x.strip())}

def may_answer(row,author):
 # Staff questions accept the owner or anyone trusted at the moment they answer.
 if row['audience']=='staff':return author==OWNER or author in trusted_now()
 return author==OWNER or (row['audience']=='thread' and author==row['recipient'])

def db_connect():
 if not STATE.is_absolute():raise ValueError('DORI_STATE_DIR must be an absolute path')
 STATE.mkdir(parents=True,exist_ok=True,mode=0o700);p=STATE/'discord-questions.sqlite'
 if p.is_symlink():raise ValueError('refusing symlinked question database')
 fd=os.open(p,os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600);os.close(fd);os.chmod(p,0o600)
 db=sqlite3.connect(p,timeout=10);db.row_factory=sqlite3.Row
 db.execute('PRAGMA busy_timeout=10000');db.execute('PRAGMA journal_mode=WAL')
 db.execute("""CREATE TABLE IF NOT EXISTS questions (
 id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, lane TEXT NOT NULL, audience TEXT NOT NULL,
 recipient TEXT NOT NULL, question TEXT NOT NULL, status TEXT NOT NULL, channel_id TEXT,
 message_id TEXT, answer_id TEXT, answer_author TEXT, answer_role TEXT, answer_scope TEXT,
 answer_text TEXT, error TEXT, updated INTEGER NOT NULL)""")
 present={r[1] for r in db.execute('PRAGMA table_info(questions)')}
 for name,kind in (('options','TEXT'),('components','TEXT'),('answer_source','TEXT'),('announced_at','INTEGER'),
                   ('cleared_at','INTEGER'),('pending_by','TEXT'),('pending_at','INTEGER')):
  if name not in present:db.execute(f'ALTER TABLE questions ADD COLUMN {name} {kind}')
 db.commit();return db

def components_for(id,options,allow_other):
 # Option values are indexes: the watcher maps them back to the stored labels.
 rows=[]
 if options:
  rows.append({'type':1,'components':[{'type':3,'custom_id':f'h1:q:{id}:pick','placeholder':'Choose an answer','min_values':1,'max_values':1,
   'options':[{'label':label,'value':str(i)} for i,label in enumerate(options)]}]})
 if allow_other:
  rows.append({'type':1,'components':[{'type':2,'style':2,'label':'Other…' if options else 'Answer…','custom_id':f'h1:q:{id}:other'}]})
 return rows

def clean_options(options,allow_other):
 options=[o.strip() for o in options or []]
 if options and not 2<=len(options)<=5:raise ValueError('give 2-5 options')
 if any(not 1<=len(o)<=80 for o in options) or len(set(options))!=len(options):raise ValueError('options must be unique and 1-80 characters')
 if not options and not allow_other:raise ValueError('--no-other needs --option choices')
 return options

def request(method,path,body=None):
 if not TOKEN:raise ValueError('DORI_DISCORD_TOKEN is missing')
 data=None if body is None else json.dumps(body).encode()
 req=urllib.request.Request(BASE+path,data=data,method=method,headers={'Authorization':'Bot '+TOKEN,'Content-Type':'application/json','User-Agent':'DiscordBot (https://discord.com, 1.0)'})
 try:
  with urllib.request.urlopen(req,timeout=15) as response:return json.load(response)
 except urllib.error.HTTPError as e:raise DiscordError(e.code) from None

class DiscordError(Exception):
 def __init__(self,status):self.status=status;super().__init__(f'Discord HTTP {status}')

def event(row):
 return {k:row[k] for k in ('id','lane','audience','recipient','question','status','channel_id','message_id','answer_id','answer_author','answer_role','answer_scope','answer_text','error')}

def summary(row: sqlite3.Row) -> str:
 fields={k:row[k] for k in ('id','lane','audience','status','answer_role','answer_scope')}
 fields.update(preview=(row['answer_text'] or row['question'] or row['error'] or '')[:200],read=f"helio question show {row['id']}")
 encoded=json.dumps(fields,ensure_ascii=True,separators=(',',':'))
 while len(encoded)>950:
  fields['preview']=fields['preview'][:-20]
  encoded=json.dumps(fields,ensure_ascii=True,separators=(',',':'))
 return encoded

def poll(db: sqlite3.Connection, lane: str | None, seen: dict[str,tuple[str,int,str]]) -> None:
 pending=0
 for row in db.execute("SELECT * FROM questions WHERE status NOT IN ('done','cancelled') ORDER BY updated,id"):
  if lane and row['lane']!=lane:continue
  if row['status']=='answering':continue
  stuck=row['status']=='sending' and int(time.time()*1000)-row['updated']>30000
  kind='ANSWERED' if row['status']=='answered' else 'DELIVERY_ERROR' if row['status'] in ('send_failed','delivery_unknown') or stuck else 'PENDING'
  version=(row['status'],row['updated'],kind)
  if seen.get(row['id'])==version:
   if row['status']=='answered':pending+=1
   continue
  seen[row['id']]=version
  print('QUESTION_'+kind+' '+summary(row),flush=True)
 if pending:
  print(f'QUESTION_PENDING count={pending} status=answered read="helio question list"',flush=True)

def detail(row: sqlite3.Row, offset: int) -> str:
 text=json.dumps(event(row),ensure_ascii=True)
 content=text[offset:offset+6000];next_offset=offset+len(content)
 return json.dumps({'id':row['id'],'status':row['status'],'offset':offset,'content':content,
  'truncated':next_offset<len(text),'read_more':f"helio question show {row['id']} --offset {next_offset}" if next_offset<len(text) else None})

def write(db,id,status,when=None,**values):
 # `when` makes the change conditional on the status just read: a Discord click may claim the question in between.
 fields={'status':status,'updated':int(time.time()*1000),**values}
 changed=db.execute('UPDATE questions SET '+','.join(k+'=?' for k in fields)+' WHERE id=?'+(' AND status=?' if when else ''),
  (*fields.values(),id,*([when] if when else []))).rowcount;db.commit()
 if when and not changed:raise ValueError('question changed while this command ran; inspect it again')

def allowed_channel(channel):
 current=channel;seen=set()
 for _ in range(3):
  if current in ALLOWED:return True
  if not ID.fullmatch(current) or current in seen:return False
  seen.add(current);meta=request('GET',f'/channels/{current}');current=meta.get('parent_id') or ''
 return current in ALLOWED

def channel_for(row):
 if row['audience']=='owner':
  if not ID.fullmatch(OWNER) or row['recipient']!=OWNER:raise ValueError('owner identity not configured')
  dm=request('POST','/users/@me/channels',{'recipient_id':OWNER});channel=str(dm.get('id',''))
 elif row['audience']=='thread':
  lane_path=STATE/'lanes'/f"{row['lane']}.json"
  if lane_path.is_symlink() or not lane_path.is_file():raise ValueError('no registered lane for this question')
  lane=json.loads(lane_path.read_text());channel=str(lane.get('thread','')).removeprefix('discord:')
  if not ID.fullmatch(channel) or not allowed_channel(channel):raise ValueError('lane has no authorized Discord work thread')
 elif row['audience']=='staff':
  channel=STAFF
  if not ID.fullmatch(channel) or not allowed_channel(channel):raise ValueError('HELIO_STAFF_CHAT is not an allowed channel')
 else:raise ValueError('invalid question audience')
 if not ID.fullmatch(channel):raise ValueError('invalid Discord channel')
 return channel

def reconcile_pending(db):
 delivery=STATE/'discord-delivery.sqlite'
 if not delivery.is_file() or delivery.is_symlink():return
 incoming=sqlite3.connect(f'file:{delivery}?mode=ro',uri=True)
 try:
  rows=incoming.execute("SELECT id,payload FROM delivery WHERE stream='inbound' AND payload IS NOT NULL").fetchall()
  accepted={r[0] for r in incoming.execute("SELECT id FROM acceptance WHERE stream='inbound'")} if incoming.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='acceptance'").fetchone() else set()
 finally:incoming.close()
 for delivery_id,raw in rows:
  try:message=json.loads(raw)
  except (ValueError,TypeError):continue
  if not isinstance(message,dict) or message.get('role')=='BOT_BUG_REPORT' or not message.get('reply_to'):continue
  if any(not isinstance(message.get(k),str) or not ID.fullmatch(message[k]) for k in ('message_id','channel_id','author_id','reply_to')):
   continue
  row=db.execute("SELECT * FROM questions WHERE status='awaiting_answer' AND channel_id=? AND message_id=?",(message.get('channel_id'),message.get('reply_to'))).fetchone()
  if not row:continue
  author=message.get('author_id')
  if not may_answer(row,author):continue
  if not ID.fullmatch(str(message.get('message_id',''))) or not isinstance(message.get('content'),str):continue
  # Stored roles and channel_policy are historical decisions, not current authority.
  origin=message.get('discord_origin')
  if message.get('preparation_complete') is not True or not isinstance(origin,dict) or type(origin.get('version')) is not int or origin['version']!=1:
   continue
  if delivery_id!=message['message_id'] or any(origin.get(k)!=message.get(k) for k in ('message_id','channel_id','author_id','reply_to')):
   continue
  if any(not isinstance(origin.get(k),str) or not ID.fullmatch(origin[k]) for k in ('message_id','channel_id','author_id','reply_to')):
   continue
  if origin.get('bot') is not False or 'webhook_id' not in origin or origin['webhook_id'] is not None:
   continue
  if 'guild_id' not in origin or (origin['guild_id'] is not None and (not isinstance(origin['guild_id'],str) or not ID.fullmatch(origin['guild_id']))):
   continue
  if 'reply_author_id' not in origin or (origin['reply_author_id'] is not None and (not isinstance(origin['reply_author_id'],str) or not ID.fullmatch(origin['reply_author_id']))):
   continue
  mentions=origin.get('mention_ids')
  if not isinstance(mentions,list) or any(not isinstance(x,str) or not ID.fullmatch(x) for x in mentions):
   continue
  sent_at=message.get('sent_at')
  if not isinstance(sent_at,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})',sent_at):
   continue
  try:
   timestamp=datetime.fromisoformat(sent_at.replace('Z','+00:00')).timestamp()
   if delivery_id not in accepted and time.time()-timestamp>72*60*60:
    continue
   trusted_ids,trusted_channels,normal_channels,report_channels=(
    {x.strip() for x in os.environ.get(name,'').split(',') if x.strip()}
    for name in ('DORI_DISCORD_TRUSTED_IDS','DORI_DISCORD_TRUSTED_CHANNELS','DORI_DISCORD_NORMAL_CHANNELS','DORI_DISCORD_REPORT_CHANNELS'))
   if not ID.fullmatch(OWNER) or not ALLOWED or any(not ID.fullmatch(x) for ids in (ALLOWED,trusted_ids,trusted_channels,normal_channels,report_channels) for x in ids):
    continue
   if trusted_channels & normal_channels:
    continue
   bot=request('GET','/users/@me').get('id')
   if not isinstance(bot,str) or not ID.fullmatch(bot) or author==bot:
    continue
   channel=request('GET',f"/channels/{origin['channel_id']}")
   if channel.get('guild_id')!=origin['guild_id']:
    continue
   ancestors={origin['channel_id']}
   if origin['guild_id'] is None:
    if channel.get('type') not in (1,3) or (author!=OWNER and author not in trusted_ids):
     continue
   else:
    if channel.get('type') not in (0,5,10,11,12,15):
     continue
    for _ in range(2):
     parent=channel.get('parent_id')
     if parent is None:
      break
     if not isinstance(parent,str) or not ID.fullmatch(parent) or parent in ancestors:
      raise ValueError('unverifiable channel ancestry')
     channel=request('GET',f'/channels/{parent}')
     if channel.get('guild_id')!=origin['guild_id']:
      raise ValueError('channel ancestry changed')
     if parent in trusted_channels | normal_channels and channel.get('type') not in (0,5,10,11,12,15):
      raise ValueError('invalid policy channel')
     ancestors.add(parent)
    if not ancestors & ALLOWED:
     continue
    if ancestors & trusted_channels and ancestors & normal_channels:
     continue
    if not ancestors & trusted_channels and bot not in mentions:
     continue
  except (DiscordError,OSError,TimeoutError):
   print('QUESTION_WARN '+json.dumps({'message_id':delivery_id,'reason':'authorization-unavailable','retained_pending':True}),file=sys.stderr)
   continue
  except ValueError:
   continue
  role='OWNER_REQUEST' if author==OWNER else 'TRUSTED_REQUEST' if author in trusted_ids else 'STAFF_QUESTION'
  scope='may-request-work' if author==OWNER else 'trusted-pr-merge-restart' if author in trusted_ids else 'may-report-issue' if origin['guild_id'] is not None and ancestors & report_channels else 'answer-only'
  db.execute("UPDATE questions SET status='answered',answer_id=?,answer_author=?,answer_role=?,answer_scope=?,answer_text=?,updated=? WHERE id=? AND status='awaiting_answer'",(message['message_id'],author,role,scope,message['content'],int(time.time()*1000),row['id']))
  db.commit()

def format_links(text):
 pattern=r'https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+/(?:issues|pull)/[0-9]+(?:[/?#][^\s<>()]*)?'
 def replace(m):
  url=m.group();suffix=re.search(r'[.,!?;:]+$',url);tail=suffix.group() if suffix else ''
  core=url[:-len(tail)] if tail else url
  if m.start()>0 and text[m.start()-1]=='<' and text[m.start()+len(core):m.start()+len(core)+1]=='>':return url
  return '<'+core+'>'+tail
 return re.sub(pattern,replace,text,flags=re.I)

def send_question(db,id):
 row=db.execute('SELECT * FROM questions WHERE id=?',(id,)).fetchone()
 if not row:raise ValueError('unknown question')
 if row['status'] not in ('queued','send_failed'):raise ValueError('question already sent or delivery uncertain; inspect before retry')
 try:channel=channel_for(row)
 except (DiscordError,ValueError,OSError) as e:
  db.execute("UPDATE questions SET status='send_failed',error=?,updated=? WHERE id=? AND status IN ('queued','send_failed')",(str(e),int(time.time()*1000),id));db.commit()
  return event(db.execute('SELECT * FROM questions WHERE id=?',(id,)).fetchone())
 # Claim once before POST. A crash or timeout is ambiguous: never blindly retry.
 db.execute('BEGIN IMMEDIATE')
 changed=db.execute("UPDATE questions SET status='sending',channel_id=?,error=NULL,updated=? WHERE id=? AND status IN ('queued','send_failed')",(channel,int(time.time()*1000),id)).rowcount
 db.commit()
 if not changed:return event(db.execute('SELECT * FROM questions WHERE id=?',(id,)).fetchone())
 pings=[x for x in dict.fromkeys([OWNER,*sorted(trusted_now())]) if ID.fullmatch(x)] if row['audience']=='staff' else []
 mention=' '.join(f'<@{x}>' for x in pings)
 # Rows from before components were always added keep the reply-only hint.
 hint=('Choose below or reply to this message.' if json.loads(row['options'] or '[]') else 'Answer below or reply to this message.') if row['components'] else 'Please reply directly to this message so I can route your answer to the right task.'
 content=(mention+'\n' if mention else '')+f"Question [{id}]\n{format_links(row['question'])}\n\n{hint}"
 body={'content':content,'allowed_mentions':{'parse':[],**({'users':pings[:100]} if pings else {})},'nonce':id,'enforce_nonce':True}
 if row['components']:body['components']=json.loads(row['components'])
 try:
  result=request('POST',f'/channels/{channel}/messages',body)
  mid=str(result.get('id',''))
  if not ID.fullmatch(mid):raise ValueError('Discord returned an invalid message ID')
  write(db,id,'awaiting_answer',message_id=mid,error=None)
  reconcile_pending(db)
 except DiscordError as e:write(db,id,'delivery_unknown' if e.status>=500 else 'send_failed',error=str(e))
 except (OSError,ValueError,TimeoutError) as e:write(db,id,'delivery_unknown',error='Discord delivery could not be confirmed')
 return event(db.execute('SELECT * FROM questions WHERE id=?',(id,)).fetchone())

def create_question(db,lane,audience,recipient,text,options=None,allow_other=True):
 if not LANE.fullmatch(lane) or '..' in lane:raise ValueError('invalid lane key')
 if audience=='owner':recipient=OWNER
 if audience=='staff':recipient=STAFF
 if audience not in ('owner','thread','staff') or not ID.fullmatch(recipient):raise ValueError('expected a valid recipient ID')
 text=text.strip()
 if not text or len(text)>1500:raise ValueError('question must have 1-1500 characters')
 options=clean_options(options,allow_other)
 fingerprint=hashlib.sha256(json.dumps([lane,audience,recipient,text,options,allow_other],ensure_ascii=False).encode()).hexdigest()
 db.execute('BEGIN IMMEDIATE')
 existing=db.execute("SELECT * FROM questions WHERE fingerprint=? AND status NOT IN ('done','cancelled')",(fingerprint,)).fetchone()
 if existing:db.commit();return event(existing)
 id=uuid.uuid4().hex[:20]
 db.execute('INSERT INTO questions (id,fingerprint,lane,audience,recipient,question,status,updated,options,components) VALUES (?,?,?,?,?,?,?,?,?,?)',
  (id,fingerprint,lane,audience,recipient,text,'queued',int(time.time()*1000),json.dumps(options),json.dumps(components_for(id,options,allow_other))));db.commit()
 return send_question(db,id)

def recover(db,id):
 row=db.execute('SELECT * FROM questions WHERE id=?',(id,)).fetchone()
 if not row or row['status'] not in ('sending','delivery_unknown'):raise ValueError('question does not have uncertain delivery')
 if not row['channel_id']:raise ValueError('question has no recorded target channel')
 me=request('GET','/users/@me');messages=request('GET',f"/channels/{row['channel_id']}/messages?limit=100")
 if not ID.fullmatch(str(me.get('id',''))) or not isinstance(messages,list):raise ValueError('cannot verify bot identity or message history')
 marker=f"Question [{id}]"
 # Staff posts start with mentions; the question marker is the next complete line.
 matches=[x for x in messages if x.get('author',{}).get('id')==me.get('id')
          and (x.get('content','').startswith(marker) or x.get('content','').splitlines()[1:2]==[marker])
          and ID.fullmatch(str(x.get('id','')))]
 if len(matches)==1:
  write(db,id,'awaiting_answer',message_id=matches[0]['id'],error=None);reconcile_pending(db)
 elif len(matches)>1:write(db,id,'delivery_unknown',error='Multiple matching messages; inspect manually')
 else:write(db,id,'delivery_unknown',error='No matching recent message; delivery is still uncertain')
 return event(db.execute('SELECT * FROM questions WHERE id=?',(id,)).fetchone())

def read_stamp() -> str:
 """Read the deployed monitor version, including an absent initial stamp."""
 try:
  return (Path.home()/'.dori/elobot/monitors-version').read_text()
 except FileNotFoundError:
  return ''

def watch(db,lane):
 if lane and (not LANE.fullmatch(lane) or '..' in lane):raise ValueError('invalid lane key')
 stamp=read_stamp()
 check_seconds=min(30.0,float(os.environ.get('HELIO_STAMP_CHECK_SECONDS','30')))
 if check_seconds<=0:raise ValueError('HELIO_STAMP_CHECK_SECONDS must be positive')
 seen={}
 print('QUESTION_READY '+json.dumps({'lane':lane or 'all'}),flush=True)
 while True:
  poll(db,lane,seen)
  deadline=time.monotonic()+3
  while True:
   new_stamp=read_stamp()
   if new_stamp and new_stamp!=stamp:
    version=next(iter(new_stamp.split()),'')[:100]
    print(f'QUESTION_WARN updated to {version}; restarting to load it',flush=True)
    os.execv(sys.executable,[sys.executable,*sys.argv])
   remaining=deadline-time.monotonic()
   if remaining<=0:break
   time.sleep(min(check_seconds,remaining))

def confirm_argv(a):
 """`ask --action` is an approval prompt: `helio confirm ask` owns its wording, click proof and expiry."""
 if a.text is not None or a.option or a.other or a.no_other or a.audience or a.recipient:
  raise ValueError('--action takes no --text, --option, --other, --no-other, --audience or --recipient: the prompt wording is fixed')
 if a.lane not in (None,'lead'):raise ValueError('only the lead asks for approvals; report to the lead instead')
 if a.reply_to and not a.channel:raise ValueError('--reply-to needs the --channel it is in')
 channel=a.channel or STAFF
 if not channel:raise ValueError('HELIO_STAFF_CHAT is not set; pass --channel')
 repo=os.environ.get('HELIO_GITHUB_REPO','jamestesting0/elo-bot');number=(a.target or '').rpartition('#')[2]
 note=[]
 if not a.channel:note+=[f'<@{x}>' for x in dict.fromkeys([OWNER,*sorted(trusted_now())]) if ID.fullmatch(x)]
 if a.action!='restart' and number.isdigit():note.append(f"<https://github.com/{repo}/{'issues' if a.action=='pr' else 'pull'}/{number}>")
 argv=['helio','confirm','ask','--action',a.action,'--target',a.target or '','--revision',a.revision or '','--channel',channel]
 if a.reply_to:argv+=['--reply-to',a.reply_to]
 return argv+(['--note',' '.join(note)] if note else [])

def main():
 parser=argparse.ArgumentParser();sub=parser.add_subparsers(dest='cmd',required=True)
 ask=sub.add_parser('ask');ask.add_argument('--lane');ask.add_argument('--audience',choices=('owner','staff','thread'));ask.add_argument('--recipient',default='');ask.add_argument('--text')
 ask.add_argument('--option',action='append');ask.add_argument('--other',action='store_true',help='accepted; a typed answer is allowed by default')
 ask.add_argument('--no-other',action='store_true',help='menu only, no typed answer')
 for name in ('--action','--target','--revision','--channel','--reply-to'):ask.add_argument(name,choices=('pr','merge','restart') if name=='--action' else None)
 for name in ('retry','recover','ack','cancel','withdraw','show'):
  command=sub.add_parser(name);command.add_argument('id')
  if name=='show':command.add_argument('--offset',type=int,default=0)
 w=sub.add_parser('watch');w.add_argument('--lane')
 listing=sub.add_parser('list');listing.add_argument('--offset',type=int,default=0)
 sub.add_parser('reconcile')
 a=parser.parse_args()
 if a.cmd=='ask' and a.action:
  # Before the question database opens: the router's confirm route sets the release-check environment.
  argv=confirm_argv(a);os.execvp(argv[0],argv)
 if a.cmd=='ask' and (not a.lane or not a.audience or a.text is None or a.target or a.revision or a.channel or a.reply_to):
  parser.error('ask needs --lane, --audience and --text; --target/--revision/--channel/--reply-to need --action')
 db=db_connect()
 try:
  if getattr(a,'offset',0)<0:parser.error('--offset must be nonnegative')
  if a.cmd=='ask':result=create_question(db,a.lane,a.audience,a.recipient,a.text,a.option,not a.no_other)
  elif a.cmd=='retry':result=send_question(db,a.id)
  elif a.cmd=='recover':result=recover(db,a.id)
  elif a.cmd=='watch':return watch(db,a.lane)
  elif a.cmd=='reconcile':
   reconcile_pending(db);result=[event(r) for r in db.execute("SELECT * FROM questions WHERE status='answered' ORDER BY updated")]
  elif a.cmd=='list':
   rows=db.execute("SELECT * FROM questions WHERE status NOT IN ('done','cancelled') ORDER BY updated,id LIMIT 26 OFFSET ?",(a.offset,)).fetchall()
   result={'items':[json.loads(summary(r)) for r in rows[:25]],'next':f'helio question list --offset {a.offset+25}' if len(rows)>25 else None}
  else:
   row=db.execute('SELECT * FROM questions WHERE id=?',(a.id,)).fetchone()
   if not row:raise ValueError('unknown question')
   if a.cmd=='ack':
    if row['status']!='answered':raise ValueError('cannot acknowledge an unanswered question')
    # A clicked answer keeps its text until the watcher has posted it publicly; it clears the text afterwards.
    unposted=row['answer_source']=='component' and row['announced_at'] is None
    write(db,a.id,'done','answered',question='',**({} if unposted else {'answer_text':None}));row=db.execute('SELECT * FROM questions WHERE id=?',(a.id,)).fetchone()
   elif a.cmd=='withdraw':
    # A sent question that no longer matters (policy changed, answered elsewhere) would otherwise stay pending forever.
    if row['status']!='awaiting_answer':raise ValueError('can only withdraw a sent, unanswered question; use cancel for unsent ones')
    write(db,a.id,'cancelled','awaiting_answer',question='',answer_text=None);row=db.execute('SELECT * FROM questions WHERE id=?',(a.id,)).fetchone()
   elif a.cmd=='cancel':
    if row['status'] not in ('queued','send_failed'):raise ValueError('can only cancel a question known not to have been sent')
    write(db,a.id,'cancelled',row['status'],question='',answer_text=None);row=db.execute('SELECT * FROM questions WHERE id=?',(a.id,)).fetchone()
   if a.cmd=='show':print(detail(row,a.offset));return 0
   result=event(row)
  text=json.dumps(result,ensure_ascii=False)
  if isinstance(result,dict) and len(text.encode())>45000:
   print(detail(db.execute('SELECT * FROM questions WHERE id=?',(result['id'],)).fetchone(),0))
  else:print(text)
  return 1 if isinstance(result,dict) and result.get('status') in ('send_failed','delivery_unknown','sending') else 0
 finally:db.close()

if __name__=='__main__':
 try:sys.exit(main())
 except (OSError,ValueError,sqlite3.Error,DiscordError) as e:print(('QUESTION_ERROR '+str(e)).replace('\n',' ')[:1000],file=sys.stderr);sys.exit(1)
