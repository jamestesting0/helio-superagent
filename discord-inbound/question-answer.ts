import { Database } from "bun:sqlite";
import { existsSync, lstatSync } from "node:fs";
import { join } from "node:path";

export type Answer = { message_id: string; channel_id: string; author_id: string; role: string; scope: string; content: string; reply_to?: string };

/** Match only direct replies in the destination channel from the expected person or owner. */
export function recordAnswer(stateDir: string, owner: string, inbound: Answer): string | undefined {
 if (!inbound.reply_to || inbound.role === "BOT_BUG_REPORT") return;
 const path=join(stateDir,"discord-questions.sqlite");
 if (!existsSync(path)) return;
 const st=lstatSync(path);
 if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)!==0) throw Error("unsafe question database");
 const db=new Database(path,{create:false});
 try {
  db.exec("PRAGMA busy_timeout=10000");
  const tx=db.transaction(() => {
   const row=db.query<{id:string;recipient:string;audience:string;status:string;answer_id:string|null},[string,string]>(
    "SELECT id,recipient,audience,status,answer_id FROM questions WHERE channel_id=? AND message_id=? AND status IN ('awaiting_answer','answered')"
   ).get(inbound.channel_id,inbound.reply_to!);
   if (!row) return;
   if (row.status==="answered") return row.answer_id===inbound.message_id ? row.id : undefined;
   // Staff questions accept the owner or anyone trusted when they answer (role is decided from the current trusted list).
   const allowed = inbound.author_id===owner || (row.audience==="staff" ? inbound.role==="TRUSTED_REQUEST" :
     row.audience==="thread" && inbound.author_id===row.recipient);
   if (!allowed) return;
   db.query("UPDATE questions SET status='answered',answer_id=?,answer_author=?,answer_role=?,answer_scope=?,answer_text=?,updated=? WHERE id=? AND status='awaiting_answer'")
    .run(inbound.message_id,inbound.author_id,inbound.role,inbound.scope,inbound.content,Date.now(),row.id);
   return row.id;
  });
  return tx.immediate();
 } finally {db.close();}
}
