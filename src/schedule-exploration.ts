import { performance } from "node:perf_hooks";
import { decodeMirrorMessage, type State, type Value } from "./protocol.js";
import { runWorkerSchedule, parseCheckpointSchedule, WORKER_SCHEDULE_PROFILE, SCHEDULE_SCHEMA, SCHEDULE_COMPLETION, type CheckpointSchedule, type ScheduleActor, type ScheduleExecution, type ScheduleIdentity, type ScheduleJson, type SchedulePolicy, type ScheduleStep, type WorkerScheduleAdapter } from "./schedule.js";
import { scheduleData, scheduleIdentifier } from "./schedule-data.js";
import type { ScheduledReplayResult } from "./schedule-binding.js";
export const WORKER_EXPLORATION_PROFILE="mirrorecma.finite-checkpoint-exploration/v1";
export interface ScheduleActorChain {readonly actor:ScheduleActor;readonly checkpoints:readonly string[]}
export interface FiniteScheduleSpace {readonly identity:ScheduleIdentity;readonly actors:readonly ScheduleActorChain[];readonly inputs:readonly ScheduleJson[];readonly maxPreemptions:number;readonly requireModelComparison?:boolean;readonly baseVariables:readonly string[];readonly instrumentationVariables:readonly string[]}
export interface ScheduleExplorationLimits {readonly maxEnumeratedSchedules?:number;readonly maxRuns?:number;readonly timeBudgetMs?:number;readonly maxEvidenceBytes?:number}
export interface ScheduleExplorationSample {readonly execution:ScheduleJson;readonly comparison?:Record<string,unknown>}
export type ScheduleExplorationRunner=(schedule:CheckpointSchedule,signal?:AbortSignal)=>ScheduleExplorationSample|Promise<ScheduleExplorationSample>;
export interface LocalWorkerExplorationRunner extends ScheduleExplorationRunner {lastExecution?:ScheduleExecution}
function requireValue(condition:unknown,message:string):asserts condition{if(!condition)throw new Error(message);}
function object(value:unknown):Record<string,unknown>{requireValue(value&&typeof value==="object"&&!Array.isArray(value),"expected evidence object");return value as Record<string,unknown>;}
function array(value:unknown):unknown[]{requireValue(Array.isArray(value),"expected evidence array");return value;}
const utf8=(a:string,b:string)=>Buffer.compare(Buffer.from(a),Buffer.from(b));
const stable=(value:unknown):string=>{
 const tag=(v:unknown):unknown=>v===null?["null"]:Array.isArray(v)?["array",v.map(tag)]:typeof v==="object"?["object",Object.keys(v).sort(utf8).map(k=>[k,tag((v as Record<string,unknown>)[k])])]:[typeof v,v];
 return JSON.stringify(tag(value));
};
function canonicalValue(value:Value,depth:number,count:{nodes:number}):unknown{
 requireValue(depth<=32&&++count.nodes<=65_536,"canonical value exceeds structure bound");
 switch(value.tag){
  case"null":return["null"];case"int":return["integer",value.val.toString()];case"bool":return["boolean",value.val];case"str":return["string",value.val];case"unserializable":return["unserializable",value.val];
  case"variant":return["variant",value.variantTag,canonicalValue(value.value,depth+1,count)];
  case"record":return["record",Object.keys(value.val).sort(utf8).map(k=>[k,canonicalValue(value.val[k]!,depth+1,count)])];
  case"seq":case"tuple":return[value.tag==="seq"?"sequence":"tuple",value.val.map(v=>canonicalValue(v,depth+1,count))];
  case"set":{const unique=new Map<string,unknown>();for(const v of value.val){const item=canonicalValue(v,depth+1,count);unique.set(JSON.stringify(item),item);}return["set",[...unique.keys()].sort(utf8).map(k=>unique.get(k))];}
  case"map":{const entries=new Map<string,unknown>();let kind:string|undefined;for(const[k,v]of value.val){requireValue(k.tag==="str"||k.tag==="int","unsupported canonical map key");requireValue(kind===undefined||kind===k.tag,"mixed canonical map keys");kind=k.tag;const key=canonicalValue(k,depth+1,count),id=JSON.stringify(key);requireValue(!entries.has(id),"duplicate canonical map key");entries.set(id,[key,canonicalValue(v,depth+1,count)]);}return["map",[...entries.keys()].sort(utf8).map(k=>entries.get(k))];}
 }
}
export function canonicalScheduleState(state:State):string{const count={nodes:0},value=["mirrors.canonical-state/v1",Object.keys(state).sort(utf8).map(k=>[k,canonicalValue(state[k]!,0,count)])];const text=JSON.stringify(value);requireValue(Buffer.byteLength(text)<=1_048_576,"canonical state exceeds byte bound");return text;}
export function localWorkerExplorationRunner(adapter:WorkerScheduleAdapter,policy:SchedulePolicy={}):LocalWorkerExplorationRunner{
 const runner:LocalWorkerExplorationRunner=async(schedule,signal)=>{requireValue(runner.lastExecution?.report().cleanup!=="incomplete","previous execution still owns workers");runner.lastExecution=await runWorkerSchedule(schedule,adapter,policy,signal);return{execution:runner.lastExecution.receipt()};};return runner;
}
export function scheduledComparisonSample(result:ScheduledReplayResult):ScheduleExplorationSample{const records=array(object(result.evidence.binding).executions);requireValue(records.length===1,"exploration comparison requires one execution");return{execution:records[0] as ScheduleJson,comparison:result.evidence};}
function validateSuccess(e:Record<string,unknown>,schedule:CheckpointSchedule):void{
 requireValue(e.scheduleCompleted===true&&e.outcome==="completed","false completed schedule");const events=array(e.events);requireValue(events.length===schedule.steps.length*2,"wrong event denominator");
 for(let i=0;i<schedule.steps.length;i++)for(let offset=0;offset<2;offset++){const event=object(events[i*2+offset]);requireValue(event.ordinal===i*2+offset&&event.step===i&&event.actor===schedule.steps[i]!.actor&&event.kind===(offset===0?"permit":"arrival"),"event identity/order differs");if(offset===1)requireValue(event.checkpoint===schedule.steps[i]!.checkpoint,"arrival differs");}
 requireValue(array(e.observations).length===schedule.steps.length+1,"wrong observation denominator");
}
function category(e:Record<string,unknown>,comparison:Record<string,unknown>|undefined):string{
 let mismatch=false,comparisonFailed=false;
 if(comparison){requireValue(comparison.schema==="mirrors.scheduled-comparison/v1"&&stable(object(comparison.binding).executions)===stable([e]),"comparison not bound to exact execution");if(comparison.comparison==="step_mismatch"){requireValue(comparison.peerTerminal==="step_mismatch"&&comparison.passed===false&&object(comparison.client).kind==="step_mismatch","invalid mismatch evidence");mismatch=true;}else comparisonFailed=comparison.comparison!=="matched"||comparison.passed!==true;}
 if(e.cleanup!=="confirmed"||array(e.remainingActors).length!==0)return"cleanup_failed";
 if(mismatch)return"model_mismatch";if(comparisonFailed)return"comparison_failed";
 if(e.passed===true)return"passed";if(e.outcome==="timed_out")return"timed_out";if(e.outcome==="cancelled")return"cancelled";if(["unexpected_checkpoint","invalid_schedule","incompatible_identity"].includes(String(e.outcome)))return"schedule_failed";return"execution_failed";
}
export async function exploreFiniteSchedules(space:FiniteScheduleSpace,runner:ScheduleExplorationRunner,limits:ScheduleExplorationLimits={},signal?:AbortSignal):Promise<Record<string,unknown>>{
 const start=performance.now(),result:Record<string,unknown>={schema:"mirrors.finite-exploration/v1",profile:WORKER_EXPLORATION_PROFILE,complete:false,enumerationExhausted:false,denominatorKnown:false,eligibleRuns:null,attemptedRuns:0,completedRuns:0,runs:[],states:[],transitions:[],categories:Object.create(null),firstCounterexample:null,firstFailure:null,por:"disabled",projection:{baseVariables:space.baseVariables,instrumentationVariables:space.instrumentationVariables},comparison:"not_requested",comparisonRequired:space.requireModelComparison??false,comparisonRuns:0};
 try{
  const maxEnumerated=limits.maxEnumeratedSchedules??4096,maxRuns=limits.maxRuns??4096,time=limits.timeBudgetMs??30_000,maxEvidence=limits.maxEvidenceBytes??16*1_048_576;
  requireValue(typeof runner==="function"&&space.actors.length>0&&space.actors.length<=8&&space.inputs.length>0&&space.inputs.length<=64,"finite actor/input bound exceeded");
  requireValue([maxEnumerated,maxRuns,time,maxEvidence,space.maxPreemptions].every(Number.isSafeInteger)&&maxEnumerated>0&&maxEnumerated<=4096&&maxRuns>=0&&maxRuns<=65_536&&time>0&&time<=86_400_000&&maxEvidence>0&&maxEvidence<=64*1_048_576&&space.maxPreemptions>=0&&space.maxPreemptions<=64,"invalid exploration limits");
  const actors=[...space.actors].sort((a,b)=>utf8(a.actor.actor,b.actor.actor)),declarations=new Map<string,string>(),operations=new Set<string>(),checkSteps:ScheduleStep[]=[];
  for(const a of actors){requireValue(scheduleIdentifier(a.actor.actor)&&scheduleIdentifier(a.actor.operation)&&!declarations.has(a.actor.actor)&&!operations.has(a.actor.operation),"duplicate/invalid exploration actor");declarations.set(a.actor.actor,a.actor.operation);operations.add(a.actor.operation);requireValue(a.checkpoints.length>0&&a.checkpoints.at(-1)===SCHEDULE_COMPLETION,"chain requires terminal completion");for(let i=0;i<a.checkpoints.length;i++){const c=a.checkpoints[i]!;requireValue(i+1===a.checkpoints.length?c===SCHEDULE_COMPLETION:scheduleIdentifier(c),"invalid actor chain");checkSteps.push({actor:a.actor.actor,checkpoint:c});}}
  requireValue(checkSteps.length<=64,"exploration step bound exceeded");const inputs=new Set<string>();for(const input of space.inputs){scheduleData(input);parseCheckpointSchedule(JSON.stringify({schema:SCHEDULE_SCHEMA,profile:WORKER_SCHEDULE_PROFILE,identity:space.identity,inputs:input,steps:checkSteps}));const key=stable(input);requireValue(!inputs.has(key),"duplicate finite input");inputs.add(key);}
  const variables=new Set<string>(),ignored=new Set<string>();requireValue(space.baseVariables.length>0&&space.baseVariables.length<=1024&&space.instrumentationVariables.length<=1024,"bounded base variables required");for(const v of space.baseVariables){requireValue(scheduleIdentifier(v)&&!variables.has(v),"invalid base variable");variables.add(v);}for(const v of space.instrumentationVariables){requireValue(scheduleIdentifier(v)&&!variables.has(v)&&!ignored.has(v),"invalid instrumentation projection");ignored.add(v);}
  const deadline=start+time,shapes:ScheduleStep[][]=[],positions=actors.map(()=>0),current:ScheduleStep[]=[];let exhausted=true,stopReason="";
  const visit=(prior:number|undefined,preemptions:number):void=>{
   if(!exhausted)return;if(signal?.aborted||performance.now()>=deadline){exhausted=false;stopReason=signal?.aborted?"cancelled":"time_budget";return;}
   if(current.length===checkSteps.length){if(shapes.length===maxEnumerated){exhausted=false;stopReason="enumeration_limit";}else shapes.push([...current]);return;}
   for(let i=0;i<actors.length;i++){if(positions[i]===actors[i]!.checkpoints.length)continue;const extra=prior!==undefined&&prior!==i&&positions[prior]!<actors[prior]!.checkpoints.length?1:0;if(preemptions+extra>space.maxPreemptions)continue;const at=positions[i]!;positions[i]++;current.push({actor:actors[i]!.actor.actor,checkpoint:actors[i]!.checkpoints[at]!});visit(i,preemptions+extra);current.pop();positions[i]--;if(!exhausted)return;}
  };visit(undefined,0);
  const eligible=shapes.length*space.inputs.length;Object.assign(result,{denominatorKnown:exhausted,enumeratedScheduleShapes:shapes.length,inputAssignments:space.inputs.length,maxPreemptions:space.maxPreemptions,declaredInputs:space.inputs,eligibleRunsLowerBound:eligible,eligibleRuns:exhausted?eligible:null,limits:{maxEnumeratedSchedules:maxEnumerated,maxRuns,timeBudgetMs:time,maxEvidenceBytes:maxEvidence}});
  let attempted=0,completed=0,evidenceBytes=0,coverageBytes=0,comparisonRuns=0,halt=false;const states=new Map<string,number>(),edges=new Map<string,{from:number;to:number;count:number}>(),ids=new Set<string>();
  outer:for(const steps of shapes)for(let inputIndex=0;inputIndex<space.inputs.length;inputIndex++){
   if(signal?.aborted||performance.now()>=deadline||attempted>=maxRuns){stopReason=signal?.aborted?"cancelled":performance.now()>=deadline?"time_budget":"run_limit";halt=true;break outer;}
   const candidate:CheckpointSchedule=parseCheckpointSchedule(JSON.stringify({schema:SCHEDULE_SCHEMA,profile:WORKER_SCHEDULE_PROFILE,identity:space.identity,inputs:space.inputs[inputIndex]!,steps}));
   const row:Record<string,unknown>={ordinal:attempted,inputIndex,schedule:candidate};attempted++;let disposition:string,cleanupKnown=false;
   try{
    const returned=await runner(candidate,signal);const sample:ScheduleExplorationSample={execution:scheduleData(returned.execution,64*1_048_576),...(returned.comparison?{comparison:object(scheduleData(returned.comparison,64*1_048_576))}:{})};const e=object(sample.execution);row.execution=e;if(sample.comparison)row.comparison=sample.comparison;
    requireValue(e.schema==="mirrors.checkpoint-execution/v1"&&stable(e.schedule)===stable(candidate),"execution not bound to exact candidate");
    const actual=new Map<string,string>();for(const item of array(e.actors)){const a=object(item);requireValue(Object.keys(a).length===2&&typeof a.actor==="string"&&typeof a.operation==="string"&&!actual.has(a.actor),"invalid execution actor");actual.set(a.actor,a.operation);}requireValue(actual.size===declarations.size&&[...declarations].every(([a,o])=>actual.get(a)===o),"execution actor declarations differ");
    requireValue(typeof e.executionId==="string"&&/^[0-9a-f]{32}$/.test(e.executionId)&&!ids.has(e.executionId),"stale/invalid execution id");ids.add(e.executionId);
    cleanupKnown=e.cleanup==="confirmed"&&array(e.remainingActors).length===0;disposition=category(e,sample.comparison);
    if(sample.comparison?.comparison==="step_mismatch"&&result.firstCounterexample===null)result.firstCounterexample={ordinal:attempted-1,category:"model_mismatch",schedule:candidate};
    if(space.requireModelComparison&&!sample.comparison)disposition="comparison_missing";
    if(sample.comparison){comparisonRuns++;result.comparison="requested";}
    if(disposition==="passed"){
     validateSuccess(e,candidate);let prior:number|undefined;
     for(const[index,item]of array(e.observations).entries()){
      const observation=object(item);requireValue(observation.afterSteps===index,"observation position differs");object(observation.state);
      const decoded=decodeMirrorMessage(JSON.stringify({proto_step:"initial_state",action:"init",state:observation.state}));requireValue(decoded.proto_step==="initial_state","observation state decode failed");const state=decoded.state;
      requireValue(Object.keys(state).length===variables.size+ignored.size,"projection omits/adds variables");for(const key of ignored){requireValue(Object.hasOwn(state,key),"instrumentation variable absent");delete state[key];}for(const key of variables)requireValue(Object.hasOwn(state,key),"base variable absent");
      const key=canonicalScheduleState(state);let id=states.get(key);if(id===undefined){coverageBytes+=Buffer.byteLength(key)+128;requireValue(coverageBytes<=8*1_048_576,"coverage byte bound exceeded");id=states.size;states.set(key,id);array(result.states).push({id,canonical:JSON.parse(key)});}
      if(prior!==undefined){const key=prior+":"+id,edge=edges.get(key);if(edge)edge.count++;else{coverageBytes+=128;requireValue(coverageBytes<=8*1_048_576,"coverage byte bound exceeded");edges.set(key,{from:prior,to:id,count:1});}}prior=id;
     }completed++;
    }else if(disposition==="model_mismatch"&&result.firstCounterexample===null)result.firstCounterexample={ordinal:attempted-1,category:disposition,schedule:candidate};
   }catch(error){disposition="runner_or_evidence_failed";const text=error instanceof Error?error.message:String(error);row.error=text.slice(0,1024);if(text==="coverage byte bound exceeded"){stopReason="coverage_limit";halt=true;}}
   row.category=disposition;if(disposition!=="passed"&&result.firstFailure===null)result.firstFailure={ordinal:attempted-1,category:disposition,schedule:candidate};const categories=object(result.categories);categories[disposition]=Number(categories[disposition]??0)+1;
   const bytes=Buffer.byteLength(JSON.stringify(row));if(evidenceBytes+bytes>maxEvidence){array(result.runs).push({ordinal:attempted-1,category:disposition,evidenceOmitted:"byte_budget"});stopReason="evidence_limit";halt=true;break outer;}evidenceBytes+=bytes;array(result.runs).push(row);
   if(halt)break outer;if(!cleanupKnown){stopReason="unconfirmed_cleanup";halt=true;break outer;}if(performance.now()>=deadline){stopReason="time_budget";halt=true;break outer;}
  }
  const enumerationExhausted=exhausted&&attempted===eligible,complete=enumerationExhausted&&completed===eligible&&!halt;
  Object.assign(result,{transitions:[...edges.values()].sort((a,b)=>a.from-b.from||a.to-b.to),comparisonRuns,attemptedRuns:attempted,completedRuns:completed,enumerationExhausted,complete,stopReason:stopReason||(complete?"complete":"non_pass_runs"),status:complete?"complete":"incomplete"});
 }catch(error){Object.assign(result,{status:"invalid_declaration",stopReason:"invalid_declaration",error:(error instanceof Error?error.message:String(error)).slice(0,1024)});}
 result.elapsedMs=Math.floor(performance.now()-start);return result;
}
