import {
  AsyncCompiledAdapterRegistry, runClientWithTracesNegotiatedWithReport,
  type AsyncAdapterFactory, type AsyncLocalBinding,
} from "./negotiated.js";
import { semanticDigestFromHex } from "./model-interface.js";
import {
  awaitReplayOperation, normalizeReplayDeadlines, ReplayCancelledError, ReplayDeadlineError, throwIfReplayCancelled,
  type ReplayContext,
} from "./async-replay.js";
import { ReplayMismatchError, replayCleanupFailure, type CompiledReplayReport } from "./replay-report.js";
import { spawnMirror, type Transport } from "./transport.js";
import { MatchedEvidenceError, MatchedEvidenceTracker } from "./matched-evidence.js";
import { acceptancePairKey, evaluateAcceptance, type SuiteEvidence } from "./acceptance.js";
import { preflightSuite, type SuitePreflight } from "./suite-preflight.js";
import { SuiteLifetime, SuiteTransportError } from "./suite-lifetime.js";
import { SuiteConfigurationError, type NativeSuiteAdapter, type SuiteDefinition } from "./suite-definition.js";
import type { SuiteFailure, SuiteResult } from "./suite-result.js";

export type SuiteMirrorTarget = string | Transport | (() => Transport | Promise<Transport>);
export interface SuiteTimeouts {
  readonly registrationMs: number;
  readonly actionMs: number;
  readonly receiveMs: number;
  readonly cleanupMs: number;
}
export const DEFAULT_SUITE_TIMEOUTS: SuiteTimeouts = Object.freeze({registrationMs:60_000,actionMs:10_000,receiveMs:60_000,cleanupMs:10_000});
export interface SuiteRunContext {
  readonly mirror: SuiteMirrorTarget;
  readonly signal?: AbortSignal;
  readonly timeouts?: Partial<SuiteTimeouts>;
}
export interface SuiteConstructionContext extends ReplayContext {
  /** Scope owns this obligation on success and failure; returned wrapper is safe to adopt. */
  deferCleanup(dispose: () => void | Promise<void>): () => Promise<void>;
}
export interface SuiteImplementation<Port> {
  readonly port: Port;
  /** The sole disposer transferred to this run; optional port.dispose is never invoked separately. */
  readonly dispose: () => void | Promise<void>;
}
export interface SuiteRunOptions<Port> extends SuiteRunContext {
  readonly implementation: (context: SuiteConstructionContext) => SuiteImplementation<Port> | Promise<SuiteImplementation<Port>>;
}
function emptyEvidence(traces: number): SuiteEvidence {
  return Object.freeze({schema:"mirrorecma.suite-evidence/v1",enteredReplay:false,complete:false,exact:true,
    tracesExpected:traces,tracesCompleted:0,initializationsMatched:"0",transitionsMatched:"0",
    actionCounts:Object.freeze({}),pairCounts:Object.freeze({})});
}
function evidenceFromTracker(tracker: MatchedEvidenceTracker | undefined, traces: number): SuiteEvidence {
  if (!tracker) return emptyEvidence(traces);
  const snapshot = tracker.snapshot();
  return Object.freeze({schema:"mirrorecma.suite-evidence/v1",enteredReplay:snapshot.replayEntered,
    complete:snapshot.corpusCompleted,exact:snapshot.exact,tracesExpected:snapshot.tracesSelected,
    tracesCompleted:snapshot.tracesCompleted,initializationsMatched:String(snapshot.initialStatesMatched),
    transitionsMatched:String(snapshot.transitionsMatched),
    actionCounts:Object.freeze(Object.fromEntries(snapshot.requiredActionCounts.map((a) => [a.id,String(a.count)]))),
    pairCounts:Object.freeze(Object.fromEntries(snapshot.requiredPairCounts.map((p) => [acceptancePairKey([p.from,p.to]),String(p.count)]))),
    ...(snapshot.uncertainty.length ? {failure:snapshot.uncertainty.join(",")} : {})});
}
function safeOwnString(value: unknown, key: string): string | undefined {
  try {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
    const property = Object.getOwnPropertyDescriptor(value,key);
    return property && "value" in property && typeof property.value === "string" ? property.value.slice(0,128) : undefined;
  } catch { return undefined; }
}
const operationErrors = new WeakSet<object>();
class SuiteOperationError extends Error {
  readonly code = "suite_implementation_failed";
  readonly sourceCode: string | undefined;
  constructor(cause: unknown) { super("implementation operation failed",{cause}); this.sourceCode = safeOwnString(cause,"code"); operationErrors.add(this); }
}
function safeOperation<T>(operation:()=>T|Promise<T>):Promise<T> {
  return Promise.resolve().then(operation).catch((cause:unknown)=>{
    // Generated observation errors retain a trusted implementation failure as
    // their cause; do not turn an observer rejection into codec invalidity.
    let current=cause;
    for(let depth=0;depth<8&&current!==null&&typeof current==="object";depth++){
      if(operationErrors.has(current))throw current;
      try {const property=Object.getOwnPropertyDescriptor(current,"cause");current=property&&"value"in property?property.value:undefined;}
      catch {break;}
    }
    throw new SuiteOperationError(cause);
  });
}
function failureFor(error: unknown, stage: SuiteFailure["stage"]): SuiteFailure {
  try {
    if (error instanceof ReplayMismatchError) return Object.freeze({stage:"replay",kind:"mismatch",code:"model_mismatch",message:"model rejected implementation observation",traceIndex:error.traceIndex,stateIndex:error.stepIndex});
    if (error instanceof ReplayCancelledError) return Object.freeze({stage,kind:"cancellation",code:error.code,message:"suite execution cancelled"});
    if (error instanceof ReplayDeadlineError) return Object.freeze({stage,kind:"timeout",code:error.code,message:`suite ${error.stage} deadline expired`});
    if (error instanceof MatchedEvidenceError) return Object.freeze({stage:"replay",kind:"evidence",code:error.code,message:"authoritative replay evidence is incomplete or inconsistent"});
    if (error instanceof SuiteConfigurationError || stage === "configuration") return Object.freeze({stage:"configuration",kind:"configuration",code:"suite_configuration_invalid",message:"suite preflight failed"});
    if (error instanceof SuiteTransportError) return Object.freeze({stage,kind:"transport",code:error.code,message:"owned model transport failed"});
    const code = safeOwnString(error,"code") ?? "unknown_failure";
    if (stage === "cleanup" || code === "adapter_dispose_failed" || code === "replay_cleanup_failed") return Object.freeze({stage:"cleanup",kind:"cleanup",code:"cleanup_failed",message:"suite cleanup failed"});
    if (error instanceof SuiteOperationError) {
      const codec = error.sourceCode === "input_shape_mismatch" || error.sourceCode === "observation_shape_mismatch";
      return Object.freeze({stage,kind:codec ? "codec" : "implementation",code:codec ? error.sourceCode! : error.code,message:"implementation operation failed"});
    }
    const negotiationCodes = new Set(["negotiation_missing","descriptor_schema_unsupported","descriptor_digest_invalid","negotiation_status_unexpected","interface_digest_mismatch","binding_digest_mismatch","binding_config_mismatch","model_interface_registration_failed"]);
    if (negotiationCodes.has(code)) return Object.freeze({stage:"negotiation",kind:"negotiation",code,message:"required model negotiation failed"});
    return Object.freeze({stage,kind:stage === "factory" || code === "adapter_factory_failed" ? "implementation" : "unknown",code,message:"suite operation failed"});
  } catch { return Object.freeze({stage,kind:"unknown",code:"unknown_failure",message:"suite operation failed"}); }
}
function normalizeTimeouts(input: Partial<SuiteTimeouts> | undefined): SuiteTimeouts {
  const result = {...DEFAULT_SUITE_TIMEOUTS,...input};
  for (const value of Object.values(result)) if (!Number.isSafeInteger(value) || value <= 0 || value > 0x7fffffff) throw new SuiteConfigurationError("invalid suite timeout");
  return Object.freeze(result);
}
/** Existing generic provider seam; the authority remains in trusted evaluator code. */
export async function runSuiteWithFactory<Port>(suite: SuiteDefinition<Port>, context: SuiteRunContext, factory: AsyncAdapterFactory): Promise<SuiteResult> {
  return executeSuite(suite, context, factory);
}
async function executeSuite<Port>(suite: SuiteDefinition<Port>, context: SuiteRunContext,
  factory: AsyncAdapterFactory | ((lifetime: SuiteLifetime) => AsyncAdapterFactory), local = false): Promise<SuiteResult> {
  let stage: SuiteFailure["stage"] = "configuration";
  let preflight: SuitePreflight | undefined;
  let tracker: MatchedEvidenceTracker | undefined;
  let lifetime = new SuiteLifetime(DEFAULT_SUITE_TIMEOUTS.cleanupMs);
  let report: CompiledReplayReport | undefined;
  let error: unknown;
  let failed = false;
  let connector: Promise<Transport> | undefined;
  const mirror = context.mirror;
  let owned: Transport | undefined = mirror !== null && typeof mirror === "object" ? mirror : undefined;
  let transportClosed = false;
  let factoryInvoked = false;
  try {
    const timeouts = normalizeTimeouts(context.timeouts);
    lifetime = new SuiteLifetime(timeouts.cleanupMs);
    throwIfReplayCancelled(context.signal);
    preflight = await preflightSuite(suite);
    tracker = new MatchedEvidenceTracker(suite.model.descriptor, {
      requiredActions:suite.acceptance.requiredActions ?? [],requiredPairs:suite.acceptance.requiredPairs ?? [],
    },preflight.stateCounts,{strictAcknowledgements:true,expectedActions:preflight.actions});
    const implementationFactory = local ? (factory as (l:SuiteLifetime)=>AsyncAdapterFactory)(lifetime) : factory as AsyncAdapterFactory;
    const trackedFactory: AsyncAdapterFactory = async (config,authority) => {
      stage = "factory";
      factoryInvoked = true;
      const binding = await lifetime!.track(safeOperation(() => implementationFactory(config,authority)));
      stage = "replay";
      return {
        semanticDigest:binding.semanticDigest,
        assertCompatibleConfig:config=>safeOperation(()=>binding.assertCompatibleConfig(config)),
        computer:(input,context)=>safeOperation(()=>binding.computer(input,context)),
        ...(binding.coverage ? {coverage:()=>safeOperation(()=>binding.coverage!())}:{}),
        dispose:()=>safeOperation(()=>binding.dispose()),
      };
    };
    const registry = new AsyncCompiledAdapterRegistry([{key:{semanticDigest:semanticDigestFromHex(suite.model.semanticDigest),adapterId:suite.adapterId,
      targetProfile:suite.model.targetProfile,stateComputerContractVersion:suite.model.stateComputerContractVersion},factory:trackedFactory}]);
    stage = "negotiation";
    let target: string | Transport;
    throwIfReplayCancelled(context.signal);
    if (typeof mirror === "function") {
      connector = Promise.resolve().then(() => { throwIfReplayCancelled(context.signal); return mirror(); }).catch(cause=>{throw new SuiteTransportError(cause);});
      try { owned = await awaitReplayOperation(connector,context.signal,timeouts.registrationMs,"registration"); }
      catch (cause) {
        const lateClose = connector.then((transport) => transport.close(), () => undefined);
        lifetime.track(lateClose);
        lateClose.catch(() => { lifetime!.cleanupFailed = true; });
        throw cause;
      }
      target = owned;
    } else if (typeof mirror === "string") {
      try { owned=spawnMirror(mirror); target=owned; }
      catch(cause) { throw new SuiteTransportError(cause); }
    } else target = mirror;
    if (typeof target !== "string") {
      owned = target;
      const transport = target;
      let closing: Promise<number> | undefined;
      target = {send:line=>{try{transport.send(line);}catch(cause){throw new SuiteTransportError(cause);}},close:()=>{
        transportClosed = true;
        return closing ??= Promise.resolve().then(()=>transport.close());
      },[Symbol.asyncIterator]:()=>{
        let iterator:AsyncIterator<string>;
        try{iterator=transport[Symbol.asyncIterator]();}catch(cause){throw new SuiteTransportError(cause);}
        return {next:async()=>{
          try {const result=await iterator.next();if(result.done)throw new Error("model connection ended before terminal reply");return result;}
          catch(cause){throw new SuiteTransportError(cause);}
        }};
      }};
      const ready=Promise.resolve().then(()=>"ready" in transport?(transport as Transport & {ready?:Promise<void>}).ready:undefined)
        .catch(cause=>{throw new SuiteTransportError(cause);});
      void ready.catch(()=>{});
      Object.defineProperty(target,"ready",{value:ready});
    }
    report = await runClientWithTracesNegotiatedWithReport(target,suite.replay.config,preflight.serverPaths,{
      execution:"async",metadata:suite.model.metadata,adapterId:suite.adapterId,targetProfile:suite.model.targetProfile,
      stateComputerContractVersion:suite.model.stateComputerContractVersion,registry,policy:"require",
    },{signal:context.signal,deadlines:normalizeReplayDeadlines({registrationMs:timeouts.registrationMs,stepMs:timeouts.actionMs,receiveMs:timeouts.receiveMs}),matchedEvidence:tracker,suiteLifetime:lifetime});
  } catch (cause) { error = cause; failed = true; }
  if (lifetime) {
    lifetime.startCleanup();
    if (owned && !transportClosed) {
      try { await lifetime.wait(Promise.resolve().then(()=>owned!.close())); }
      catch (cause) { lifetime.cleanupFailed = true; lifetime.unconfirmed ||= cause instanceof ReplayDeadlineError; }
    }
    await lifetime.join();
  }
  const evidence = evidenceFromTracker(tracker,suite.replay.traces.length);
  const acceptance = evaluateAcceptance(suite.acceptance,evidence);
  const cleanupFailure = lifetime?.cleanupFailed || replayCleanupFailure(error) !== undefined;
  const cleanup = Object.freeze({scope:"local" as const,status:lifetime?.unconfirmed ? "unconfirmed" as const : cleanupFailure ? "failed" as const : "succeeded" as const,
    quiescence:lifetime?.unconfirmed ? "unconfirmed" as const : "confirmed" as const});
  let failure = failed ? failureFor(error,stage) : undefined;
  // Cooperative generic providers may hide operation settlement; a timed out provider cannot prove local quiescence.
  const joinedCleanup = !local && (failure?.kind === "timeout" || failure?.kind === "cancellation") && (stage as SuiteFailure["stage"]) === "replay"
    ? Object.freeze({...cleanup,quiescence:"unconfirmed" as const,status:cleanup.status === "succeeded" ? "unconfirmed" as const : cleanup.status}) : cleanup;
  const effectiveCleanup = Object.freeze({...joinedCleanup,bindingStatus:factoryInvoked ? joinedCleanup.status : "not_started" as const});
  const conformance = failure?.kind === "mismatch" ? "mismatch" : evidence.complete ? "matched" : evidence.enteredReplay ? "incomplete" : "not_evaluated";
  if (!failure && acceptance.status === "unmet") failure = Object.freeze({stage:"acceptance",kind:"acceptance",code:"coverage_unmet",message:"matched corpus did not satisfy required coverage"});
  if (!failure && acceptance.status !== "met") failure = Object.freeze({stage:"acceptance",kind:"evidence",code:"evidence_incomplete",message:"suite acceptance evidence is incomplete"});
  if (!failure && effectiveCleanup.status !== "succeeded") failure = Object.freeze({stage:"cleanup",kind:"cleanup",code:"cleanup_unconfirmed",message:"local cleanup did not complete successfully"});
  const outcome = failure?.kind === "mismatch" ? "mismatch" : failure?.kind === "cancellation" ? "cancelled" : failure?.kind === "timeout" ? "timedOut" : failure ? "failed" : "passed";
  const result: SuiteResult = {schema:"mirrorecma.suite-result/v1",suiteId:suite.id,outcome,conformance,acceptance,cleanup:effectiveCleanup,
    identities:Object.freeze({interfaceDigest:suite.model.semanticDigest,...(preflight ? {modelDigest:preflight.modelDigest,corpusDigest:preflight.corpusDigest}: {})}),
    evidence,...(report ? {report}:{}),...(failure ? {failure}:{})};
  if (failed) Object.defineProperty(result,"trustedError",{value:error,enumerable:false});
  return Object.freeze(result);
}
/** Local application imports and allocation happen only inside this deferred factory. */
export async function runSuite<Port>(suite: SuiteDefinition<Port>, options: SuiteRunOptions<Port>): Promise<SuiteResult> {
  return executeSuite(suite,options,(lifetime:SuiteLifetime):AsyncAdapterFactory=>async (config,authority)=>{
    const partial: (()=>Promise<void>)[] = [];
    const registered = new Map<()=>void|Promise<void>,()=>Promise<void>>();
    let transferred = false;
    let implementation: SuiteImplementation<Port> | undefined;
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      const errors: unknown[] = [];
      if (implementation) {
        try { await (registered.get(implementation.dispose) ?? (()=>implementation!.dispose()))(); }
        catch (cause) { errors.push(cause); }
      }
      for (const cleanup of [...partial].reverse()) { try { await cleanup(); } catch (cause) { errors.push(cause); } }
      if (errors.length) throw new AggregateError(errors,"construction scope cleanup failed");
    };
    try {
      const constructed = await options.implementation(Object.freeze({...authority.context,deferCleanup:(cleanup:()=>void|Promise<void>)=>{
        if (transferred || disposed) throw new Error("construction scope closed");
        if (typeof cleanup !== "function") throw new TypeError("cleanup must be a function");
        let once=registered.get(cleanup);
        if(!once){let pending:Promise<void>|undefined;once=()=>pending??=Promise.resolve().then(cleanup);registered.set(cleanup,once);partial.push(once);}
        return once;
      }}));
      if (!constructed || typeof constructed.dispose !== "function") throw new TypeError("implementation must transfer a disposer");
      implementation = constructed;
      const source = implementation.port as NativeSuiteAdapter;
      const invoke = <T>(operation:()=>T|Promise<T>):Promise<T> => {
        if (lifetime.sealed) return Promise.reject(new Error("suite operation scope closed"));
        return lifetime.track(safeOperation(operation));
      };
      const actions = Object.fromEntries(Object.entries(source.actions ?? {}).map(([id,handler])=>[id,(inputs:Readonly<Record<string,unknown>>,context:ReplayContext)=>invoke(()=>handler.call(source.actions,inputs,context))]));
      const port = {...source,actions,observe:(context:ReplayContext)=>invoke(()=>source.observe(context))} as Port;
      const bound = suite.model.bindLocal(port,config);
      transferred = true;
      const binding: AsyncLocalBinding = {...bound,semanticDigest:semanticDigestFromHex(suite.model.semanticDigest),dispose};
      return binding;
    } catch (cause) {
      try { await dispose(); } catch (cleanup) { lifetime.cleanupFailed = true; throw new AggregateError([cause,cleanup],"factory and partial cleanup failed"); }
      throw cause;
    }
  },true);
}
