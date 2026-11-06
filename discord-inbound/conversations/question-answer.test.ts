import {expect,test} from "bun:test";
import {Database} from "bun:sqlite";
import {existsSync,mkdtempSync,rmSync,chmodSync,symlinkSync} from "node:fs";
import {homedir,tmpdir} from "node:os";
import {join} from "node:path";
import {recordAnswer} from "./question-answer.ts";
import {authorizationMetadata} from "../intake/authorization.ts";
import {Delivery} from "../delivery/delivery.ts";
const maintainedHelper=join(import.meta.dir, "../../scripts/helio-questions.py");
const helper=existsSync(maintainedHelper)?maintainedHelper:join(homedir(),"helio-agent/scripts/helio-questions.py");
function fixture(audience="owner",recipient="99") {
 const dir=mkdtempSync(join(tmpdir(),"question-answer-")),path=join(dir,"discord-questions.sqlite");
 const db=new Database(path);chmodSync(path,0o600);
 db.exec(`CREATE TABLE questions(id TEXT PRIMARY KEY,recipient TEXT,audience TEXT,status TEXT,answer_id TEXT,channel_id TEXT,message_id TEXT,answer_author TEXT,answer_role TEXT,answer_scope TEXT,answer_text TEXT,updated INTEGER)`);
 db.query("INSERT INTO questions (id,recipient,audience,status,channel_id,message_id,updated) VALUES (?,?,?,?,?,?,?)").run("q1",recipient,audience,"awaiting_answer","200","300",Date.now());
 return {dir,db};
}
const answer={message_id:"400",channel_id:"200",author_id:"99",role:"OWNER_REQUEST",scope:"may-request-work",content:"choose one",reply_to:"300"};
test("records the owner reply exactly once and retains top-level authority",()=>{
 const f=fixture();try{
  expect(recordAnswer(f.dir,"99",answer)).toBe("q1");expect(recordAnswer(f.dir,"99",answer)).toBe("q1");
  const row=f.db.query("SELECT status,answer_id,answer_author,answer_role,answer_text FROM questions").get();
  expect(row).toEqual({status:"answered",answer_id:"400",answer_author:"99",answer_role:"OWNER_REQUEST",answer_text:"choose one"});
  expect(recordAnswer(f.dir,"99",{...answer,message_id:"401",content:"later"})).toBeUndefined();
 }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true})}
});
test("does not accept the wrong sender, channel, parent or bot",()=>{
 const f=fixture();try{
  for(const change of [{author_id:"77"},{channel_id:"201"},{reply_to:"301"},{role:"BOT_BUG_REPORT"}]) expect(recordAnswer(f.dir,"99",{...answer,...change})).toBeUndefined();
  expect((f.db.query("SELECT status FROM questions").get() as any).status).toBe("awaiting_answer");
 }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true})}
});
test("thread questions accept their named requester or owner",()=>{
 const f=fixture("thread","77");try{
  expect(recordAnswer(f.dir,"99",{...answer,author_id:"78",role:"STAFF_QUESTION"})).toBeUndefined();
  expect(recordAnswer(f.dir,"99",{...answer,author_id:"77",role:"STAFF_QUESTION",scope:"may-report-issue"})).toBe("q1");
 }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true})}
});
test("refuses a symlinked question database",()=>{
 const f=fixture();f.db.close();const path=join(f.dir,"discord-questions.sqlite"),moved=join(f.dir,"real.sqlite");
 const fs=require("node:fs");fs.renameSync(path,moved);symlinkSync(moved,path);
 try{expect(()=>recordAnswer(f.dir,"99",answer)).toThrow("unsafe")}
 finally{rmSync(f.dir,{recursive:true,force:true})}
});


test("Python question sender, Discord answer and worker watcher round-trip",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"question-roundtrip-"));
 const env={...process.env,DORI_STATE_DIR:dir,DORI_DISCORD_OWNER_ID:"99",DORI_DISCORD_TOKEN:"fake",DORI_DISCORD_ALLOWED:"100"};
 const code=`import json,runpy,sys
m=runpy.run_path(sys.argv[1]);g=m["create_question"].__globals__
def fake(method,path,body=None):
 return {"id":"200"} if path=="/users/@me/channels" else {"id":"300"}
g["request"]=fake;db=m["db_connect"]();print(json.dumps(m["create_question"](db,"lane-one","owner","","Which fixture?")));db.close()`;
 const spawn=(argv:string[])=>Bun.spawn(argv,{env,stdout:"pipe",stderr:"pipe"});
 const created=spawn(["python3","-c",code,helper]);const createdOut=await new Response(created.stdout).text();const createdErr=await new Response(created.stderr).text();
 expect({code:await created.exited,err:createdErr}).toEqual({code:0,err:""});const q=JSON.parse(createdOut);
 const monitor=spawn(["python3",helper,"watch","--lane","lane-one"]);const reader=monitor.stdout.getReader();let buffer="";
 const waitFor=async (text:string)=>{while(!buffer.includes(text)){const next=await Promise.race([reader.read(),Bun.sleep(7000).then(()=>{throw Error("question watcher timed out")})]);if(next.done)throw Error("question watcher exited");buffer+=new TextDecoder().decode(next.value)}};
 try {
  await waitFor("QUESTION_PENDING");
  expect(recordAnswer(dir,"99",{message_id:"400",channel_id:"200",author_id:"99",role:"OWNER_REQUEST",scope:"may-request-work",content:"Use the beta fixture",reply_to:"300"})).toBe(q.id);
  await waitFor("QUESTION_ANSWERED");expect(buffer).toContain("Use the beta fixture");
  const ack=spawn(["python3",helper,"ack",q.id]);const ackText=await new Response(ack.stdout).text();expect(await ack.exited).toBe(0);expect(JSON.parse(ackText).status).toBe("done");
 }finally{monitor.kill();await monitor.exited;reader.releaseLock();rmSync(dir,{recursive:true,force:true})}
},12000);

test.each([
 {name:"trusted human",trusted:"100",ping:false,bot:false,status:"answered"},
 {name:"normal explicit ping",trusted:"",ping:true,bot:false,status:"answered"},
 {name:"normal non-ping",trusted:"",ping:false,bot:false,status:"awaiting_answer"},
 {name:"bot with ping",trusted:"100",ping:true,bot:true,status:"awaiting_answer"},
])("maintained Python reconciler reauthorizes persisted Discord origin: $name",async({trusted,ping,bot,status})=>{
 const dir=mkdtempSync(join(tmpdir(),"question-reconcile-"));
 const env={...process.env,PYTHONDONTWRITEBYTECODE:"1",DORI_STATE_DIR:dir,DORI_DISCORD_OWNER_ID:"99",DORI_DISCORD_TOKEN:"fake",DORI_DISCORD_ALLOWED:"100",
  DORI_DISCORD_TRUSTED_CHANNELS:trusted,DORI_DISCORD_NORMAL_CHANNELS:"",DORI_DISCORD_TRUSTED_IDS:"",DORI_DISCORD_REPORT_CHANNELS:""};
 const sentAt="2026-11-03T12:00:00Z";
 const message={id:"400",type:19,channel_id:"200",guild_id:"900",author:{id:"77",username:"human",bot},
  content:ping?"<@88> choose one":"choose one",mentions:ping?[{id:"88"}]:[],timestamp:sentAt,message_reference:{message_id:"300"}};
 const delivery=new Delivery(join(dir,"discord-delivery.sqlite"));
 try {
  delivery.stage("inbound","400",JSON.stringify({
   message_id:"400",channel_id:"200",author_id:"77",reply_to:"300",role:"TRUSTED_REQUEST",scope:"trusted-pr-merge-restart",
   content:message.content,sent_at:sentAt,preparation_complete:true,discord_origin:authorizationMetadata(message),
  }));
  const code=`import json,runpy,sys
m=runpy.run_path(sys.argv[1]);g=m["reconcile_pending"].__globals__;g["time"].time=lambda:1793707200
def fake(method,path,body=None):
 if path=="/users/@me":return {"id":"88"}
 if path=="/channels/200":return {"id":"200","type":11,"guild_id":"900","parent_id":"100"}
 if path=="/channels/100":return {"id":"100","type":0,"guild_id":"900"}
 raise AssertionError(path)
g["request"]=fake;db=m["db_connect"]()
db.execute("INSERT INTO questions(id,fingerprint,lane,audience,recipient,question,status,channel_id,message_id,updated) VALUES ('q1','fp','lane-one','thread','77','Question?','awaiting_answer','200','300',1793707200000)");db.commit()
m["reconcile_pending"](db);print(json.dumps(m["event"](db.execute("SELECT * FROM questions").fetchone())));db.close()`;
  const child=Bun.spawn(["python3","-c",code,helper],{env,stdout:"pipe",stderr:"pipe"});
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect({exit,stderr}).toEqual({exit:0,stderr:""});
  const result=JSON.parse(stdout);
  expect(result.status).toBe(status);
  if(status==="answered")expect({role:result.answer_role,scope:result.answer_scope,text:result.answer_text})
   .toEqual({role:"STAFF_QUESTION",scope:"answer-only",text:message.content});
 }finally{delivery.close();rmSync(dir,{recursive:true,force:true})}
});

test("staff questions accept the owner or a currently trusted user, never other staff",()=>{
 const f=fixture("staff","1218071208197623880");try{
  expect(recordAnswer(f.dir,"99",{...answer,author_id:"78",role:"STAFF_QUESTION"})).toBeUndefined();
  expect(recordAnswer(f.dir,"99",{...answer,author_id:"77",role:"TRUSTED_REQUEST"})).toBe("q1");
  expect((f.db.query("SELECT answer_author FROM questions").get() as any).answer_author).toBe("77");
 }finally{f.db.close();rmSync(f.dir,{recursive:true,force:true})}
});
