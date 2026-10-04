/** Bounded inert scheduling artifacts; independent of the wire Value codec. */
export type ScheduleJson = null | boolean | number | string | readonly ScheduleJson[] | { readonly [key: string]: ScheduleJson };
export const SCHEDULE_SCHEMA = "mirrors.checkpoint-schedule/v1";
export const WORKER_SCHEDULE_PROFILE = "mirrorecma.worker-checkpoints/v1";
export const SCHEDULE_COMPLETION = "$done";
export interface ScheduleIdentity { readonly modelSemanticDigest: string; readonly mappingSha256: string; readonly implementationSha256: string }
export interface ScheduleStep { readonly actor: string; readonly checkpoint: string }
export interface CheckpointSchedule { readonly schema: typeof SCHEDULE_SCHEMA; readonly profile: typeof WORKER_SCHEDULE_PROFILE; readonly identity: ScheduleIdentity; readonly inputs: ScheduleJson; readonly steps: readonly ScheduleStep[] }
export interface ScheduleActor { readonly actor: string; readonly operation: string }
export function scheduleIdentifier(v: unknown): v is string { return typeof v === "string" && /^[A-Za-z0-9_./-]{1,128}$/.test(v); }
export function scheduleDigest(v: unknown): v is string { return typeof v === "string" && /^[0-9a-f]{64}$/.test(v); }
export function scheduleExact(v: unknown, keys: readonly string[]): asserts v is Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v,k))) throw new Error("unknown or missing schedule fields");
}
export function scheduleData(value: unknown, maxBytes = 65_535): ScheduleJson {
  let nodes = 0;
  const visit = (v: unknown, depth: number): void => {
    if (depth > 28 || ++nodes > 100_000) throw new Error("schedule data structure exceeds bound");
    if (v === null || typeof v === "string" || typeof v === "boolean") return;
    if (typeof v === "number" && Number.isFinite(v)) return;
    if (!v || typeof v !== "object") throw new Error("schedule data must be plain JSON");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new Error("schedule data must be inert");
    for (const key of Reflect.ownKeys(v)) {
      if (typeof key !== "string") throw new Error("symbol schedule field");
      if (Array.isArray(v) && key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(v,key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) throw new Error("non-data schedule property");
      if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) throw new Error("extra array field");
      visit(descriptor.value,depth+1);
    }
    if (Array.isArray(v) && Object.keys(v).length !== v.length) throw new Error("sparse schedule array");
  };
  visit(value,0); const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) throw new Error("schedule data exceeds byte bound");
  return JSON.parse(text) as ScheduleJson;
}
export function freezeScheduleData<T>(value: T): T {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeScheduleData(child); Object.freeze(value); }
  return value;
}
/** JSON duplicate detection before conversion, including nested input records. */
export function parseCheckpointSchedule(text: string): CheckpointSchedule {
  if (Buffer.byteLength(text) > 8*1_048_576) throw new Error("schedule artifact exceeds byte bound");
  let i=0, nodes=0;
  const ws=()=>{while(/[\x20\x09\x0a\x0d]/.test(text[i]??"")) i++;};
  const token=():string=>{ const start=i++; for(;i<text.length;i++) { if(text[i]==="\\") {i++;continue;} if(text[i]==='"') return JSON.parse(text.slice(start,++i)) as string; } throw new Error("unterminated JSON string"); };
  const scan=(depth:number):void=>{
    if(depth>32 || ++nodes>600_000) throw new Error("schedule JSON structure limit"); ws();
    if(text[i]==='"'){token();return;}
    if(text[i]==='{' || text[i]==='['){const object=text[i++]==='{', end=object?'}':']', keys=new Set<string>();ws();if(text[i]===end){i++;return;}
      while(i<text.length){if(object){if(text[i]!=='"')throw new Error("invalid JSON object");const key=token();if(keys.has(key))throw new Error("duplicate schedule JSON key");keys.add(key);ws();if(text[i++]!==':')throw new Error("missing JSON colon");}scan(depth+1);ws();if(text[i]===end){i++;return;}if(text[i++]!==',')throw new Error("invalid JSON separator");ws();}throw new Error("unterminated JSON structure");}
    const match=/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));if(!match)throw new Error("invalid JSON value");i+=match[0].length;
  };
  scan(0);ws();if(i!==text.length)throw new Error("trailing JSON data");const v:unknown=JSON.parse(text);
  scheduleExact(v,["schema","profile","identity","inputs","steps"]);scheduleExact(v.identity,["modelSemanticDigest","mappingSha256","implementationSha256"]);
  if(v.schema!==SCHEDULE_SCHEMA || v.profile!==WORKER_SCHEDULE_PROFILE || !Object.values(v.identity).every(scheduleDigest) || !Array.isArray(v.steps) || v.steps.length>65_536)throw new Error("invalid schedule schema/profile/identity/steps");
  for(const step of v.steps){scheduleExact(step,["actor","checkpoint"]);if(!scheduleIdentifier(step.actor)||(!scheduleIdentifier(step.checkpoint)&&step.checkpoint!==SCHEDULE_COMPLETION))throw new Error("invalid schedule identifier");}
  scheduleData(v.inputs);return freezeScheduleData(v as unknown as CheckpointSchedule);
}
