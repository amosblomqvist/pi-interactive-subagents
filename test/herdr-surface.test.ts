import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as surfaces from "../pi-extension/subagents/surface.ts";

// PATH contains only these fixtures: a missing fixture can never reach the real host.
test("Herdr surface contract through isolated CLI fixtures", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "herdr-surface-test-"));
  const saved = { ...process.env };
  const stateFile = join(root, "state.json");
  const log = join(root, "calls.jsonl");
  const fixture = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2), file = process.env.FIXTURE_STATE;
const s = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify([process.argv[1].split('/').pop(), ...args])+'\\n');
const save = () => fs.writeFileSync(file, JSON.stringify(s));
const out = v => console.log(JSON.stringify(v));
const fail = n => { console.error(JSON.stringify({error:{kind:n===3?'not_found':'fixture_failure',message:'PRIVATE_SCREEN'}}));process.exit(n); };
if (process.argv[1].endsWith('herdr-app')) {
  if (args.join(' ') !== 'ls') fail(1);
  if (s.deferBootstrap && s.mailbox && fs.readdirSync(s.mailbox).some(n=>n.endsWith('.json'))) fail(1);
  const terminals = [{terminal:'t1',pane:'p1',sub_agents:['t2']}];
  if (s.child && !s.noAdopt) terminals.push({terminal:'t9',pane:'p9',sub_agents:[]});
  out([{id:'space1',machine:s.remote?'remote':null,tabs:[{id:'tab1',terminals},{id:'tab2',terminals:s.override&&s.child?[{terminal:'t9',pane:'p9'}]:[]}]}]);
} else if (args[0] === 'get') {
  if (s.getFail) fail(1);
  if (args[1] === 't1' || args[1] === 't2') { if(s.missingParent) fail(3);out({address:args[1],state:'live',pid:111}); }
  else { if(!s.child) fail(3);
    if(s.deferBootstrap && s.mailbox && fs.existsSync(s.mailbox)) for(const n of fs.readdirSync(s.mailbox).filter(n=>n.endsWith('.json'))) {
      const id=n.slice(0,-5);fs.writeFileSync(s.mailbox+'/'+id+'.ack',JSON.stringify({id,status:'accepted'}));
    }
    out({...s.child, labels:s.foreign?{}:s.child.labels}); }
} else if(args[0] === 'run') {
  const labels = {};args.forEach((v,i)=>{if(v==='--label'){const [k,...rest]=args[i+1].split('=');labels[k]=rest.join('=');}});
  s.child = {address:'t9',parent:args[args.indexOf('--parent')+1],labels,state:s.finished?'finished':'live',exit_code:s.finished?7:null,pid:424242};
  if(s.deferBootstrap) {s.mailbox=args.find(a=>a.startsWith('PI_SUBAGENT_IPC_DIR=')).split('=').slice(1).join('=');fs.writeFileSync(s.mailbox+'/ready',JSON.stringify({mode:'tui'}));}
  save();
  if(s.launchFail) fail(1);
  if(s.malformed) console.log('broken PRIVATE_SCREEN'); else out({address:'t9',parent:s.child.parent,state:s.child.state});
} else if(args[0] === 'ls') out(s.arrayList ? (s.child?[s.child]:[]) : {terminals:s.child?[s.child]:[]});
else if(args[0] === 'kill') {if(!s.child)fail(3);s.child.state='finished';save();out({});}
else if(args[0] === 'rm') {delete s.child;save();out({});}
else if(args[0] === 'read') console.log('__SUBAGENT_DONE_0__');
else fail(1);
`;
  for (const name of ["hc", "herdr-app"]) writeFileSync(join(root, name), fixture, { mode: 0o755 });
  process.env.PATH = root;
  process.env.FIXTURE_STATE = stateFile; process.env.FIXTURE_LOG = log;
  const reset = (state: any = {}) => {
    writeFileSync(stateFile, JSON.stringify(state)); writeFileSync(log, "");
    process.env.PI_SUBAGENT_SURFACE_BACKEND = "herdr"; process.env.HC_TERMINAL_ID = "t1";
    delete process.env.PI_SUBAGENT_HERDR_TAB;
  };
  const calls = (): string[][] => readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x));
  const launch = (surface: string) => surfaces.sendLongCommand(surface, "true", { scriptPath: join(root, "launch.sh"), interactive: { messages: [] } });
  const mailbox = () => readdirSync(root).map(n => join(root,n)).find(n => n.includes("ipc-"))!;
  try {
    await t.test("default isolation and unknown backend", () => {
      reset(); delete process.env.PI_SUBAGENT_SURFACE_BACKEND;
      const s = surfaces.createSurface("default", { surfaceBackend: "process" }); surfaces.closeSurface(s); assert.deepEqual(calls(), []);
      process.env.PI_SUBAGENT_SURFACE_BACKEND = "typo";
      assert.throws(() => surfaces.createSurface("bad"), /backend/i);
    });
    await t.test("reject missing parent, missing target and remote without launching", () => {
      for (const mode of ["noenv", "missingParent", "target", "remote"]) {
        reset({ [mode]: true });
        if(mode === "noenv") delete process.env.HC_TERMINAL_ID;
        if(mode === "target") process.env.PI_SUBAGENT_HERDR_TAB = "invented";
        assert.throws(() => surfaces.createSurface("bad"), /parent|target|tab|local|remote|HC_TERMINAL_ID/i);
        assert.ok(!calls().some(c=>c[1]==="run"));
      }
    });
    await t.test("native launch, captured backend, ownership, readiness, safe read and idempotent cleanup", async () => {
      reset(); process.env.HC_TERMINAL_ID = "t2";
      const s = surfaces.createSurface("worker label");
      delete process.env.PI_SUBAGENT_SURFACE_BACKEND;
      try {
        launch(s);
        assert.equal(surfaces.getSurfaceTerminalAddress(s), "t9");
        assert.equal(surfaces.getSurfaceProcessId(s), 424242);
        const argv = calls().find(c=>c[1]==="run")!;
        assert.ok(argv.includes("--no-notify") && argv.includes("--bg") && argv.includes("--json"));
        assert.equal(argv[argv.indexOf("--parent")+1], "t2");
        assert.ok(argv.includes("herdr.space=space1") && argv.includes("herdr.tab=tab1"));
        assert.ok(argv.some(x=>x.startsWith("pi.subagent.surface=")));
        assert.ok(argv.includes("PI_SUBAGENT_SURFACE_BACKEND=herdr"));
        assert.ok(!argv.includes("script") && !argv.includes("--mode") && !argv.some(x=>x.startsWith("FIXTURE_STATE=")));
        writeFileSync(join(mailbox(), "ready"), JSON.stringify({mode:"tui"}));
        await surfaces.waitSurfaceReady(s, {timeoutMs:1000});
        surfaces.readScreen(s, 500);
        assert.deepEqual(calls().find(c=>c[1]==="read")?.slice(2), ["--lines", "0", "t9"]);
      } finally { surfaces.closeSurface(s); surfaces.closeSurface(s); }
      assert.equal(calls().filter(c=>c[1]==="kill").length, 1);
      assert.equal(calls().filter(c=>c[1]==="rm").length, 1);
      assert.ok(!existsSync(mailbox() || join(root,"absent")));
    });
    await t.test("native exit uses metadata, never sentinel or screen", async () => {
      reset({finished:true});const s=surfaces.createSurface("exit");
      try { launch(s); const result=await surfaces.pollForExit(s,new AbortController().signal,{interval:10});assert.equal(result.exitCode,7);assert.ok(!calls().some(c=>c[1]==="read"));await assert.rejects(surfaces.waitSurfaceReady(s,{timeoutMs:100}),/closed|finished/); }
      finally {surfaces.closeSurface(s);}
    });
    await t.test("malformed/failed launch cleans uniquely owned orphan and mailbox without retry", () => {
      for(const mode of ["malformed","launchFail"]){reset({[mode]:true});const s=surfaces.createSurface("failed");
        assert.throws(()=>launch(s), /Herdr|herdr/); surfaces.closeSurface(s);
        assert.equal(calls().filter(c=>c[1]==="run").length,1);assert.equal(calls().filter(c=>c[1]==="rm").length,1);
        assert.ok(!mailbox());
      }
    });
    await t.test("get failure and ownership mismatch cannot succeed or kill somebody else", async () => {
      reset();const s=surfaces.createSurface("ownership");launch(s);
      const original=JSON.parse(readFileSync(stateFile,"utf8"));
      try {
        writeFileSync(stateFile,JSON.stringify({...original,getFail:true}));
        const result=await surfaces.pollForExit(s,new AbortController().signal,{interval:10});assert.equal(result.reason,"error");assert.ok(!result.errorMessage?.includes("PRIVATE_SCREEN"));
        writeFileSync(stateFile,JSON.stringify({...original,foreign:true}));
        assert.throws(()=>surfaces.closeSurface(s),/ownership/i);assert.ok(!calls().some(c=>c[1]==="kill"));
      } finally {writeFileSync(stateFile,JSON.stringify(original));surfaces.closeSurface(s);}
    });
    await t.test("existing override and bounded adoption deadline", async () => {
      reset({override:true,noAdopt:true});process.env.PI_SUBAGENT_HERDR_TAB="tab2";
      const s=surfaces.createSurface("override");try{launch(s);writeFileSync(join(mailbox(),"ready"),'{"mode":"tui"}');await surfaces.waitSurfaceReady(s,{timeoutMs:1000});assert.ok(calls().find(c=>c[1]==="run")?.includes("herdr.tab=tab2"));}finally{surfaces.closeSurface(s);}
      reset({noAdopt:true});const hidden=surfaces.createSurface("hidden");try{launch(hidden);writeFileSync(join(mailbox(),"ready"),'{"mode":"tui"}');await assert.rejects(surfaces.waitSurfaceReady(hidden,{timeoutMs:120}),/adopt|pane/i);}finally{surfaces.closeSurface(hidden);}
    });
    await t.test("bootstrap is deferred until ready and native pane adoption", async () => {
      reset({deferBootstrap:true});const s=surfaces.createSurface("deferred bootstrap");
      try {
        surfaces.sendLongCommand(s,"true",{scriptPath:join(root,"launch.sh"),interactive:{messages:[{message:"fast task",deliverAs:"followUp"}]}});
        assert.deepEqual(readdirSync(mailbox()).filter(n=>n.endsWith('.json')),[],"task must not start before pane adoption");
        await surfaces.waitSurfaceReady(s,{timeoutMs:1500});
        assert.equal(readdirSync(mailbox()).filter(n=>n.endsWith('.ack')).length,1);
        assert.equal(readdirSync(mailbox()).filter(n=>n.endsWith('.json')).length,1);
      } finally {surfaces.closeSurface(s);}
    });
    await t.test("alphanumeric local parent/child IDs and array list cleanup", () => {
      const alphaFixture = fixture.replaceAll("t1", "t1r").replaceAll("t9", "t2a");
      for (const name of ["hc", "herdr-app"]) writeFileSync(join(root, name), alphaFixture, {mode:0o755});
      try {
        reset(); process.env.HC_TERMINAL_ID = "t1r";
        const s = surfaces.createSurface("alpha");
        try { launch(s); assert.equal(surfaces.getSurfaceTerminalAddress(s), "t2a"); assert.equal(surfaces.getSurfaceProcessId(s),424242); }
        finally { surfaces.closeSurface(s); }
        reset({launchFail:true,arrayList:true}); process.env.HC_TERMINAL_ID = "t1r";
        const failed = surfaces.createSurface("alpha failed");
        try { assert.throws(()=>launch(failed), /Herdr/); assert.equal(calls().filter(c=>c[1]==="rm").length,1); }
        finally { surfaces.closeSurface(failed); }
      } finally {
        for (const name of ["hc", "herdr-app"]) writeFileSync(join(root, name), fixture, {mode:0o755});
      }
    });
  } finally {
    for(const key of Object.keys(process.env)) if(!(key in saved)) delete process.env[key];
    Object.assign(process.env,saved);rmSync(root,{recursive:true,force:true});
  }
});
