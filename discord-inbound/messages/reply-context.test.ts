import { expect, test } from "bun:test";
import { replyContext, type ReplyMessage } from "./reply-context.ts";
const root={id:"30",channel_id:"100",guild_id:"300",message_reference:{message_id:"20",channel_id:"100",guild_id:"300"}};
const original:ReplyMessage={id:"10",channel_id:"100",guild_id:"300",content:"Run the Final test",author:{id:"99",username:"owner"}};
const bot:ReplyMessage={id:"20",channel_id:"100",guild_id:"300",content:"Final test blocked: no browser",author:{id:"88",username:"Helio",bot:true},message_reference:{message_id:"10",channel_id:"100",guild_id:"300"}};
test("traces the bot reply and original request chronologically",async()=>{
 const calls:string[]=[];const result=await replyContext(root,async(channel,id)=>{calls.push(`${channel}/${id}`);return id==="20"?bot:{...original,member:{nick:"Server owner"}}},"/unused-without-attachments");
 expect(calls).toEqual(["100/20","100/10"]);expect(result?.status).toBe("complete");
 expect(result?.messages.map(m=>[m.message_id,m.content,m.bot])).toEqual([["10","Run the Final test",false],["20","Final test blocked: no browser",true]]);
 expect(result?.messages[0]?.author).toBe("Server owner");
});
test("never follows cross-channel, cross-guild, or forwarded sources",async()=>{
 let calls=0;const f=async()=>{calls++;return bot};
 expect((await replyContext({...root,message_reference:{message_id:"20",channel_id:"999"}},f,"/unused-without-attachments"))?.status).toBe("outside_channel");
 expect((await replyContext({...root,message_reference:{message_id:"20",guild_id:"999"}},f,"/unused-without-attachments"))?.status).toBe("outside_channel");
 expect(await replyContext({...root,message_reference:{type:1,message_id:"20",channel_id:"999"}},f,"/unused-without-attachments")).toBeUndefined();expect(calls).toBe(0);
});
test("denied, cyclic and mismatched responses report incomplete context",async()=>{
 expect((await replyContext(root,async()=>{throw Error("denied")},"/unused-without-attachments"))?.status).toBe("unavailable");
 expect((await replyContext(root,async()=>({...bot,message_reference:{message_id:"30"}}),"/unused-without-attachments"))?.status).toBe("cycle");
 expect((await replyContext(root,async()=>({...bot,channel_id:"999"}),"/unused-without-attachments"))?.status).toBe("invalid_response");
});
test("bounds chain length and strips links from historical text",async()=>{
 const start={id:"1000",channel_id:"100",message_reference:{message_id:"1"}};
 const out=await replyContext(start,async(_channel,id)=>({id,channel_id:"100",content:"hello https://example.com",author:{id:"77",username:"staff"},message_reference:{message_id:String(Number(id)+1)}}),"/unused-without-attachments");
 expect(out?.status).toBe("depth_limit");expect(out?.messages).toHaveLength(12);expect(out?.messages[0].content).toBe("hello [link omitted]");
});

test("earlier bot messages contribute their embed and component text within the character budget", async () => {
  const { replyContext: walk } = await import("./reply-context.ts");
  const context = await walk({ id: "3", channel_id: "100", message_reference: { message_id: "2" } }, async () => ({
    id: "2", channel_id: "100", author: { id: "55", username: "Elo Bot", bot: true }, content: "",
    embeds: [{ title: "Reveal Opponent", description: "Your opponent is <@77>" }],
    components: [{ type: 1, components: [{ type: 2, label: "Report Bug" }] }],
    mentions: [{ id: "77", username: "rival" }],
  }), "/unused-without-attachments");
  expect(context?.status).toBe("complete");
  expect(context?.messages[0]).toMatchObject({
    message_id: "2", bot: true, content: "", embed_text: ["Reveal Opponent", "Your opponent is <@77>"],
    component_text: ["[button: Report Bug]"], mentioned_users: { "77": "rival" },
  });
});
