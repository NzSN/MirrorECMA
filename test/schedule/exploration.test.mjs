import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {exploreFiniteSchedules,localWorkerExplorationRunner,canonicalScheduleState} from '../../dist/index.js';
const identity={modelSemanticDigest:'1'.repeat(64),mappingSha256:'2'.repeat(64),implementationSha256:'3'.repeat(64)};
function fixture(){let acquisitions=0;const adapter={identity,actors:[{actor:'a',operation:'increment'}],checkpoints:['read','write'],factory(){acquisitions++;const buffer=new SharedArrayBuffer(40),state=new Int32Array(buffer);return{workers:[{actor:'a',module:new URL('./counter-worker.mjs',import.meta.url),data:{buffer,index:0}}],observe:()=>({count:state[0]}),teardown(){}};}};return{runner:localWorkerExplorationRunner(adapter),acquisitions:()=>acquisitions};}
const space=()=>({identity,actors:[{actor:{actor:'a',operation:'increment'},checkpoints:['read','write','$done']}],inputs:[{}, {second:true}],maxPreemptions:0,baseVariables:['count'],instrumentationVariables:[]});
const clone=v=>JSON.parse(JSON.stringify(v));
test('invalid finite declarations cannot acquire a SUT',async()=>{
 for(const mutate of [s=>s.actors[0].checkpoints.pop(),s=>s.inputs.push({}),s=>s.baseVariables.push('count'),s=>s.instrumentationVariables.push('count')]){const f=fixture(),s=space();mutate(s);const result=await exploreFiniteSchedules(s,f.runner);assert.equal(result.status,'invalid_declaration');assert.equal(f.acquisitions(),0);}
});
test('evidence must match the exact candidate and use fresh execution identifiers',async()=>{
 for(const mode of ['schedule','stale','events','projection']){const f=fixture();let firstId;
  const result=await exploreFiniteSchedules(space(),async(p,signal)=>{const sample=await f.runner(p,signal),e=clone(sample.execution);if(mode==='schedule')e.schedule.identity.mappingSha256='f'.repeat(64);if(mode==='stale'){firstId??=e.executionId;e.executionId=firstId;}if(mode==='events')e.events.pop();if(mode==='projection')e.observations[0].state.extra=1;return{execution:e};});
  assert.equal(result.complete,false,mode);assert.ok(result.categories.runner_or_evidence_failed>=1,mode);if(mode==='schedule')assert.equal(f.acquisitions(),1);
 }
});
test('unknown cleanup stops another acquisition and a late runner cannot claim time-budget completion',async()=>{
 let f=fixture();let result=await exploreFiniteSchedules(space(),async(p,signal)=>{const sample=await f.runner(p,signal),e=clone(sample.execution);e.cleanup='incomplete';e.remainingActors=['a'];return{execution:e};});assert.equal(result.stopReason,'unconfirmed_cleanup');assert.equal(f.acquisitions(),1);
 f=fixture();const s=space();s.inputs=[{}];result=await exploreFiniteSchedules(s,async(p,signal)=>{await delay(15);return f.runner(p,signal);},{timeBudgetMs:10});assert.equal(result.complete,false);assert.equal(result.stopReason,'time_budget');
});
test('validated model counterexample survives a separate cleanup failure',async()=>{
 const f=fixture();const result=await exploreFiniteSchedules({...space(),requireModelComparison:true},async(p,signal)=>{
  const sample=await f.runner(p,signal),e=clone(sample.execution);e.cleanup='teardown_failed';e.passed=false;
  return{execution:e,comparison:{schema:'mirrors.scheduled-comparison/v1',comparison:'step_mismatch',peerTerminal:'step_mismatch',passed:false,client:{kind:'step_mismatch'},binding:{executions:[e]}}};
 });assert.equal(result.complete,false);assert.equal(result.firstCounterexample.category,'model_mismatch');assert.equal(result.firstFailure.category,'cleanup_failed');assert.equal(result.stopReason,'unconfirmed_cleanup');assert.equal(f.acquisitions(),1);
});
test('semantic coverage preserves types and ordinary record keys while normalizing sets and map order',()=>{
 const int=n=>({tag:'int',val:BigInt(n)}),str=s=>({tag:'str',val:s}),set=v=>({tag:'set',val:v}),map=v=>({tag:'map',val:v});
 assert.equal(canonicalScheduleState({v:set([int(2),int(1),int(2)])}),canonicalScheduleState({v:set([int(1),int(2)])}));
 assert.equal(canonicalScheduleState({v:map([[str('b'),int(2)],[str('a'),int(1)]])}),canonicalScheduleState({v:map([[str('a'),int(1)],[str('b'),int(2)]])}));
 assert.notEqual(canonicalScheduleState({v:map([[str('1'),int(1)]])}),canonicalScheduleState({v:map([[int(1),int(1)]])}));
 assert.throws(()=>canonicalScheduleState({v:map([[int(1),int(1)],[str('1'),int(1)]])}));assert.throws(()=>canonicalScheduleState({v:map([[int(1),int(1)],[int(1),int(2)]])}));
 const ordinary={v:{tag:'record',val:Object.fromEntries([['__proto__',int(7)],['tag',str('ordinary')]])}};assert.ok(canonicalScheduleState(ordinary).includes('__proto__'));assert.equal({}.polluted,undefined);
 assert.notEqual(canonicalScheduleState({v:{tag:'seq',val:[int(1),int(2)]}}),canonicalScheduleState({v:{tag:'seq',val:[int(2),int(1)]}}));
});
