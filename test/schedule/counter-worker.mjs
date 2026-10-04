import { isMainThread } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
export async function run({buffer,index,mode='ok'},hook){
 if(isMainThread)throw new Error('fixture requires actual worker thread');
 const state=new Int32Array(buffer);Atomics.add(state,1,1);
 if(mode==='finally-mutate'){try{await hook.arrive('read');}finally{Atomics.add(state,0,100);}return;}
 if(mode==='late-hook'){setTimeout(async()=>{try{await hook.arrive('read');}catch{}},10);return;}
 if(mode==='throw')throw new Error('deliberate worker failure');
 if(mode==='early')return;
 if(mode==='blocked')while(Atomics.load(state,7)===0)await delay(1);
 const enter=()=>{if(Atomics.add(state,8,1)!==0)throw new Error('concurrent actor intervals');};
 const park=async checkpoint=>{Atomics.sub(state,8,1);await hook.arrive(checkpoint);enter();};
 enter();const saved=Atomics.load(state,0);Atomics.store(state,3+index,saved);Atomics.store(state,5+index,1);
 await park(mode==='unexpected'?'write':mode==='unknown'?'wrong':'read');
 Atomics.store(state,0,saved+(mode==='mutate'?2:1));Atomics.store(state,5+index,2);await park('write');
 Atomics.store(state,5+index,3);Atomics.sub(state,8,1);Atomics.add(state,2,1);
}
