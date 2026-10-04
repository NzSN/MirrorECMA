import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { isMainThread, MessageChannel, MessagePort, Worker } from "node:worker_threads";
import { performance } from "node:perf_hooks";
import { freezeScheduleData, parseCheckpointSchedule, scheduleData, scheduleDigest, scheduleIdentifier, SCHEDULE_COMPLETION, type CheckpointSchedule, type ScheduleActor, type ScheduleIdentity, type ScheduleJson, type ScheduleStep } from "./schedule-data.js";
export { parseCheckpointSchedule, WORKER_SCHEDULE_PROFILE, SCHEDULE_SCHEMA, SCHEDULE_COMPLETION, type CheckpointSchedule, type ScheduleActor, type ScheduleIdentity, type ScheduleJson, type ScheduleStep } from "./schedule-data.js";
export type { WorkerCheckpoint, ScheduledWorkerFunction } from "./schedule-worker.js";
export interface SchedulePolicy { readonly maxActors?:number; readonly maxSteps?:number; readonly executionTimeoutMs?:number; readonly cleanupTimeoutMs?:number }
export interface ScheduledWorker { readonly actor:string; readonly module:URL; readonly data?:unknown }
export interface WorkerProgram {
  readonly workers:readonly ScheduledWorker[];
  observe():ScheduleJson;
  teardown():void|Promise<void>;
  request?(actor:string,input:ScheduleJson,signal:AbortSignal):ScheduleJson|Promise<ScheduleJson>;
}
export interface WorkerScheduleAdapter {
  readonly identity:ScheduleIdentity; readonly actors:readonly ScheduleActor[]; readonly checkpoints:readonly string[];
  factory(inputs:ScheduleJson):WorkerProgram|Promise<WorkerProgram>;
}
export type ScheduleOutcome="completed"|"invalid_schedule"|"incompatible_identity"|"cancelled"|"timed_out"|"unexpected_checkpoint"|"uncontrolled_actor"|"application_failed"|"observation_failed"|"resource_failed";
export type ScheduleCleanup="not_started"|"confirmed"|"incomplete"|"teardown_failed";
export interface ScheduleReport {
  outcome:ScheduleOutcome;detail:string;scheduleCompleted:boolean;cleanup:ScheduleCleanup;remainingActors:string[];
  generation:number;executionId:string;events:ScheduleJson[];observations:{afterSteps:number;state:ScheduleJson}[];cleanupAttempts:ScheduleJson[];
}
type Phase="starting"|"parked"|"running"|"finishing"|"finished";
interface Actor { declaration:ScheduleActor;phase:Phase;checkpoint:string;worker?:Worker;port?:MessagePort;threadId?:number;exited:boolean;reportedFinish:boolean;requestPending:boolean;requestId:number }
const callbackScope=new AsyncLocalStorage<boolean>();let generation=0;
const budget=(n:number)=>Number.isSafeInteger(n)&&n>0&&n<=86_400_000;
const errorText=(e:unknown)=>{try{return e instanceof Error?e.message:String(e);}catch{return "unprintable application failure";}};
const same=(a:unknown,b:unknown)=>!!a&&!!b&&typeof a==="object"&&typeof b==="object"&&Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(k=>Object.hasOwn(b,k)&&(a as Record<string,unknown>)[k]===(b as Record<string,unknown>)[k]);
export class ScheduleExecution {
  private readonly actors:Actor[];
  private readonly checkpoints:Set<string>;
  private readonly state:ScheduleReport;
  private readonly policy:Required<SchedulePolicy>;
  private readonly abort=new AbortController();
  private program:WorkerProgram|undefined;
  private readonly wakeups=new Set<()=>void>();
  private pendingRequests=0;
  private observing=false;private next=0;private stopped=false;private closed=false;private busy=false;private evidenceBytes=0;
  private readonly deadline:number;
  private readonly onAbort:()=>void;
  private constructor(readonly schedule:CheckpointSchedule,private readonly adapter:WorkerScheduleAdapter,policy:SchedulePolicy,private readonly signal?:AbortSignal){
    this.policy={maxActors:policy.maxActors??64,maxSteps:policy.maxSteps??65_536,executionTimeoutMs:policy.executionTimeoutMs??2_000,cleanupTimeoutMs:policy.cleanupTimeoutMs??1_000};
    this.deadline=performance.now()+Math.min(this.policy.executionTimeoutMs,86_400_000);
    this.actors=adapter.actors.map(a=>({declaration:{...a},phase:"starting",checkpoint:"$start",exited:false,reportedFinish:false,requestPending:false,requestId:0}));
    this.checkpoints=new Set(adapter.checkpoints);
    this.state={outcome:"completed",detail:"",scheduleCompleted:false,cleanup:"not_started",remainingActors:[],generation:++generation,executionId:randomBytes(16).toString("hex"),events:[],observations:[],cleanupAttempts:[]};
    this.onAbort=()=>this.fail("cancelled","caller cancellation");
  }
  static async start(schedule:CheckpointSchedule,adapter:WorkerScheduleAdapter,policy:SchedulePolicy={},signal?:AbortSignal):Promise<ScheduleExecution>{
    const parsed=parseCheckpointSchedule(JSON.stringify(scheduleData(schedule,8*1_048_576)));
    const run=new ScheduleExecution(parsed,adapter,policy,signal);
    try{run.admit();}catch(error){run.fail("invalid_schedule",errorText(error));run.closed=true;return run;}
    if(!same(parsed.identity,adapter.identity)){run.fail("incompatible_identity","adapter identity differs");run.closed=true;return run;}
    if(signal?.aborted){run.fail("cancelled","cancelled before acquisition");run.closed=true;return run;}
    signal?.addEventListener("abort",run.onAbort,{once:true});
    try{run.program=await callbackScope.run(true,()=>adapter.factory(parsed.inputs));}
    catch(error){run.fail("application_failed",errorText(error));run.closed=true;signal?.removeEventListener("abort",run.onAbort);return run;}
    try{
      const program=run.program;
      if(!program||typeof program.observe!=="function"||typeof program.teardown!=="function"||!Array.isArray(program.workers))throw new Error("factory returned invalid program");
      const workers=new Map<string,ScheduledWorker>();
      for(const worker of program.workers){if(workers.has(worker.actor)||!(worker.module instanceof URL)||worker.module.protocol!=="file:")throw new Error("invalid worker module or duplicate worker");workers.set(worker.actor,worker);}
      if(workers.size!==run.actors.length || run.actors.some(a=>!workers.has(a.declaration.actor)))throw new Error("factory worker set differs");
      for(const actor of run.actors){
        const spec=workers.get(actor.declaration.actor)!, channel=new MessageChannel();actor.port=channel.port1;
        actor.port.on("message",(message:unknown)=>run.message(actor,message));actor.port.on("messageerror",()=>run.fail("application_failed","worker message decode failure"));
        try { actor.worker=new Worker(new URL("./schedule-worker.js",import.meta.url),{workerData:{module:spec.module.href,data:spec.data,port:channel.port2},transferList:[channel.port2]}); } catch(error) { channel.port1.close();channel.port2.close();run.fail("resource_failed",errorText(error));break; }
        actor.worker.on("error",error=>run.fail("application_failed",errorText(error)));
        actor.worker.on("exit",code=>{actor.exited=true;actor.port?.close();if(!run.stopped&&(code!==0||!actor.reportedFinish))run.fail("application_failed","worker exited without successful completion");actor.phase="finished";actor.checkpoint=SCHEDULE_COMPLETION;run.wake();});
      }
    }catch(error){run.fail("application_failed",errorText(error));}
    if(await run.waitUntil(()=>run.actors.every(a=>a.phase==="parked"),run.deadline,true))run.observe();
    if(run.stopped)await run.cleanupInternal(run.policy.cleanupTimeoutMs);
    return run;
  }
  private admit():void{
    if(!isMainThread||callbackScope.getStore())throw new Error("scheduler controller reentry or non-main controller");
    const p=this.policy;
    if(!budget(p.executionTimeoutMs)||!budget(p.cleanupTimeoutMs)||!Number.isInteger(p.maxActors)||p.maxActors<1||p.maxActors>64||!Number.isInteger(p.maxSteps)||p.maxSteps<1||p.maxSteps>65_536)throw new Error("invalid scheduler policy");
    if(this.actors.length===0||this.actors.length>p.maxActors||this.schedule.steps.length>p.maxSteps)throw new Error("actor/step bound exceeded");
    if(!Object.values(this.adapter.identity).every(scheduleDigest)||Object.keys(this.adapter.identity).length!==3)throw new Error("invalid adapter identity");
    const actors=new Set<string>(), operations=new Set<string>();
    for(const {declaration:a} of this.actors){if(!scheduleIdentifier(a.actor)||!scheduleIdentifier(a.operation)||actors.has(a.actor)||operations.has(a.operation))throw new Error("invalid or duplicate actor/operation");actors.add(a.actor);operations.add(a.operation);}
    if(this.checkpoints.size!==this.adapter.checkpoints.length||this.adapter.checkpoints.some(c=>!scheduleIdentifier(c)))throw new Error("invalid checkpoint vocabulary");
    const done=new Set<string>();
    for(const step of this.schedule.steps){if(!actors.has(step.actor)||done.has(step.actor))throw new Error("unknown actor or interval after completion");if(step.checkpoint===SCHEDULE_COMPLETION)done.add(step.actor);else if(!this.checkpoints.has(step.checkpoint))throw new Error("undeclared schedule checkpoint");}
    if(done.size!==actors.size)throw new Error("every actor requires terminal completion");
  }
  private wake():void{for(const wake of [...this.wakeups])wake();}
  private fail(outcome:ScheduleOutcome,detail:string):void{
    if(this.state.outcome==="completed"){this.state.outcome=outcome;this.state.detail=detail.slice(0,4_096);}
    this.stopped=true;this.abort.abort();if(!this.observing)for(const a of this.actors)a.port?.postMessage({kind:"cancel"});this.wake();
  }
  private async changed(ms:number):Promise<void>{await new Promise<void>(resolve=>{const wake=()=>{clearTimeout(timer);this.wakeups.delete(wake);resolve();};const timer=setTimeout(wake,Math.max(1,Math.min(ms,2_147_483_647)));this.wakeups.add(wake);});}
  private async waitUntil(predicate:()=>boolean,deadline:number,execution:boolean):Promise<boolean>{
    for(;;){if(execution&&this.stopped)return false;if(execution&&this.signal?.aborted){this.fail("cancelled","caller cancellation");return false;}if(performance.now()>=deadline){if(execution)this.fail("timed_out","execution deadline exceeded");return false;}if(predicate())return true;await this.changed(deadline-performance.now());}
  }
  private message(actor:Actor,value:unknown):void{
    try{
      if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("invalid worker control message");
      const message=value as Record<string,unknown>;
      if(message.kind==="ready"){
        if(actor.phase!=="starting"||!Number.isInteger(message.threadId)||message.threadId!==actor.worker?.threadId)throw new Error("invalid worker identity/barrier");
        actor.threadId=message.threadId as number;actor.phase="parked";
      }else if(message.kind==="arrival"){
        if(this.stopped)return;
        if(actor.phase!=="running"||actor.requestPending){this.fail("uncontrolled_actor","arrival outside owned interval");return;}
        if(!scheduleIdentifier(message.checkpoint)||!this.checkpoints.has(message.checkpoint)){this.fail("unexpected_checkpoint","undeclared actual checkpoint");return;}
        actor.checkpoint=message.checkpoint;actor.phase="parked";
      }else if(message.kind==="finished"){
        if(!this.stopped&&(actor.phase!=="running"||actor.requestPending))throw new Error("worker completed outside owned interval");
        actor.reportedFinish=true;actor.phase="finishing";actor.checkpoint=SCHEDULE_COMPLETION;
      }else if(message.kind==="failure"){if(!this.stopped)this.fail("application_failed",typeof message.error==="string"?message.error:"worker failure");}
      else if(message.kind==="request"){
        if(this.stopped)return;
        if(actor.phase!=="running"||actor.requestPending||message.id!==actor.requestId++||!this.program?.request)throw new Error("uncontrolled worker request");
        const input=scheduleData(message.input);actor.requestPending=true;this.pendingRequests++;
        void callbackScope.run(true,async()=>{
          try{const result=scheduleData(await this.program!.request!(actor.declaration.actor,input,this.abort.signal));if(!this.stopped)actor.port?.postMessage({kind:"reply",id:message.id,value:result});}
          catch(error){if(!this.stopped){actor.port?.postMessage({kind:"reply",id:message.id,error:errorText(error)});this.fail("application_failed",errorText(error));}}
          finally{actor.requestPending=false;this.pendingRequests--;this.wake();}
        });
      }else throw new Error("unknown worker control message");
      this.wake();
    }catch(error){this.fail("application_failed",errorText(error));}
  }
  private event(kind:string,index:number,actor:Actor):void{
    const row={ordinal:this.state.events.length,kind,step:index,actor:actor.declaration.actor,operation:actor.declaration.operation,checkpoint:actor.checkpoint};
    this.evidenceBytes+=Buffer.byteLength(JSON.stringify(row));if(this.evidenceBytes>8*1_048_576)this.fail("resource_failed","execution evidence exceeds bound");else this.state.events.push(row);
  }
  private observe():void{
    if(this.stopped)return;
    if(this.pendingRequests||this.actors.some(a=>a.phase!=="parked"&&a.phase!=="finished")){this.fail("observation_failed","actors not quiescent");return;}
    this.observing=true;
    try{const value=callbackScope.run(true,()=>scheduleData(this.program!.observe()));if(this.stopped)return;if(performance.now()>=this.deadline){this.fail("timed_out","execution deadline exceeded during observation");return;}const bytes=Buffer.byteLength(JSON.stringify(value));if(this.evidenceBytes+bytes>8*1_048_576)throw new Error("observation evidence exceeds bound");this.evidenceBytes+=bytes;this.state.observations.push({afterSteps:this.next,state:value});}
    catch(error){this.fail("observation_failed",errorText(error));}
    finally{this.observing=false;if(this.stopped)for(const actor of this.actors)actor.port?.postMessage({kind:"cancel"});}
  }
  private async operation<T>(action:()=>Promise<T>):Promise<T>{if(this.busy||callbackScope.getStore()||!isMainThread)throw new Error("scheduler controller reentry");this.busy=true;try{return await action();}finally{this.busy=false;}}
  async advance(step:ScheduleStep):Promise<ScheduleReport>{return this.operation(async()=>{
    if(this.closed)throw new Error("execution already closed");
    if(this.stopped)return this.report();
    if(this.signal?.aborted)this.fail("cancelled","caller cancellation");
    else if(performance.now()>=this.deadline)this.fail("timed_out","execution deadline exceeded");
    else if(!same(step,this.schedule.steps[this.next]))this.fail("invalid_schedule","callback differs from admitted interval");
    if(!this.stopped){
      const actor=this.actors.find(a=>a.declaration.actor===step.actor)!;
      if(actor.phase!=="parked")this.fail("unexpected_checkpoint","selected actor not parked");
      else{this.event("permit",this.next,actor);if(!this.stopped){actor.phase="running";actor.port!.postMessage({kind:"permit"});
        if(await this.waitUntil(()=>actor.phase==="parked"||actor.phase==="finished",this.deadline,true)){
          this.event("arrival",this.next,actor);
          if(actor.checkpoint!==step.checkpoint)this.fail("unexpected_checkpoint",`expected ${step.checkpoint}, arrived at ${actor.checkpoint}`);
          if(!this.stopped){this.next++;this.observe();}
        }
      }}
    }
    if(!this.stopped&&this.next===this.schedule.steps.length)this.state.scheduleCompleted=true;
    if(this.stopped||this.state.scheduleCompleted)return this.cleanupInternal(this.policy.cleanupTimeoutMs);
    return this.report();
  });}
  async finish():Promise<ScheduleReport>{return this.operation(async()=>{if(this.closed)return this.report();if(this.next!==this.schedule.steps.length)this.fail("invalid_schedule","execution ended before all intervals");return this.cleanupInternal(this.policy.cleanupTimeoutMs);});}
  async cleanup(timeoutMs=this.policy.cleanupTimeoutMs):Promise<ScheduleReport>{return this.operation(()=>this.cleanupInternal(timeoutMs));}
  private async cleanupInternal(timeoutMs:number):Promise<ScheduleReport>{
    if(!budget(timeoutMs))throw new Error("invalid cleanup budget");if(this.closed)return this.report();
    if(this.state.outcome==="completed"&&!this.state.scheduleCompleted)this.fail("cancelled","cleanup requested before completion");
    this.stopped=true;this.abort.abort();for(const actor of this.actors)actor.port?.postMessage({kind:"cancel"});
    await this.waitUntil(()=>this.actors.every(a=>!a.worker||a.exited)&&this.pendingRequests===0,performance.now()+timeoutMs,false);
    const remaining=this.actors.filter(a=>a.worker&&!a.exited||a.requestPending).map(a=>a.declaration.actor);
    if(remaining.length||this.pendingRequests){this.state.cleanup="incomplete";this.state.remainingActors=remaining;this.state.cleanupAttempts.push({cleanup:"incomplete",remainingActors:remaining});return this.report();}
    this.closed=true;this.signal?.removeEventListener("abort",this.onAbort);this.state.remainingActors=[];
    if(!this.program)this.state.cleanup="not_started";
    else try{await callbackScope.run(true,()=>this.program!.teardown());this.state.cleanup="confirmed";}
    catch(error){this.state.cleanup="teardown_failed";this.state.cleanupAttempts.push({cleanup:"teardown_failed",error:errorText(error)});}
    if(this.state.cleanup!=="teardown_failed")this.state.cleanupAttempts.push({cleanup:this.state.cleanup,remainingActors:[]});return this.report();
  }
  report():ScheduleReport{return freezeScheduleData(JSON.parse(JSON.stringify(this.state)) as ScheduleReport);}
  receipt():ScheduleJson{return freezeScheduleData({...this.report(),schema:"mirrors.checkpoint-execution/v1",schedule:this.schedule,actors:this.actors.map(a=>a.declaration),checkpoints:[...this.checkpoints],policy:this.policy,coverage:"recorded-schedule-only",actorThreads:Object.fromEntries(this.actors.map(a=>[a.declaration.actor,a.threadId??null])),passed:this.state.outcome==="completed"&&this.state.scheduleCompleted&&this.state.cleanup==="confirmed"}) as unknown as ScheduleJson;}
}
export async function startWorkerSchedule(schedule:CheckpointSchedule,adapter:WorkerScheduleAdapter,policy:SchedulePolicy={},signal?:AbortSignal):Promise<ScheduleExecution>{return ScheduleExecution.start(schedule,adapter,policy,signal);}
export async function runWorkerSchedule(schedule:CheckpointSchedule,adapter:WorkerScheduleAdapter,policy:SchedulePolicy={},signal?:AbortSignal):Promise<ScheduleExecution>{const run=await startWorkerSchedule(schedule,adapter,policy,signal);for(const step of schedule.steps){if(run.report().outcome!=="completed"||run.report().scheduleCompleted)break;await run.advance(step);}return run;}
