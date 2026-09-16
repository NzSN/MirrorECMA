import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileSha256, initProject, loadProject, parseProject, parseToolchainLock, checkProject, doctorProject,
  projectFailure, ProjectError, type ProjectDeclaration } from "../src/project.js";

let directory:string;
let project:ProjectDeclaration;
beforeEach(async()=>{
  directory=await mkdtemp(join(tmpdir(),"mirrorecma-project-"));
  await initProject(directory);
  project=JSON.parse(await readFile(join(directory,"mirror.project.json"),"utf8"));
  await writeFile(join(directory,"mirror.toolchain.json"),JSON.stringify({schema:"mirrorecma.toolchain/v1",tools:{
    server:{path:process.execPath,sha256:await fileSha256(process.execPath),version:process.version,capabilities:["model-interface-v1","checked-replay-v1"]},
  }}));
});
afterEach(async()=>{await rm(directory,{recursive:true,force:true});});
test("init seeds a complete strict project without overwriting edited input",async()=>{
  expect(parseProject(project).suiteId).toBe("example/v1");
  await writeFile(join(directory,"mirror.project.json"),"authored");
  expect(await initProject(directory)).toEqual([]);
  expect(await readFile(join(directory,"mirror.project.json"),"utf8")).toBe("authored");
});
test("project validation rejects unknown fields, empty corpus and invalid requirements",()=>{
  expect(()=>parseProject({...project,policy:{}})).toThrow(/unknown/);
  expect(()=>parseProject({...project,replay:{...project.replay,traces:[]}})).toThrow(/nonempty/);
  expect(()=>parseProject({...project,acceptance:{requiredPairs:[["A"]]}})).toThrow();
  expect(()=>parseProject({...project,execution:{...project.execution,timeouts:{actionMs:0}}})).toThrow(/positive/);
});
test("loader resolves paths against declaration and leaves adapter unimported",async()=>{
  await writeFile(join(directory,"adapter.mjs"),"throw new Error('must not import');");
  const p=await loadProject(join(directory,"mirror.project.json"));
  expect(p.declaration.model.source).toBe(join(directory,"model/Example.tla"));
  expect(p.replay.traces).toEqual([join(directory,"traces/witness.itf.json")]);
  expect(p.execution.mirror).toBe(process.execPath);
  expect(Object.isFrozen(p.replay.config)).toBe(true);
  expect(Object.isFrozen(p.declaration.model)).toBe(true);
});
test("incompatible override fails without falling through to a valid pin",async()=>{
  const fake=join(directory,"fake");await writeFile(fake,"#!/bin/sh\nexit 0\n");await chmod(fake,0o700);
  await expect(loadProject(join(directory,"mirror.project.json"),{tools:{server:fake}})).rejects.toMatchObject({code:"tool_identity_mismatch"});
});
test("prepared registry fallback supplies missing locked role, optional generation tools are not required for replay",async()=>{
  const identity={path:process.execPath,sha256:await fileSha256(process.execPath),version:process.version,capabilities:["model-interface-v1","checked-replay-v1"]};
  await writeFile(join(directory,"mirror.toolchain.json"),JSON.stringify({schema:"mirrorecma.toolchain/v1",tools:{apalache:{...identity,path:"/missing/apalache"}}}));
  await writeFile(join(directory,"registry.json"),JSON.stringify({schema:"mirrorecma.toolchain/v1",tools:{server:identity}}));
  const p=await loadProject(join(directory,"mirror.project.json"),{installedRegistry:join(directory,"registry.json")});
  expect(p.tools.server?.path).toBe(process.execPath);
  expect(p.tools.apalache).toBeUndefined();
});
test("remote loader records a deferred connector and does not reinterpret server paths",async()=>{
  const declaration={...project,execution:{mirror:{kind:"tcp",host:"127.0.0.1",port:1,serverIdentity:"approved-service",capabilities:["model-interface-v1","checked-replay-v1"]}},replay:{...project.replay,config:{...project.replay.config,specPath:"/server/private/Example.tla"},traces:[{path:"traces/witness.itf.json",sha256:"a".repeat(64),serverPath:"/server/private/witness.itf.json"}]}};
  await writeFile(join(directory,"mirror.project.json"),JSON.stringify(declaration));
  const p=await loadProject(join(directory,"mirror.project.json"));
  expect(typeof p.execution.mirror).toBe("function");
  expect(p.tools.server).toBeUndefined();
  expect(p.replay.config.specPath).toBe("/server/private/Example.tla");
  expect(p.replay.modelSource).toBe(join(directory,"model/Example.tla"));
  expect(()=>parseProject({...declaration,replay:project.replay})).toThrow(/serverPath/);
});
test("doctor keeps configuration, missing tools, namespace and audit evidence separate",async()=>{
  await writeFile(join(directory,"adapter.mjs"),"throw new Error('must not import');");
  const checks=await doctorProject(join(directory,"mirror.project.json"));
  expect(checks).toEqual(expect.arrayContaining([
    expect.objectContaining({check:"configuration",status:"passed"}),
    expect.objectContaining({check:"executable.compiler",status:"failed"}),
    expect.objectContaining({check:"executable.server",status:"passed"}),
    expect.objectContaining({check:"capabilities.server",status:"not_checked"}),
    expect.objectContaining({check:"namespace-admission",status:"not_checked"}),
    expect.objectContaining({check:"hosted-agent-audit",status:"not_checked"}),
  ]));
});
test("optional package pins verify installed metadata without executing the package",async()=>{
  const packageJson=join(directory,"installed-package.json");
  await writeFile(packageJson,JSON.stringify({name:"mirrorecma",version:"2.0.0",main:"./must-not-execute.mjs"}));
  await writeFile(join(directory,"must-not-execute.mjs"),"throw new Error('package must not execute');");
  const lock=JSON.parse(await readFile(join(directory,"mirror.toolchain.json"),"utf8"));
  lock.packages={mirrorecma:{packageJson:"installed-package.json",packageJsonSha256:await fileSha256(packageJson),version:"2.0.0"}};
  expect(parseToolchainLock(JSON.parse(JSON.stringify(lock)))).toEqual(lock);
  await writeFile(join(directory,"mirror.toolchain.json"),JSON.stringify(lock));
  const loaded=await loadProject(join(directory,"mirror.project.json"));
  expect(loaded.packages.mirrorecma?.packageJson).toBe(packageJson);
  expect(loaded.packageChecks).toEqual([{name:"mirrorecma",status:"passed"}]);
  const diagnosed=await doctorProject(join(directory,"mirror.project.json"));
  expect(diagnosed).toContainEqual(expect.objectContaining({check:"package.mirrorecma",status:"passed"}));
  await writeFile(packageJson,JSON.stringify({name:"mirrorecma",version:"2.0.1"}));
  await expect(loadProject(join(directory,"mirror.project.json"))).rejects.toMatchObject({code:"package_identity_mismatch"});
});
test("package role, identity and optional Gate runtime schemas stay distinct",()=>{
  const identity={path:"operator/gate",sha256:"a".repeat(64),version:"operator-reviewed",capabilities:[]};
  expect(parseToolchainLock({schema:"mirrorecma.toolchain/v1",tools:{gateRuntime:identity}}).tools.gateRuntime).toEqual(identity);
  expect(()=>parseToolchainLock({schema:"mirrorecma.toolchain/v1",tools:{},packages:{other:{}}})).toThrow(/unknown/);
  expect(()=>parseToolchainLock({schema:"mirrorecma.toolchain/v1",tools:{},packages:{mirrorecma:{packageJson:"package.json",version:"2",packageJsonSha256:"invalid"}}})).toThrow(/SHA-256/);
});
test("explicit incompatible override also fails for an already loaded project",async()=>{
  const lock=JSON.parse(await readFile(join(directory,"mirror.toolchain.json"),"utf8"));
  lock.tools.compiler={...lock.tools.server,capabilities:["bundle-v1","check-bundle-v1","preflight-v1"]};
  await writeFile(join(directory,"mirror.toolchain.json"),JSON.stringify(lock));
  const loaded=await loadProject(join(directory,"mirror.project.json"),{requiredTools:["compiler","server"]});
  const invalid=join(directory,"invalid-compiler");await writeFile(invalid,"#!/bin/sh\nexit 0\n");await chmod(invalid,0o700);
  await expect(checkProject(loaded,{tools:{compiler:invalid}})).rejects.toMatchObject({code:"tool_identity_mismatch"});
});
test("command diagnostics preserve operational stage and cancellation instead of calling every error configuration",()=>{
  expect(projectFailure(new Error("private unknown diagnostic"),"replay")).toEqual({outcome:"failed",failure:{stage:"replay",kind:"unknown",code:"project_operation_failed",message:"project operation failed"}});
  expect(projectFailure(new ProjectError("tool_timed_out","compiler expired"),"generation")).toMatchObject({outcome:"timedOut",failure:{stage:"generation",kind:"timeout"}});
  expect(projectFailure(new ProjectError("cancelled","cancelled"),"check")).toMatchObject({outcome:"cancelled",failure:{stage:"check",kind:"cancellation"}});
  expect(projectFailure(new ProjectError("tool_identity_mismatch","wrong compiler"),"check")).toMatchObject({failure:{stage:"toolchain",kind:"toolchain"}});
});
test("documented project and toolchain examples round-trip through the production parsers",async()=>{
  const guide=await readFile(new URL("../docs/project-tools.md",import.meta.url),"utf8");
  const examples=[...guide.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match=>JSON.parse(match[1]!));
  expect(examples).toHaveLength(2);
  expect(parseProject(JSON.parse(JSON.stringify(examples[0])))).toEqual(examples[0]);
  expect(parseToolchainLock(JSON.parse(JSON.stringify(examples[1])))).toEqual(examples[1]);
});
test.each(["timeout","cancel"] as const)("compiler %s joins the owned subprocess before returning",async mode=>{
  const executable=join(directory,"compiler"),pidFile=join(directory,"compiler.pid");
  await writeFile(executable,"#!/bin/sh\nprintf '%s' \"$$\" > compiler.pid\ntrap '' TERM\nwhile :; do :; done\n");
  await chmod(executable,0o700);
  const lock=JSON.parse(await readFile(join(directory,"mirror.toolchain.json"),"utf8"));
  lock.tools.compiler={path:executable,sha256:await fileSha256(executable),version:"test-only",capabilities:["bundle-v1","check-bundle-v1","preflight-v1"]};
  await writeFile(join(directory,"mirror.toolchain.json"),JSON.stringify(lock));
  const abort=new AbortController();
  const pending=checkProject(join(directory,"mirror.project.json"),{signal:abort.signal,commandTimeoutMs:mode==="timeout"?100:1000});
  const expectation=expect(pending).rejects.toMatchObject({code:mode==="timeout"?"tool_timed_out":"cancelled"});
  let pid:number|undefined;
  for(let attempt=0;attempt<100;attempt++){
    try{pid=Number(await readFile(pidFile,"utf8"));break;}catch{await new Promise(resolve=>setTimeout(resolve,5));}
  }
  expect(pid).toBeGreaterThan(0);
  if(mode==="cancel")abort.abort("test cancellation");
  await expectation;
  expect(()=>process.kill(pid!,0)).toThrow();
});
