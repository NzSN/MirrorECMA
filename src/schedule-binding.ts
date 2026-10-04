import { startWorkerSchedule, type CheckpointSchedule, type ScheduleExecution, type ScheduleJson, type SchedulePolicy, type ScheduleStep, type WorkerScheduleAdapter } from "./schedule.js";
import { decodeMirrorMessage, renderDiffHint, type ApalacheConfig } from "./protocol.js";
import { spawnMirror, type Transport } from "./transport.js";
import { runClientWithTracesNegotiatedWithReport, type CompiledExecutionSelection, type NegotiatedReportRunOptions } from "./negotiated.js";
import { replayCleanupFailure, ReplayMismatchError } from "./replay-report.js";
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value));
const message=(error:unknown)=>error instanceof Error?error.message:String(error);
export class ScheduleBindingError extends Error { constructor(readonly code:string,text:string){super(text);this.name="ScheduleBindingError";} }
export class ScheduleBindingSession {
  private execution:ScheduleExecution|undefined;private records:ScheduleJson[]=[];private retained=false;private receiptBytes=0;
  private initializations=0;private disposals=0;private disposed=false;private receiptComplete=true;private disposalError:unknown;
  private closing=false;private busy=false;private pending:Promise<unknown>|undefined;private disposalTask:Promise<void>|undefined;
  private readonly cancellation=new AbortController();
  private readonly forwardAbort=()=>this.cancellation.abort();
  constructor(private readonly schedule:CheckpointSchedule,private readonly adapter:WorkerScheduleAdapter,private readonly policy:SchedulePolicy={},private readonly signal?:AbortSignal){}
  private async operation<T>(fn:()=>Promise<T>):Promise<T>{if(this.busy)throw new ScheduleBindingError("schedule_reentrant","overlapping binding session operation");this.busy=true;try{const pending=fn();this.pending=pending;return await pending;}finally{this.busy=false;this.pending=undefined;}}
  private retain():void{if(!this.execution||this.retained)return;const row=this.execution.receipt(),length=bytes(row);if(this.receiptBytes+length>16*1_048_576){this.receiptComplete=false;this.records.push({passed:false,evidenceError:"receipt_byte_bound_exceeded"});}else{this.receiptBytes+=length;this.records.push(row);}this.retained=true;}
  async initialize():Promise<void>{return this.operation(async()=>{
    if(this.disposed||this.closing||this.initializations>=64)throw new ScheduleBindingError("schedule_lifecycle_invalid","disposed session or initialization limit");
    if(this.execution){const prior=await this.execution.finish();this.retain();if(prior.outcome!=="completed"||!prior.scheduleCompleted||prior.cleanup!=="confirmed"||!this.receiptComplete)throw new ScheduleBindingError("schedule_previous_incomplete","previous execution incomplete");this.execution=undefined;}
    if(this.initializations===0){if(this.signal?.aborted)this.cancellation.abort();else this.signal?.addEventListener("abort",this.forwardAbort,{once:true});}
    this.initializations++;this.retained=false;this.execution=await startWorkerSchedule(this.schedule,this.adapter,this.policy,this.cancellation.signal);
    const report=this.execution.report();if(report.outcome!=="completed")throw new ScheduleBindingError("schedule_admission_failed",report.outcome+": "+report.detail);
  });}
  async advance(step:ScheduleStep):Promise<void>{return this.operation(async()=>{
    if(this.disposed||this.closing||!this.execution)throw new ScheduleBindingError("schedule_lifecycle_invalid","binding session is not live");
    const report=await this.execution.advance(step);if(report.outcome!=="completed")throw new ScheduleBindingError("schedule_interval_failed",report.outcome+": "+report.detail);
  });}
  observation():ScheduleJson{
    if(this.disposed||this.closing||!this.execution||this.busy)throw new ScheduleBindingError("schedule_lifecycle_invalid","binding session is not quiescent");
    const report=this.execution.report();if(report.outcome!=="completed"||report.observations.length===0)throw new ScheduleBindingError("schedule_observation_unavailable",report.detail);
    return report.observations.at(-1)!.state;
  }
  dispose():Promise<void>{
    if(this.disposalTask)return this.disposalTask;
    this.closing=true;this.cancellation.abort();
    this.disposalTask=(async()=>{
      if(this.pending){try{await this.pending;}catch{/* Primary callback error remains with the replay runner. */}}
      return this.operation(async()=>{
        if(this.disposed){if(this.disposalError!==undefined)throw this.disposalError;return;}
        this.disposed=true;this.disposals++;this.signal?.removeEventListener("abort",this.forwardAbort);
        try{if(this.execution){const report=this.execution.report().scheduleCompleted?await this.execution.finish():await this.execution.cleanup();this.retain();if(report.cleanup!=="confirmed")throw new ScheduleBindingError("schedule_cleanup_failed",report.cleanup);if(!this.receiptComplete)throw new ScheduleBindingError("schedule_cleanup_failed","receipt bound exceeded");}}
        catch(error){this.disposalError=error;throw error;}
      });
    })();
    return this.disposalTask;
  }
  async retryCleanup():Promise<void>{return this.operation(async()=>{if(!this.disposed)throw new ScheduleBindingError("schedule_lifecycle_invalid","dispose before retrying cleanup");if(this.execution){const report=await this.execution.cleanup();if(report.cleanup!=="confirmed")throw new ScheduleBindingError("schedule_cleanup_failed",report.cleanup);
      if(this.retained&&this.records.length){const current=this.execution.receipt(),old=this.records.at(-1);const total=this.receiptBytes-bytes(old)+bytes(current);if(total<=16*1_048_576){this.receiptBytes=total;this.records[this.records.length-1]=current;}else this.receiptComplete=false;}
    }});}
  receipt():Record<string,unknown>{const records=[...this.records];let complete=this.receiptComplete;if(this.execution&&!this.retained){const row=this.execution.receipt();if(this.receiptBytes+bytes(row)<=16*1_048_576)records.push(row);else{complete=false;records.push({passed:false,evidenceError:"receipt_byte_bound_exceeded"});}}return{schema:"mirrors.scheduled-binding/v1",initializations:this.initializations,disposals:this.disposals,disposed:this.disposed,receiptComplete:complete,executions:records};}
  fullyCompleted():boolean{return this.disposed&&this.initializations>0&&this.disposalError===undefined&&this.receiptComplete&&this.records.length>0&&this.records.every(row=>typeof row==="object"&&row!==null&&!Array.isArray(row)&&"passed"in row&&row.passed===true);}
}
export interface ScheduledReplayResult {readonly passed:boolean;readonly evidence:Record<string,unknown>;readonly error?:unknown}
/** Preserve real peer terminal verdict, primary error and binding cleanup independently. */
export async function replayScheduledTraces(target:string|Transport,config:ApalacheConfig,traces:readonly string[],selection:CompiledExecutionSelection,session:ScheduleBindingSession,options:Omit<NegotiatedReportRunOptions,"spec">={}):Promise<ScheduledReplayResult>{
  const transport=typeof target==="string"?spawnMirror(target):target;
  let terminal="",raw="",primary:unknown,failed=false,client:Record<string,unknown>={status:"succeeded"};
  const before=session.receipt();
  if(before.initializations!==0||before.disposals!==0||before.disposed!==false){await transport.close();const error=new ScheduleBindingError("schedule_session_reused","scheduled replay requires fresh session");return{passed:false,error,evidence:{schema:"mirrors.scheduled-comparison/v1",passed:false,comparison:"incomplete",peerTerminal:"",peerTerminalRaw:"",client:{status:"failed",kind:"model_interface",code:error.code,message:error.message},binding:before}};}
  const observed:Transport={mode:transport.mode,send:line=>transport.send(line),close:()=>transport.close(),async *[Symbol.asyncIterator](){for await(const line of transport){const value=decodeMirrorMessage(line);if(value.proto_step==="all_steps_done"||value.proto_step==="step_mismatch"){terminal=value.proto_step;raw=line;}yield line;}}};
  if("ready"in transport)Object.defineProperty(observed,"ready",{value:transport.ready});
  try{const report=await runClientWithTracesNegotiatedWithReport(observed,config,traces,selection,options);client={status:"succeeded",report};}
  catch(error){failed=true;primary=error;client={status:"failed",message:message(error),kind:error instanceof ReplayMismatchError?"step_mismatch":"model_interface"};if(error instanceof Error&&"code"in error)client.code=error.code;if(error instanceof ReplayMismatchError){Object.assign(client,error.toJSON());client.orderedHints=error.hints.map(renderDiffHint);}const cleanup=replayCleanupFailure(error);if(cleanup!==undefined)client.cleanupError=message(cleanup);}
  const comparison=terminal==="step_mismatch"&&primary instanceof ReplayMismatchError?"step_mismatch":terminal==="all_steps_done"?"matched":"incomplete";
  const passed=!failed&&comparison==="matched"&&session.fullyCompleted();
  return{passed,...(failed?{error:primary}:{}),evidence:{schema:"mirrors.scheduled-comparison/v1",passed,comparison,peerTerminal:terminal,peerTerminalRaw:raw,client,binding:session.receipt()}};
}
