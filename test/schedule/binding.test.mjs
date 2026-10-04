import test from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {ScheduleBindingSession,SCHEDULE_SCHEMA,WORKER_SCHEDULE_PROFILE} from '../../dist/index.js';
const identity={modelSemanticDigest:'1'.repeat(64),mappingSha256:'2'.repeat(64),implementationSha256:'3'.repeat(64)};
const steps=['read','write','$done'].map(checkpoint=>({actor:'a',checkpoint}));
function fixture(mode='ok'){
 const stats={acquired:0,disposed:0,buffers:[]};
 const adapter={identity,actors:[{actor:'a',operation:'one-increment'}],checkpoints:['read','write'],factory(){stats.acquired++;const buffer=new SharedArrayBuffer(40),state=new Int32Array(buffer);stats.buffers.push(state);return{workers:[{actor:'a',module:new URL('./counter-worker.mjs',import.meta.url),data:{buffer,index:0,mode}}],observe:()=>({count:state[0]}),teardown(){stats.disposed++;if(mode==='teardown')throw new Error('teardown failure');}};}};
 const schedule={schema:SCHEDULE_SCHEMA,profile:WORKER_SCHEDULE_PROFILE,identity,inputs:{},steps};return{stats,adapter,schedule};
}
test('binding owns fresh generations across initialization and disposes once',async()=>{
 const f=fixture(),session=new ScheduleBindingSession(f.schedule,f.adapter);assert.equal(f.stats.acquired,0);assert.throws(()=>session.observation());
 for(let i=0;i<2;i++){await session.initialize();assert.equal(session.observation().count,0);for(const step of steps)await session.advance(step);assert.equal(session.observation().count,1);}
 await session.dispose();await session.dispose();const receipt=session.receipt();assert.equal(receipt.initializations,2);assert.equal(receipt.disposals,1);assert.equal(receipt.executions.length,2);assert.notEqual(receipt.executions[0].executionId,receipt.executions[1].executionId);assert.equal(session.fullyCompleted(),true);assert.equal(f.stats.acquired,2);assert.equal(f.stats.disposed,2);await assert.rejects(session.initialize());
});
test('incomplete prior execution forbids another SUT acquisition',async()=>{
 const f=fixture(),session=new ScheduleBindingSession(f.schedule,f.adapter);await session.initialize();await session.advance(steps[0]);await assert.rejects(session.initialize(),{code:'schedule_previous_incomplete'});await session.dispose();assert.equal(f.stats.acquired,1);assert.equal(f.stats.disposed,1);assert.equal(session.fullyCompleted(),false);
});
test('disposal failure is stable on repeated calls',async()=>{
 const f=fixture('teardown'),session=new ScheduleBindingSession(f.schedule,f.adapter);await session.initialize();for(const step of steps)await session.advance(step);let primary;try{await session.dispose();assert.fail('disposal must fail');}catch(error){primary=error;}await assert.rejects(session.dispose(),error=>error===primary);assert.equal(f.stats.disposed,1);assert.equal(session.receipt().executions[0].cleanup,'teardown_failed');assert.equal(session.fullyCompleted(),false);
});
test('disposal joins a late factory and reclaims its program without entering workers',async()=>{
 const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;}),factory=f.adapter.factory;f.adapter.factory=async()=>{await gate;return factory();};
 const session=new ScheduleBindingSession(f.schedule,f.adapter);const initialized=session.initialize().catch(error=>error);const disposed=session.dispose();release();assert.equal((await initialized).code,'schedule_admission_failed');await disposed;assert.equal(f.stats.acquired,1);assert.equal(f.stats.disposed,1);assert.equal(f.stats.buffers[0][1],0);assert.equal(session.receipt().disposed,true);assert.equal(session.fullyCompleted(),false);
});
test('cleanup retry updates the retained receipt without converting the failed replay to a pass',async()=>{
 const f=fixture('blocked'),session=new ScheduleBindingSession(f.schedule,f.adapter,{executionTimeoutMs:300,cleanupTimeoutMs:5});await session.initialize();
 try{await assert.rejects(session.advance(steps[0]));await assert.rejects(session.dispose(),{code:'schedule_cleanup_failed'});assert.equal(session.receipt().executions[0].cleanup,'incomplete');}
 finally{Atomics.store(f.stats.buffers[0],7,1);await delay(30);await session.retryCleanup();}
 assert.equal(session.receipt().executions[0].cleanup,'confirmed');assert.equal(session.receipt().executions[0].outcome,'timed_out');assert.equal(session.fullyCompleted(),false);assert.equal(f.stats.disposed,1);
});
