import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  defineSuite, runSuite, runSuiteWithFactory, evaluateAcceptance, preflightSuite,
  decodeSemanticDescriptor, ReplayMismatchError,
  type NativeSuiteAdapter, type SuiteModel, type ReplayPlan, type SuiteEvidence, type Transport,
} from "../src/index.js";
import { CounterModelInterface, CounterPublicManifest, bindCounterAsyncPublicPort } from "./fixtures/model-interface/counter/generated-async/CounterMirror.generated.js";
const lock = JSON.parse(readFileSync(resolve("test/fixtures/model-interface/counter/Counter.mirror-interface.lock.json"),"utf8"));
const {contract:_c,semanticDigest:_s,provenance:_p,provenanceDigest:_pd,...fields} = lock;
const descriptor = decodeSemanticDescriptor({...fields,schema:"mirrors.model-interface-descriptor/v1"});
const model: SuiteModel = {
  schema:"mirrors.suite-model/v1",nativeRepresentation:"mirrors.node-native/v1",semanticDigest:lock.semanticDigest,
  targetProfile:"mirrorecma-async-v1",stateComputerContractVersion:"mirrors.async-state-computer/v1",
  metadata:CounterModelInterface,descriptor,publicManifest:CounterPublicManifest,
  bindPublicPort:bindCounterAsyncPublicPort,
  bindLocal:(port,config)=>bindCounterAsyncPublicPort({
    invoke:async(id,inputs,ctx)=>{await port.actions[id]!(inputs,ctx);},observe:async(ctx)=>port.observe(ctx),
  },config),
};
const replay: ReplayPlan = {kind:"corpus",config:{specPath:resolve("examples/generated-counter/specs/Counter.tla"),invariant:"TraceComplete",lengthBound:6,constInit:"CInit",paramVars:"parameters"},traces:[resolve("test/fixtures/model-interface/counter/counter.itf.json")]};
const makeSuite = (plan = replay, acceptance = {requiredActions:["Tick"],requiredPairs:[["Tick","Tick"] as const]})=>defineSuite({id:"counter",model,replay:plan,acceptance});
const matched = {proto_step:"spec_validated",result:"valid",modelInterface:{schema:"mirrors.model-interface-negotiation/v1",status:"matched",descriptorSchema:"mirrors.model-interface-descriptor/v1",semanticDigest:`sha256:${lock.semanticDigest}`}};
const init = {proto_step:"initial_state",action:"init",state:{count:{"#bigint":"0"}}};
const ack = {proto_step:"step_ok"};
const tick = (n:string)=>({proto_step:"next_step",action:"tick",parameters:{parameters:{stride:{"#bigint":n}}}});
const done = {proto_step:"all_steps_done"};
const success = [matched,init,ack,tick("2"),ack,tick("3"),ack,done];
class Script implements Transport {
  readonly sent:string[]=[]; closes=0;
  constructor(readonly messages:readonly unknown[]){}
  send(line:string){this.sent.push(line);}
  async close(){this.closes++;return 0;}
  async *[Symbol.asyncIterator](){for(const message of this.messages)yield JSON.stringify(message);}
}
function adapter(onDispose=()=>{}):{port:NativeSuiteAdapter;dispose:()=>void} {
  let count=0n;
  return {port:{actions:{Initialize:()=>{count=0n;},Tick:(input)=>{count+=input.Stride as bigint;}},observe:()=>({Count:count}),dispose:()=>{throw new Error("port.dispose must not be duck typed");}},dispose:onDispose};
}
const wait = (ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms));

test("definition snapshots inputs, rejects empty corpus and unknown/initializer requirements",()=>{
  const traces=[...replay.traces];const requirements={requiredActions:["Tick"]};
  const suite=defineSuite({id:"frozen",model,replay:{...replay,traces},acceptance:requirements});
  traces.splice(0);requirements.requiredActions[0]="Initialize";
  expect(suite.replay.traces).toHaveLength(1);expect(suite.acceptance.requiredActions).toEqual(["Tick"]);
  expect(Object.isFrozen(suite.model.descriptor.actions[0])).toBe(true);
  expect(()=>makeSuite({...replay,traces:[]})).toThrow("nonempty");
  expect(()=>makeSuite(replay,{requiredActions:["Initialize"],requiredPairs:[]})).toThrow("transition IDs");
  expect(()=>makeSuite(replay,{requiredActions:["missing"],requiredPairs:[]})).toThrow("transition IDs");
  expect(()=>defineSuite({id:"invalid",model:{...model,semanticDigest:"0".repeat(64)},replay})).toThrow("identity mismatch");
});
test("pure acceptance distinguishes exact absence from unavailable counters and requires full initialization",()=>{
  const evidence:SuiteEvidence={schema:"mirrorecma.suite-evidence/v1",enteredReplay:true,complete:true,exact:true,tracesExpected:1,tracesCompleted:1,initializationsMatched:"1",transitionsMatched:"0",actionCounts:{Tick:"0"},pairCounts:{}};
  expect(evaluateAcceptance({requiredActions:["Tick"]},evidence).status).toBe("unmet");
  expect(evaluateAcceptance({requiredActions:["Tick"]},{...evidence,actionCounts:{}}).status).toBe("incomplete");
  expect(evaluateAcceptance({},evidence).status).toBe("met");
  expect(evaluateAcceptance({},{...evidence,initializationsMatched:"0"}).status).toBe("incomplete");
  expect(evaluateAcceptance({},{...evidence,enteredReplay:false}).status).toBe("not_evaluated");
  expect(evaluateAcceptance({},{...evidence,complete:false}).status).toBe("incomplete");
});
test("successful runs count strict matched evidence and repeated runs have fresh counters/disposer",async()=>{
  let factories=0,disposals=0;
  const suite=makeSuite();
  for(let n=0;n<2;n++){
    const transport=new Script(success);
    const result=await runSuite(suite,{mirror:transport,implementation:()=>{factories++;expect(transport.sent).toHaveLength(1);return adapter(()=>disposals++);}});
    expect(result).toMatchObject({outcome:"passed",conformance:"matched",acceptance:{status:"met"},cleanup:{status:"succeeded",quiescence:"confirmed"},evidence:{initializationsMatched:"1",transitionsMatched:"2",actionCounts:{Tick:"2"},pairCounts:{'["Tick","Tick"]':"1"}}});
    expect(transport.closes).toBe(1);
  }
  expect(factories).toBe(2);expect(disposals).toBe(2);
});
test.each([
  ["missing final acknowledgement",[matched,init,ack,tick("2"),ack,tick("3"),done]],
  ["missing intermediate acknowledgement",[matched,init,tick("2"),ack,tick("3"),ack,done]],
  ["duplicate acknowledgement",[matched,init,ack,ack]],
  ["premature terminal",[matched,init,ack,done]],
  ["unknown action",[matched,{...init,action:"unknown"}]],
])("strict evidence rejects %s",async(_name,messages)=>{
  const result=await runSuite(makeSuite(),{mirror:new Script(messages as unknown[]),implementation:()=>adapter()});
  expect(result.outcome).toBe("failed");expect(result.failure?.kind).toBe("evidence");expect(result.acceptance.status).not.toBe("met");
});
test("mismatch retains only acknowledged prefix and zero-based coordinates",async()=>{
  const mismatch={proto_step:"step_mismatch",action:"tick",expected:{count:{"#bigint":"2"}},actual:{count:{"#bigint":"1"}}};
  const result=await runSuite(makeSuite(),{mirror:new Script([matched,init,ack,tick("2"),mismatch]),implementation:()=>adapter()});
  expect(result).toMatchObject({outcome:"mismatch",conformance:"mismatch",acceptance:{status:"incomplete"},failure:{traceIndex:0,stateIndex:1},evidence:{initializationsMatched:"1",transitionsMatched:"0"}});
});
test("one factory serves repeated traces and pair adjacency resets",async()=>{
  const directory=await mkdtemp(join(tmpdir(),"suite-pairs-"));
  try {
    const path=join(directory,"trace.json");const trace=JSON.parse(readFileSync(replay.traces[0] as string,"utf8"));trace.states.pop();await writeFile(path,JSON.stringify(trace));
    let factories=0;
    const result=await runSuite(makeSuite({...replay,traces:[path,path]}),{mirror:new Script([matched,init,ack,tick("2"),ack,init,ack,tick("2"),ack,done]),implementation:()=>{factories++;return adapter();}});
    expect(result).toMatchObject({outcome:"failed",conformance:"matched",acceptance:{status:"unmet",missingPairs:[["Tick","Tick"]]},failure:{kind:"acceptance",code:"coverage_unmet"},evidence:{initializationsMatched:"2",transitionsMatched:"2"}});
    expect(factories).toBe(1);
  }finally{await rm(directory,{recursive:true,force:true});}
});
test("denied negotiation and bad provenance never construct implementation",async()=>{
  let calls=0;
  const result=await runSuite(makeSuite(),{mirror:new Script([{...matched,modelInterface:{...matched.modelInterface,semanticDigest:`sha256:${"0".repeat(64)}`}}]),implementation:()=>{calls++;return adapter();}});
  expect(result).toMatchObject({outcome:"failed",conformance:"not_evaluated",acceptance:{status:"not_evaluated"}});expect(calls).toBe(0);
  const transport=new Script(success);
  const bad=makeSuite({...replay,traces:[{path:replay.traces[0] as string,sha256:"0".repeat(64)}]});
  expect((await runSuite(bad,{mirror:transport,implementation:()=>{calls++;return adapter();}})).failure?.kind).toBe("configuration");
  expect(transport.sent).toHaveLength(0);expect(calls).toBe(0);
});
test("late factory is disposed within independent cleanup budget without replay",async()=>{
  let disposal=0;const transport=new Script(success);
  const result=await runSuite(makeSuite(),{mirror:transport,timeouts:{actionMs:10,cleanupMs:100},implementation:async()=>{await wait(30);return adapter(()=>disposal++);}});
  expect(result).toMatchObject({outcome:"timedOut",conformance:"not_evaluated",cleanup:{status:"succeeded",quiescence:"confirmed"}});
  expect(disposal).toBe(1);expect(transport.sent).toHaveLength(1);
});
test("factory that never returns has bounded unconfirmed cleanup",async()=>{
  const start=performance.now();
  const result=await runSuite(makeSuite(),{mirror:new Script(success),timeouts:{actionMs:10,cleanupMs:20},implementation:()=>new Promise(()=>{})});
  expect(performance.now()-start).toBeLessThan(1000);expect(result).toMatchObject({outcome:"timedOut",cleanup:{status:"unconfirmed",quiescence:"unconfirmed"}});
});
test("staged partial allocation cleanup runs on factory rejection",async()=>{
  let disposal=0;
  const result=await runSuite(makeSuite(),{mirror:new Script(success),implementation:(context)=>{context.deferCleanup(()=>{disposal++;});throw new Error("allocation failed");}});
  expect(result.failure?.kind).toBe("implementation");expect(disposal).toBe(1);expect(result.cleanup.status).toBe("succeeded");
});
test("construction scope retains successful registrations and adopted disposer executes once",async()=>{
  const released:string[]=[];
  const result=await runSuite(makeSuite(),{mirror:new Script(success),implementation:context=>{
    context.deferCleanup(()=>{released.push("extra");});
    const dispose=context.deferCleanup(()=>{released.push("adopted");});
    return {...adapter(),dispose};
  }});
  expect(result.outcome).toBe("passed");expect(released).toEqual(["adopted","extra"]);
});
test("scope resources remain owned if bridge construction fails after handle return",async()=>{
  let scopeReleased=0,handleReleased=0;
  const suite=defineSuite({id:"bad-bridge",model:{...model,bindLocal:()=>{throw new Error("binding failed");}},replay});
  const result=await runSuite(suite,{mirror:new Script(success),implementation:context=>{
    context.deferCleanup(()=>{scopeReleased++;});
    return adapter(()=>{handleReleased++;});
  }});
  expect(result.outcome).toBe("failed");expect(result.cleanup.status).toBe("succeeded");
  expect(scopeReleased).toBe(1);expect(handleReleased).toBe(1);
});
test("preflight failure closes an owned direct transport but never invokes a deferred connector",async()=>{
  const bad=makeSuite({...replay,traces:[{path:replay.traces[0] as string,sha256:"0".repeat(64)}]});
  const direct=new Script(success);let connections=0;
  const result=await runSuite(bad,{mirror:direct,implementation:()=>adapter()});
  expect(direct.closes).toBe(1);expect(result.cleanup.bindingStatus).toBe("not_started");
  await runSuite(bad,{mirror:()=>{connections++;return new Script(success);},implementation:()=>adapter()});
  const abort=new AbortController();abort.abort();
  const cancelled=await runSuite(makeSuite(),{mirror:()=>{connections++;return new Script(success);},signal:abort.signal,implementation:()=>adapter()});
  expect(cancelled.outcome).toBe("cancelled");expect(connections).toBe(0);
});
test.each(["ready","iterator"])("early %s failure uses independent cleanup budget and retains unconfirmed quiescence",async(kind)=>{
  let closes=0,factories=0;
  const transport:Transport={send(){},close(){closes++;return new Promise(()=>{});},[Symbol.asyncIterator](){if(kind==="iterator")throw new Error("iterator failed");return {next:async()=>({done:true,value:undefined})};}};
  if(kind==="ready")Object.defineProperty(transport,"ready",{get(){throw new Error("connection failed");}});
  const started=performance.now();
  const result=await runSuite(makeSuite(),{mirror:transport,timeouts:{receiveMs:5000,cleanupMs:20},implementation:()=>{factories++;return adapter();}});
  expect(performance.now()-started).toBeLessThan(1000);
  expect(result).toMatchObject({outcome:"failed",failure:{kind:"transport"},cleanup:{status:"unconfirmed",quiescence:"unconfirmed",bindingStatus:"not_started"}});
  expect(closes).toBe(1);expect(factories).toBe(0);
});
test("observer exceptions stay implementation failures and invalid values remain codec failures",async()=>{
  const result=await runSuite(makeSuite(),{mirror:new Script(success),implementation:()=>({port:{...adapter().port,observe:()=>{throw new Error("observer unavailable");}},dispose(){}})});
  expect(result.failure?.kind).toBe("implementation");
  const invalid=await runSuite(makeSuite(),{mirror:new Script(success),implementation:()=>({port:{...adapter().port,observe:()=>({Count:"bad"})},dispose(){}})});
  expect(invalid.failure?.kind).toBe("codec");
});
test("never-settling native operation cannot claim quiescence merely because dispose returns",async()=>{
  let disposal=0;const transport=new Script(success);
  const result=await runSuite(makeSuite(),{mirror:transport,timeouts:{actionMs:10,cleanupMs:20},implementation:()=>({port:{actions:{Initialize:()=>new Promise<void>(()=>{}),Tick:()=>{}},observe:()=>({Count:0n})},dispose:()=>{disposal++;}})});
  expect(result).toMatchObject({outcome:"timedOut",cleanup:{status:"unconfirmed",quiescence:"unconfirmed"}});expect(disposal).toBe(1);expect(transport.sent).toHaveLength(1);
});
test("late operation settles during cleanup without late state report",async()=>{
  const transport=new Script(success);
  const result=await runSuite(makeSuite(),{mirror:transport,timeouts:{actionMs:10,cleanupMs:100},implementation:()=>({port:{actions:{Initialize:()=>wait(30),Tick:()=>{}},observe:()=>({Count:0n})},dispose:()=>{}})});
  expect(result).toMatchObject({outcome:"timedOut",cleanup:{status:"succeeded",quiescence:"confirmed"}});expect(transport.sent).toHaveLength(1);
});
test("disposal failure prevents passing and preserves mismatch primary",async()=>{
  const implementation=()=>adapter(()=>{throw new Error("dispose failed");});
  const good=await runSuite(makeSuite(),{mirror:new Script(success),implementation});
  expect(good).toMatchObject({outcome:"failed",conformance:"matched",acceptance:{status:"met"},cleanup:{status:"failed"},failure:{kind:"cleanup"}});
  const bad=await runSuite(makeSuite(),{mirror:new Script([matched,init,{proto_step:"step_mismatch",expected:{},actual:{}}]),implementation});
  expect(bad).toMatchObject({outcome:"mismatch",cleanup:{status:"failed"}});
});
test("hostile rejection objects and counterfeit mismatch failures cannot become behavioral mismatches",async()=>{
  const hostile=new Proxy({}, {get(){throw new Error("getter");},getPrototypeOf(){throw new Error("prototype");},getOwnPropertyDescriptor(){throw new Error("descriptor");}});
  for(const rejection of [hostile,new ReplayMismatchError("forged",{}, {},[],0,0,"init")]){
    const result=await runSuiteWithFactory(makeSuite(),{mirror:new Script(success)},()=>{throw rejection;});
    expect(result.outcome).toBe("failed");expect(result.failure?.kind).toBe("implementation");expect(()=>JSON.stringify(result)).not.toThrow();
  }
});
test("remote model path preserves wire meaning and local source provides preflight evidence",async()=>{
  const suite=makeSuite({...replay,modelSource:replay.config.specPath,config:{...replay.config,specPath:"/remote/Counter.tla"}});
  expect((await preflightSuite(suite)).stateCounts).toEqual([3]);
  const transport=new Script(success);expect((await runSuite(suite,{mirror:()=>transport,implementation:()=>adapter()})).outcome).toBe("passed");
  expect(JSON.parse(transport.sent[0]!).apalacheConfig.specPath).toBe("/remote/Counter.tla");
});

(process.env.MIRROR_BIN ? test : test.skip)("real Mirrors acknowledges every state and detects a faulty implementation",async()=>{
  const mirror=process.env.MIRROR_BIN!;
  const good=await runSuite(makeSuite(),{mirror,implementation:()=>adapter()});
  expect(good).toMatchObject({outcome:"passed",conformance:"matched",evidence:{complete:true,exact:true,initializationsMatched:"1",transitionsMatched:"2"}});
  let count=0n;
  const bad=await runSuite(makeSuite(),{mirror,implementation:()=>({port:{actions:{Initialize:()=>{count=0n;},Tick:(input)=>{count+=(input.Stride as bigint)-1n;}},observe:()=>({Count:count})},dispose:()=>{}})});
  expect(bad).toMatchObject({outcome:"mismatch",failure:{traceIndex:0,stateIndex:1},acceptance:{status:"incomplete"},evidence:{transitionsMatched:"0"}});
},30_000);
