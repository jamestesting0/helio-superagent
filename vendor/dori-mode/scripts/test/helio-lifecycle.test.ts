import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchLane } from "../src/launch.ts";
import { Registry } from "../src/registry.ts";
import { defaultConfig } from "../src/config.ts";
import { run } from "../src/run.ts";

test("isolated lanes preserve input brief and recover failed pane launch", async () => {
 const dir=mkdtempSync(join(tmpdir(),"helio-launch-")); const repo=join(dir,"repo"), state=join(dir,"state"); mkdirSync(repo);
 const git=async (...args: string[]) => { const r=await run(["git","-C",repo,...args]); if(r.code) throw Error(r.err); };
 const old=process.env.HELIO_WORKTREES, oldBeta=process.env.HELIO_BETA_ENV; process.env.HELIO_WORKTREES="1";
 const betaEnv=join(dir,"beta.env"); writeFileSync(betaEnv,"BETA_TEST=1\n",{mode:0o600}); process.env.HELIO_BETA_ENV=betaEnv;
 try {
  await git("init"); await git("config","user.email","test@example.invalid"); await git("config","user.name","Test");
  writeFileSync(join(repo,"file"),"base"); await git("add","file"); await git("commit","-m","base");
  mkdirSync(join(repo,".omo")); writeFileSync(join(repo,".omo","omo.jsonc"),"{\"memory\":true}");
  const brief=join(dir,"brief.md"); writeFileSync(brief,"original brief\n");
  const calls:string[][]=[]; const registry=new Registry(state);
  const deps:any={registry,clock:{now:()=>0,sleep:async()=>{}},config:{...defaultConfig(dir),stateDir:state,defaultCwd:repo},run:async(argv:string[])=>{
   calls.push([...argv]); if(argv[0]==="git") return run(argv);
   if(argv.slice(0,3).join(" ")==="herdr tab create") return {code:0,out:JSON.stringify({result:{root_pane:{pane_id:"pane"},tab_id:"tab"}}),err:""};
   if(argv.slice(0,3).join(" ")==="herdr pane run") return {code:1,out:"",err:"simulated failure"};
   return {code:0,out:"",err:""};
  }};
  await expect(launchLane(deps,{key:"lane-one",title:"test",brief,done:"closed owner/repo#1"})).rejects.toThrow("pane run failed");
  const lane=await registry.read("lane-one"); expect(lane?.launchState).toBe("failed"); expect(lane?.status).toBe("not-done"); expect(lane?.pane).toBe("pane");
  expect(lane?.cwd).toBe(join(state,"worktrees","lane-one")); expect(readFileSync(brief,"utf8")).toBe("original brief\n");
  expect(readFileSync(lane!.brief,"utf8")).toContain("## Lane footer");
  expect(readFileSync(join(lane!.cwd!,".omo","omo.jsonc"),"utf8")).toBe("{\"memory\":true}");
  expect(readlinkSync(join(lane!.cwd!,".env"))).toBe(betaEnv);
  expect(calls.some(x=>x[0]==="git" && x.includes("add"))).toBe(true);
  chmodSync(betaEnv,0o644);
  await expect(launchLane(deps,{key:"lane-two",title:"insecure",brief,done:"closed owner/repo#1"})).rejects.toThrow("owner-only regular file");
  await expect(launchLane(deps,{key:"lane-one",title:"retry",brief,done:"closed owner/repo#1"})).rejects.toThrow("already registered");
 } finally { if(old===undefined) delete process.env.HELIO_WORKTREES; else process.env.HELIO_WORKTREES=old; if(oldBeta===undefined) delete process.env.HELIO_BETA_ENV; else process.env.HELIO_BETA_ENV=oldBeta; rmSync(dir,{recursive:true,force:true}); }
});

test("stale registry writers cannot overwrite newer lane changes", async () => {
 const dir=mkdtempSync(join(tmpdir(),"helio-registry-")); const registry=new Registry(dir);
 try {
  const lane:any={key:"lane-one",title:"test",thread:"none",brief:"/b",done:"closed a/b#1",openedAt:"2026-01-01"};
  await registry.write(lane); const a=(await registry.read(lane.key))!, b=(await registry.read(lane.key))!;
  await registry.write({...a,status:"paused"}); await expect(registry.write({...b,status:"closed"})).rejects.toThrow("changed concurrently");
  expect((await registry.read(lane.key))?.status).toBe("paused");
 } finally {rmSync(dir,{recursive:true,force:true});}
});
