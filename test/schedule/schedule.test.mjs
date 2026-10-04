import test from 'node:test';
import assert from 'node:assert/strict';
import {runWorkerSchedule,startWorkerSchedule,parseCheckpointSchedule,WORKER_SCHEDULE_PROFILE,SCHEDULE_SCHEMA} from '../../dist/index.js';
const identity={modelSemanticDigest:'1'.repeat(64),mappingSha256:'2'.repeat(64),implementationSha256:'3'.repeat(64)};
const step=s=>{const[actor,checkpoint]=s.split(':');return{actor,checkpoint};};
const plan=order=>({schema:SCHEDULE_SCHEMA,profile:WORKER_SCHEDULE_PROFILE,identity,inputs:{},steps:order.map(step)});
const serial=()=>plan(['a:read','a:write','a:$done','b:read','b:write','b:$done']);
const overlap=()=>plan(['a:read','b:read','a:write','b:write','a:$done','b:$done']);
const fixture=(mode='ok')=>{
 const stats={acquired:0,teardowns:0},buffer=new SharedArrayBuffer(40),state=new Int32Array(buffer);
 const adapter={identity,actors:[{actor:'a',operation:'increment-a'},{actor:'b',operation:'increment-b'}],checkpoints:['read','write'],factory(){stats.acquired++;
  return{workers:['a','b'].map((actor,index)=>({actor,module:new URL('./counter-worker.mjs',import.meta.url),data:{buffer,index,mode}})),
   observe(){if(mode==='observer')throw new Error('observer failure');if(mode==='large')return'x'.repeat(65_536);return{count:Atomics.load(state,0),saved:[Atomics.load(state,3),Atomics.load(state,4)],phase:[Atomics.load(state,5),Atomics.load(state,6)]};},
   teardown(){stats.teardowns++;if(mode==='teardown')throw new Error('teardown failed');}
  };
 }};return{adapter,stats,state};
};
const policy={executionTimeoutMs:3_000,cleanupTimeoutMs:1_000};
test('real workers retain stacks and reproduce serial and overlapping schedules',async()=>{
 for(const[p,expected]of[[serial(),2],[overlap(),1]]){
  const f=fixture(),run=await runWorkerSchedule(p,f.adapter,policy);assert.equal(run.receipt().passed,true);assert.equal(run.report().observations.at(-1).state.count,expected);
  assert.equal(f.stats.acquired,1);assert.equal(f.stats.teardowns,1);assert.equal(f.state[1],2);assert.equal(f.state[2],2);assert.equal(run.report().events.length,12);assert.equal(run.report().observations.length,7);
  assert.notEqual(run.receipt().actorThreads.a,run.receipt().actorThreads.b);
  const again=await runWorkerSchedule(p,fixture().adapter,policy);assert.deepEqual(run.report().events,again.report().events);assert.deepEqual(run.report().observations,again.report().observations);assert.notEqual(run.report().executionId,again.report().executionId);
 }
});
test('static admission precedes factory and profile mismatch is rejected',async()=>{
 const f=fixture();let p=serial();p={...p,identity:{...identity,mappingSha256:'f'.repeat(64)}};let run=await startWorkerSchedule(p,f.adapter,policy);assert.equal(run.report().outcome,'incompatible_identity');
 p=serial();p.steps[0].actor='unknown';run=await startWorkerSchedule(p,f.adapter,policy);assert.equal(run.report().outcome,'invalid_schedule');
 p=serial();p.steps.pop();run=await startWorkerSchedule(p,f.adapter,policy);assert.equal(run.report().outcome,'invalid_schedule');
 assert.equal(f.stats.acquired,0);assert.throws(()=>parseCheckpointSchedule(JSON.stringify({...serial(),profile:'mirrorcpp.cooperative-checkpoints/v1'})));
});
test('decoder rejects duplicate input keys and unknown fields',()=>{
 const text=JSON.stringify(serial());assert.deepEqual(parseCheckpointSchedule(text),serial());assert.throws(()=>parseCheckpointSchedule(text.replace('"inputs":{}','"inputs":{"x":1,"x":2}')));
 assert.throws(()=>parseCheckpointSchedule(text.replace('"schema":','"schema":"bad","schema":')));assert.throws(()=>parseCheckpointSchedule(JSON.stringify({...serial(),extra:true})));
});
test('incremental callbacks select one actor and refuse a changed interval',async()=>{
 const f=fixture(),run=await startWorkerSchedule(serial(),f.adapter,policy);assert.equal(f.state[1],0);assert.equal(run.report().observations.length,1);
 await run.advance(step('a:read'));assert.equal(f.state[1],1);await run.advance(step('b:read'));assert.equal(run.report().outcome,'invalid_schedule');assert.equal(run.report().cleanup,'confirmed');assert.equal(f.state[1],1);assert.equal(f.stats.teardowns,1);await assert.rejects(run.advance(step('a:write')));assert.equal((await run.finish()).outcome,'invalid_schedule');
});
test('actual wrong checkpoint, premature return, worker and observer failures clean up',async()=>{
 for(const[mode,outcome]of[['unexpected','unexpected_checkpoint'],['unknown','unexpected_checkpoint'],['early','unexpected_checkpoint'],['throw','application_failed'],['observer','observation_failed'],['large','observation_failed']]){
  const f=fixture(mode),run=await runWorkerSchedule(serial(),f.adapter,policy);assert.equal(run.report().outcome,outcome,mode);assert.equal(run.report().cleanup,'confirmed',mode);assert.deepEqual(run.report().remainingActors,[]);assert.equal(f.stats.teardowns,1);
 }
 const run=await runWorkerSchedule(serial(),fixture('teardown').adapter,policy);assert.equal(run.report().outcome,'completed');assert.equal(run.report().cleanup,'teardown_failed');assert.equal(run.receipt().passed,false);
});
test('cancellation before acquisition and between intervals',async()=>{
 const f=fixture(),abort=new AbortController();abort.abort();const rejected=await startWorkerSchedule(serial(),f.adapter,policy,abort.signal);assert.equal(rejected.report().outcome,'cancelled');assert.equal(f.stats.acquired,0);
 const stop=new AbortController(),run=await startWorkerSchedule(serial(),f.adapter,policy,stop.signal);await run.advance(step('a:read'));stop.abort();await run.cleanup();assert.equal(run.report().outcome,'cancelled');assert.equal(run.report().cleanup,'confirmed');assert.equal(f.stats.teardowns,1);
});
test('incomplete cleanup retains an uncooperative worker and allows retry',async()=>{
 const f=fixture('blocked'),run=await startWorkerSchedule(serial(),f.adapter,{executionTimeoutMs:300,cleanupTimeoutMs:10});
 try{await run.advance(step('a:read'));assert.equal(run.report().outcome,'timed_out');assert.equal(run.report().cleanup,'incomplete');assert.deepEqual(run.report().remainingActors,['a']);assert.equal(f.stats.teardowns,0);}
 finally{Atomics.store(f.state,7,1);await run.cleanup(2_000);}
 assert.equal(run.report().outcome,'timed_out');assert.equal(run.report().cleanup,'confirmed');assert.equal(f.stats.teardowns,1);
});
test('factory reentry rejects nested acquisition',async()=>{
 const f=fixture(),inner=fixture(),factory=f.adapter.factory;f.adapter.factory=async()=>{const rejected=await startWorkerSchedule(serial(),inner.adapter,policy);assert.equal(rejected.report().outcome,'invalid_schedule');return factory();};
 const run=await runWorkerSchedule(serial(),f.adapter,policy);assert.equal(run.receipt().passed,true);assert.equal(inner.stats.acquired,0);
});
test('identity and interval comparisons ignore JSON member order',async()=>{
 const f=fixture(),p=serial();p.identity={implementationSha256:identity.implementationSha256,mappingSha256:identity.mappingSha256,modelSemanticDigest:identity.modelSemanticDigest};p.steps=p.steps.map(({actor,checkpoint})=>({checkpoint,actor}));
 const run=await runWorkerSchedule(p,f.adapter,policy);assert.equal(run.receipt().passed,true);
});
test('failed worker construction reclaims created channels and runs teardown',async()=>{
 const f=fixture(),factory=f.adapter.factory;f.adapter.factory=()=>{const p=factory();p.workers[0].data=()=>{};return p;};const run=await runWorkerSchedule(serial(),f.adapter,policy);assert.equal(run.report().outcome,'resource_failed');assert.equal(run.report().cleanup,'confirmed');assert.equal(f.stats.teardowns,1);
});

test('cancellation cannot release workers while the observer is reading shared state',async()=>{
 const f=fixture('finally-mutate'),abort=new AbortController(),factory=f.adapter.factory;let during;
 f.adapter.factory=()=>{const p=factory(),observe=p.observe;p.observe=()=>{if(f.state[1]>0){abort.abort();const end=performance.now()+50;while(performance.now()<end){}during=Atomics.load(f.state,0);}return observe();};return p;};
 const run=await runWorkerSchedule(serial(),f.adapter,policy,abort.signal);assert.equal(during,0);assert.equal(f.state[0],100);assert.equal(run.report().outcome,'cancelled');assert.equal(run.report().cleanup,'confirmed');
});

test('a late hook after callback return cannot be silently credited as completion',async()=>{
 const f=fixture('late-hook');f.adapter.actors=f.adapter.actors.slice(0,1);const factory=f.adapter.factory;f.adapter.factory=()=>{const p=factory();p.workers=p.workers.slice(0,1);return p;};
 const run=await runWorkerSchedule(plan(['a:$done']),f.adapter,policy);assert.equal(run.report().outcome,'application_failed');assert.equal(run.receipt().passed,false);assert.equal(run.report().cleanup,'confirmed');
});
