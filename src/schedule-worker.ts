/** Internal owned-worker bootstrap. Application modules load only after a permit. */
import { isMainThread, MessagePort, threadId, workerData } from "node:worker_threads";
import type { ScheduleJson } from "./schedule-data.js";
export interface WorkerCheckpoint {
  readonly signal: AbortSignal;
  readonly threadId: number;
  arrive(checkpoint: string): Promise<void>;
  request(input: ScheduleJson): Promise<ScheduleJson>;
}
export type ScheduledWorkerFunction = (input: unknown, checkpoint: WorkerCheckpoint) => void | Promise<void>;
interface Boot { module: string; data: unknown; port: MessagePort }
if (isMainThread || !(workerData?.port instanceof MessagePort)) throw new Error("scheduler bootstrap requires its private worker channel");
const boot = workerData as Boot, port = boot.port;
const abort = new AbortController();
let waiter: {resolve():void;reject(error:Error):void}|undefined;
let rpc: {id:number;resolve(value:ScheduleJson):void;reject(error:Error):void}|undefined;
let nextRequest=0, permitted=false, finished=false;
const stopped=()=>new Error("scheduled worker cancelled");
port.on("message", (message: {kind:string;id?:number;value?:ScheduleJson;error?:string})=>{
  if(message.kind==="cancel") {abort.abort();waiter?.reject(stopped());waiter=undefined;rpc?.reject(stopped());rpc=undefined;}
  else if(message.kind==="permit") {if(abort.signal.aborted)return;if(!waiter)throw new Error("permit outside parked worker");permitted=true;const ready=waiter;waiter=undefined;ready.resolve();}
  else if(message.kind==="reply") {if(!rpc || rpc.id!==message.id){if(abort.signal.aborted)return;throw new Error("unexpected worker RPC reply");}const pending=rpc;rpc=undefined;if(message.error)pending.reject(new Error(message.error));else pending.resolve(message.value!);}
  else throw new Error("unknown worker control message");
});
const wait=():Promise<void>=>{
  if(abort.signal.aborted)return Promise.reject(stopped());
  if(waiter)return Promise.reject(new Error("overlapping worker waits"));
  return new Promise((resolve,reject)=>{waiter={resolve,reject};});
};
const checkpoint:WorkerCheckpoint={signal:abort.signal,threadId,
  async arrive(name:string){if(finished){port.postMessage({kind:"failure",error:"checkpoint after worker callback completion"});throw new Error("worker callback already completed");}if(!permitted || rpc || waiter)throw new Error("checkpoint outside owned interval");permitted=false;const pending=wait();port.postMessage({kind:"arrival",checkpoint:name});await pending;},
  async request(input:ScheduleJson){if(finished){port.postMessage({kind:"failure",error:"request after worker callback completion"});throw new Error("worker callback already completed");}if(abort.signal.aborted)throw stopped();if(!permitted||rpc||waiter)throw new Error("RPC outside owned interval");const id=nextRequest++;const pending=new Promise<ScheduleJson>((resolve,reject)=>{rpc={id,resolve,reject};});port.postMessage({kind:"request",id,input});return pending;}
};
async function run():Promise<void>{
  const initial=wait();port.postMessage({kind:"ready",threadId});await initial;
  const module = await import(boot.module) as {run?:ScheduledWorkerFunction};
  if(typeof module.run!=="function")throw new Error("scheduled worker module must export run");
  await module.run(boot.data,checkpoint);
  if(waiter||rpc)throw new Error("worker completed with an unawaited checkpoint or request");
}
void run().then(()=>{finished=true;port.postMessage({kind:"finished"});},error=>{
  finished=true;
  if(!abort.signal.aborted){port.postMessage({kind:"failure",error:error instanceof Error?error.message:String(error)});process.exitCode=1;}
  else port.postMessage({kind:"finished"});
}).finally(()=>{
  // Release only the bootstrap channel's event-loop reference. The controller
  // retains the Worker and waits for its real exit; late application hooks still
  // report a failure while other application handles keep this worker alive.
  port.unref();
});
