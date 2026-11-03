import { expect, test } from "bun:test";
import { unpushedWork } from "../src/done-flow.ts";

test("missing lane worktree blocks closure rather than being treated as clean", async () => {
 const lane:any={key:"lane-one",worktrees:["/missing/lane"],cwd:"/missing/lane",done:"closed a/b#1"};
 const deps:any={config:{defaultCwd:"/repo"},exists:()=>false,run:async()=>({code:1,out:"",err:"unavailable"})};
 expect(await unpushedWork(deps,lane)).toEqual(["worktree missing: /missing/lane; inspect before closing"]);
});
