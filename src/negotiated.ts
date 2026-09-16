import type { MatchedEvidenceTracker } from "./matched-evidence.js";
import { spawnMirror, type Transport } from "./transport.js";
import {
  type ApalacheConfig,
  type ApalacheSpec,
  type Register,
  type RegisterTraces,
  type TraceGenerationConfig,
} from "./protocol.js";
import {
  createDescriptorRequest,
  createVerifyRequest,
  encodeModelInterfaceRegistration,
  semanticDigestFromHex,
  type ContractV1,
  type GeneratedModelInterface,
  type ModelInterfaceReply,
  type ModelInterfaceRequest,
  type NegotiationPolicy,
  type SemanticDigest,
  type SemanticDescriptor,
} from "./model-interface.js";
import { DescriptorCache, DescriptorCacheError } from "./descriptor-cache.js";
import {
  bindDynamicDescriptor,
  bindAsyncDynamicDescriptor,
  type AsyncDynamicHandlerRegistry,
  type DynamicHandlerRegistry,
} from "./dynamic-binding.js";
import {
  replayCore,
  asynchronousReplayExecution,
  synchronousReplayExecution,
  receiveReplayMessage,
} from "./replay-core.js";
import {
  AsyncCompiledAdapterRegistry,
  CompiledAdapterRegistry,
  NegotiatedRunnerError,
  runnerError,
  type CallbackLocalBinding,
  type AdapterFactory,
  type AsyncAdapterFactory,
  type AsyncCompiledAdapterRegistration,
  type AsyncLocalBinding,
  type CompiledAdapterKey,
  type CompiledAdapterRegistration,
  type LocalBinding,
  type NegotiatedRunnerErrorCode,
} from "./adapter-registry.js";
import {
  ModelInterfaceRegistrationError,
  createAsyncNegotiationAuthority,
  receiveNegotiatedFirstReply,
} from "./negotiation-core.js";
import {
  awaitReplayOperation,
  normalizeReplayDeadlines,
  ReplayCancelledError,
  ReplayDeadlineError,
  throwIfReplayCancelled,
  type ReplayDeadlines,
} from "./async-replay.js";
import {
  normalizeReplayFailure,
  ReplayCleanupError,
  replayReport,
  retainReplayCleanupFailure,
  type CompiledReplayReport,
} from "./replay-report.js";
import { replayLoop, receiveLine } from "./replay.js";
import { ReplayControl, validateReplayOptions, type ReplayOptions } from "./replay-control.js";
import { attachReplayReport, failedReplayReport, ReplayRecorder, type ReplayReport } from "./replay-report.js";

export const MIRRORECMA_TARGET_PROFILE = "mirrorecma-v1" as const;
export const STATE_COMPUTER_CONTRACT_VERSION = "mirrors.state-computer/v1" as const;
export const ASYNC_STATE_COMPUTER_CONTRACT_VERSION = "mirrors.async-state-computer/v1" as const;
export const MIRRORECMA_ASYNC_TARGET_PROFILE = "mirrorecma-async-v1" as const;


export {
  AsyncCompiledAdapterRegistry,
  CompiledAdapterRegistry,
  ModelInterfaceRegistrationError,
  NegotiatedRunnerError,
};
export type {
  AdapterFactory,
  CallbackLocalBinding,
  AsyncAdapterFactory,
  AsyncCompiledAdapterRegistration,
  AsyncLocalBinding,
  CompiledAdapterKey,
  CompiledAdapterRegistration,
  LocalBinding,
  NegotiatedRunnerErrorCode,
};
export type {
  AsyncNegotiationAuthority,
  AsyncNegotiationWitness,
} from "./negotiation-core.js";

function sameDigest(a: SemanticDigest, b: SemanticDigest): boolean {
  return a === b;
}

export interface CompiledAdapterSelection<B extends CallbackLocalBinding = CallbackLocalBinding> {
  readonly mode?: "compiled";
  readonly request?: "verify";
  readonly metadata: GeneratedModelInterface;
  readonly adapterId: string;
  readonly targetProfile: string;
  readonly stateComputerContractVersion: string;
  readonly registry: CompiledAdapterRegistry<B>;
  readonly policy?: NegotiationPolicy;
  /**
   * Explicit opt-in for an old server or an `unsupported`/`unavailable`
   * preferred reply. Invoked only after that outcome is authenticated and
   * always returns a fresh, disposable binding.
   */
  readonly fallbackFactory?: AdapterFactory<B>;
}

/** Development-oriented descriptor mode backed only by caller-local handlers. */
export interface DynamicHandlerSelection {
  readonly mode: "dynamic";
  readonly request?: "descriptor";
  readonly contract: ContractV1;
  readonly registry: DynamicHandlerRegistry;
  readonly descriptorCache: DescriptorCache;
  readonly policy?: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory<CallbackLocalBinding>;
  readonly dispose?: () => void | Promise<void>;
}

export type DynamicRegistryScope =
  | {
    readonly execution?: "sync";
    readonly registry: DynamicHandlerRegistry;
    readonly dispose?: () => void | Promise<void>;
  }
  | {
    readonly execution: "async";
    readonly registry: AsyncDynamicHandlerRegistry;
    readonly dispose?: () => void | Promise<void>;
  };

/** Inert identity first; the runner owns a returned scope even if binding fails. */
export interface DynamicHandlerFactorySelection {
  readonly mode: "dynamic";
  readonly request?: "descriptor";
  readonly contract: ContractV1;
  readonly semanticDigest: string;
  readonly createRegistry: (
    config: ApalacheConfig, descriptor: SemanticDescriptor,
  ) => DynamicRegistryScope | Promise<DynamicRegistryScope>;
  readonly descriptorCache: DescriptorCache;
  readonly policy?: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory<CallbackLocalBinding>;
}

export type NegotiatedAdapterSelection =
  | CompiledAdapterSelection
  | DynamicHandlerSelection
  | DynamicHandlerFactorySelection;

export interface NegotiatedRunOptions extends ReplayOptions {
  readonly spec?: ApalacheSpec;
}

export type SyncCompiledExecutionSelection = CompiledAdapterSelection<LocalBinding> & {
  readonly execution: "sync";
};

export interface AsyncCompiledExecutionSelection {
  readonly execution: "async";
  readonly mode?: "compiled";
  readonly request?: "verify";
  readonly metadata: GeneratedModelInterface;
  readonly adapterId: string;
  readonly targetProfile: string;
  readonly stateComputerContractVersion: string;
  readonly registry: AsyncCompiledAdapterRegistry;
  /** Async execution requires a strict compiled model match before factory invocation. */
  readonly policy?: "require";
}

export type CompiledExecutionSelection =
  | SyncCompiledExecutionSelection
  | AsyncCompiledExecutionSelection;

export interface NegotiatedReportRunOptions extends NegotiatedRunOptions {
  /** Trusted matched-evidence collector; no effect on existing report semantics. */
  readonly matchedEvidence?: MatchedEvidenceTracker;
  readonly signal?: AbortSignal;
  readonly deadlines?: Partial<ReplayDeadlines>;
}

type MaybeReadyTransport = Transport & { ready?: Promise<void> };

async function resolveTransport(target: string | Transport): Promise<Transport> {
  const t = typeof target === "string" ? spawnMirror(target) : target;
  try {
    const ready = (t as MaybeReadyTransport).ready;
    if (ready) await ready;
  } catch (error) {
    try { await t.close(); } catch { /* Keep the readiness failure primary. */ }
    throw error;
  }
  return t;
}

function selectedKey(selection: CompiledAdapterSelection): CompiledAdapterKey {
  if (selection.targetProfile !== MIRRORECMA_TARGET_PROFILE &&
      selection.targetProfile !== MIRRORECMA_ASYNC_TARGET_PROFILE) {
    throw runnerError(
      "target_profile_mismatch",
      `negotiated runner requires target profile ${MIRRORECMA_TARGET_PROFILE}`,
    );
  }
  if ((selection.stateComputerContractVersion !== STATE_COMPUTER_CONTRACT_VERSION &&
       selection.stateComputerContractVersion !== ASYNC_STATE_COMPUTER_CONTRACT_VERSION) ||
      (selection.targetProfile === MIRRORECMA_ASYNC_TARGET_PROFILE &&
       selection.stateComputerContractVersion !== ASYNC_STATE_COMPUTER_CONTRACT_VERSION)) {
    throw runnerError(
      "state_computer_contract_mismatch",
      `negotiated runner requires StateComputer contract ${STATE_COMPUTER_CONTRACT_VERSION}`,
    );
  }
  return {
    semanticDigest: semanticDigestFromHex(selection.metadata.semanticDigest),
    adapterId: selection.adapterId,
    targetProfile: selection.targetProfile,
    stateComputerContractVersion: selection.stateComputerContractVersion,
  };
}

function selectedAsyncKey(selection: AsyncCompiledExecutionSelection): CompiledAdapterKey {
  if (selection.targetProfile !== MIRRORECMA_ASYNC_TARGET_PROFILE) {
    throw runnerError(
      "target_profile_mismatch",
      `async negotiated runner requires target profile ${MIRRORECMA_ASYNC_TARGET_PROFILE}`,
    );
  }
  if (selection.stateComputerContractVersion !== ASYNC_STATE_COMPUTER_CONTRACT_VERSION) {
    throw runnerError(
      "state_computer_contract_mismatch",
      `async negotiated runner requires StateComputer contract ${ASYNC_STATE_COMPUTER_CONTRACT_VERSION}`,
    );
  }
  return Object.freeze({
    semanticDigest: semanticDigestFromHex(selection.metadata.semanticDigest),
    adapterId: selection.adapterId,
    targetProfile: selection.targetProfile,
    stateComputerContractVersion: selection.stateComputerContractVersion,
  });
}

interface PreparedAdapter<B extends CallbackLocalBinding = CallbackLocalBinding> {
  readonly kind: "compiled";
  readonly key: CompiledAdapterKey;
  readonly factory: AdapterFactory<B>;
  readonly policy: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory<B>;
}

interface PreparedDynamic {
  readonly kind: "dynamic";
  readonly semanticDigest: SemanticDigest;
  readonly registry?: DynamicHandlerRegistry;
  readonly createRegistry?: DynamicHandlerFactorySelection["createRegistry"];
  readonly descriptorCache: DescriptorCache;
  readonly ifNoneMatch?: SemanticDigest;
  readonly policy: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory<CallbackLocalBinding>;
  readonly dispose?: () => void | Promise<void>;
}

type PreparedSelection = PreparedAdapter | PreparedDynamic;

/** Pure lookup performed before a transport is opened; it never invokes the factory. */
function prepareAdapter<B extends CallbackLocalBinding>(
  selection: CompiledAdapterSelection<B>,
  policy: NegotiationPolicy,
): PreparedAdapter<B> {
  if (selection.request !== undefined && selection.request !== "verify") {
    throw runnerError("negotiation_status_unexpected", "compiled selection requires verify mode");
  }
  const key = selectedKey(selection);
  return Object.freeze({
    kind: "compiled" as const,
    key: Object.freeze({ ...key }),
    factory: selection.registry.resolve(key),
    policy,
    fallbackFactory: selection.fallbackFactory,
  });
}

interface PreparedNegotiation {
  readonly request: ModelInterfaceRequest;
  readonly prepared: PreparedSelection;
}

function isDynamicSelection(
  selection: NegotiatedAdapterSelection,
): selection is DynamicHandlerSelection | DynamicHandlerFactorySelection {
  return selection.mode === "dynamic";
}

function prepareNegotiation(
  selection: NegotiatedAdapterSelection,
): PreparedNegotiation {
  if (!isDynamicSelection(selection)) {
    const request = createVerifyRequest(selection.metadata, selection.policy ?? "require");
    return { request, prepared: prepareAdapter(selection, request.policy) };
  }
  const prepared = prepareDynamic(selection);
  let ifNoneMatch: SemanticDigest | undefined;
  try {
    if (selection.descriptorCache.get(prepared.semanticDigest) !== undefined) {
      ifNoneMatch = prepared.semanticDigest;
    }
  } catch (cause) {
    // A corrupt entry is quarantined by DescriptorCache. It must never become
    // an ifNoneMatch validator; a fresh resolved reply can safely replace it.
    if (!(cause instanceof DescriptorCacheError)) throw cause;
  }
  const correlatedPrepared: PreparedDynamic = Object.freeze({
    ...prepared,
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
  });
  const request = createDescriptorRequest(selection.contract, {
    policy: correlatedPrepared.policy,
    expectedSemanticDigest: correlatedPrepared.semanticDigest,
    ...(ifNoneMatch === undefined ? {} : { ifNoneMatch }),
  });
  return { request, prepared: correlatedPrepared };
}

function prepareDynamic(selection: DynamicHandlerSelection | DynamicHandlerFactorySelection): PreparedDynamic {
  if (selection.request !== undefined && selection.request !== "descriptor") {
    throw runnerError("negotiation_status_unexpected", "dynamic selection requires descriptor mode");
  }
  const semanticDigest = semanticDigestFromHex("createRegistry" in selection
    ? selection.semanticDigest : selection.registry.semanticDigest);
  return Object.freeze({
    kind: "dynamic" as const,
    semanticDigest,
    ...("createRegistry" in selection
      ? { createRegistry: selection.createRegistry }
      : { registry: selection.registry, dispose: selection.dispose }),
    descriptorCache: selection.descriptorCache,
    policy: selection.policy ?? "require",
    fallbackFactory: selection.fallbackFactory,
  });
}

function expectedDigest(prepared: PreparedSelection): SemanticDigest {
  return prepared.kind === "compiled" ? prepared.key.semanticDigest : prepared.semanticDigest;
}

type ReplayAuthorization =
  | { readonly kind: "compiled" }
  | { readonly kind: "dynamic"; readonly descriptor: SemanticDescriptor }
  | { readonly kind: "fallback" };

function authorizeReply(
  prepared: PreparedSelection,
  reply: ModelInterfaceReply | undefined,
): ReplayAuthorization {
  if (reply === undefined) {
    if (prepared.policy !== "prefer") {
      throw runnerError("negotiation_missing", "model-interface negotiation reply is missing");
    }
    if (prepared.fallbackFactory === undefined) {
      throw runnerError(
        "legacy_fallback_unavailable",
        "old server requires an explicit fallback factory under prefer",
      );
    }
    return { kind: "fallback" };
  }
  switch (reply.status) {
    case "unsupported":
    case "unavailable":
    case "too_large":
      if (reply.status === "too_large" && prepared.kind === "compiled") {
        throw runnerError(
          "negotiation_status_unexpected",
          "model-interface status too_large is invalid for a compiled verify request",
        );
      }
      if (prepared.policy !== "prefer") {
        const code = reply.status === "unsupported"
          ? "descriptor_schema_unsupported"
          : "negotiation_status_unexpected";
        throw runnerError(code, `model-interface negotiation ${reply.status}`);
      }
      if (prepared.fallbackFactory === undefined) {
        throw runnerError(
          "legacy_fallback_unavailable",
          `model-interface negotiation ${reply.status} requires an explicit fallback factory`,
        );
      }
      return { kind: "fallback" };
    case "matched": {
      if (prepared.kind !== "compiled") {
        throw runnerError(
          "negotiation_status_unexpected",
          "model-interface status matched is invalid for a dynamic descriptor request",
        );
      }
      if (reply.semanticDigest !== prepared.key.semanticDigest) {
        throw runnerError(
          "interface_digest_mismatch",
          "server semantic digest does not match the compiled interface",
        );
      }
      return { kind: "compiled" };
    }
    case "resolved": {
      if (prepared.kind !== "dynamic") {
        throw runnerError(
          "negotiation_status_unexpected",
          "model-interface status resolved is invalid for a compiled verify request",
        );
      }
      if (reply.semanticDigest !== prepared.semanticDigest) {
        throw runnerError("interface_digest_mismatch", "resolved descriptor digest does not match the dynamic registry");
      }
      const cached = prepared.descriptorCache.put(reply.descriptor);
      if (cached.semanticDigest !== prepared.semanticDigest) {
        throw runnerError("descriptor_digest_invalid", "cached resolved descriptor digest changed");
      }
      return { kind: "dynamic", descriptor: cached.descriptor };
    }
    case "not_modified": {
      if (prepared.kind !== "dynamic") {
        throw runnerError(
          "negotiation_status_unexpected",
          "model-interface status not_modified is invalid for a compiled verify request",
        );
      }
      if (reply.semanticDigest !== prepared.semanticDigest) {
        throw runnerError("interface_digest_mismatch", "cached descriptor digest does not match the dynamic registry");
      }
      if (prepared.ifNoneMatch === undefined || prepared.ifNoneMatch !== reply.semanticDigest) {
        throw runnerError(
          "negotiation_status_unexpected",
          "not_modified does not correlate to the descriptor validator sent in this request",
        );
      }
      try {
        const cached = prepared.descriptorCache.require(reply.semanticDigest);
        return { kind: "dynamic", descriptor: cached.descriptor };
      } catch (cause) {
        if (cause instanceof DescriptorCacheError) {
          throw runnerError(
            "not_modified_without_cache",
            "not_modified requires a present digest-valid descriptor cache entry",
            cause,
          );
        }
        throw cause;
      }
    }
    case "mismatch":
      throw runnerError(
        "interface_digest_mismatch",
        "model-interface resolution did not match the requested semantic digest",
      );
  }
}

async function createBinding(
  factory: AdapterFactory<CallbackLocalBinding>,
  adapterId: string,
  config: ApalacheConfig,
): Promise<CallbackLocalBinding> {
  let binding: CallbackLocalBinding;
  try {
    binding = await factory(config);
  } catch (cause) {
    throw runnerError(
      "adapter_factory_failed",
      `adapter factory failed for ${adapterId}`,
      cause,
    );
  }
  return binding;
}

function validateBinding(
  binding: CallbackLocalBinding,
  digest: SemanticDigest,
  label: string,
  config: ApalacheConfig,
): void {
  if (!sameDigest(binding.semanticDigest, digest)) {
    throw runnerError(
      "binding_digest_mismatch",
      `binding digest does not match ${label}`,
    );
  }
  try {
    binding.assertCompatibleConfig(config);
  } catch (cause) {
    throw runnerError(
      "binding_config_mismatch",
      `binding rejected the effective Apalache configuration for ${label}`,
      cause,
    );
  }
}

async function runNegotiatedReplay(
  t: Transport,
  config: ApalacheConfig,
  prepared: PreparedSelection,
  options: ReplayOptions,
  registration: string,
): Promise<ReplayReport> {
  const control = new ReplayControl(options);
  const recorder = new ReplayRecorder(expectedDigest(prepared));
  const it = t[Symbol.asyncIterator]();
  let binding: CallbackLocalBinding | undefined;
  let disposeScope: (() => Promise<void>) | undefined;
  let primaryError: unknown;
  let failed = false;
  let report: ReplayReport | undefined;
  try {
    control.assertActive();
    t.send(registration);
    const decoded = await receiveNegotiatedFirstReply(
      it, expectedDigest(prepared), undefined, () => receiveLine(it, control),
    );
    const extension = decoded.modelInterface;
    if (extension?.kind === "failure") {
      throw runnerError(
        "negotiation_status_unexpected",
        "spec_validated carried a registration failure",
      );
    }
    const authorization = authorizeReply(prepared, extension);
    control.assertActive();
    let label: string;
    if (authorization.kind === "compiled") {
      if (prepared.kind !== "compiled") throw new Error("internal compiled authorization mismatch");
      binding = await createBinding(prepared.factory, prepared.key.adapterId, config);
      label = `adapter key for ${prepared.key.adapterId}`;
    } else if (authorization.kind === "dynamic") {
      if (prepared.kind !== "dynamic") throw new Error("internal dynamic authorization mismatch");
      if (prepared.createRegistry) {
        let scope: DynamicRegistryScope;
        try {
          scope = await prepared.createRegistry(config, authorization.descriptor);
        } catch (cause) {
          throw runnerError("adapter_factory_failed", "dynamic registry factory failed", cause);
        }
        let disposed = false;
        disposeScope = async () => {
          if (disposed) return;
          disposed = true;
          await scope.dispose?.();
        };
        control.assertActive();
        binding = scope.execution === "async"
          ? bindAsyncDynamicDescriptor(authorization.descriptor, scope.registry, disposeScope)
          : bindDynamicDescriptor(authorization.descriptor, scope.registry, disposeScope);
      } else {
        binding = bindDynamicDescriptor(
          authorization.descriptor, prepared.registry!, prepared.dispose,
        );
      }
      label = "dynamic registry";
    } else {
      binding = await createBinding(
        prepared.fallbackFactory!,
        prepared.kind === "compiled"
          ? `${prepared.key.adapterId} legacy fallback`
          : "dynamic legacy fallback",
        config,
      );
      label = prepared.kind === "compiled"
        ? `legacy fallback for ${prepared.key.adapterId}`
        : "dynamic legacy fallback";
    }
    control.assertActive();
    validateBinding(binding, expectedDigest(prepared), label, config);
    report = await replayLoop(t, it, binding.computer, control, recorder);
  } catch (error) {
    failed = true;
    primaryError = error;
    attachReplayReport(error, recorder.report(error));
  } finally {
    control.dispose();
  }

  let cleanupError: unknown;
  let cleanupFailed = false;
  if (binding !== undefined || disposeScope !== undefined) {
    try {
      if (binding) await binding.dispose();
      else await disposeScope!();
    } catch (cause) {
      cleanupFailed = true;
      cleanupError = runnerError("adapter_dispose_failed", "adapter binding disposal failed", cause);
    }
  }
  try {
    await t.close();
  } catch (error) {
    if (!failed && !cleanupFailed) {
      cleanupFailed = true;
      cleanupError = error;
    }
  }

  if (failed) throw primaryError;
  if (cleanupFailed) {
    attachReplayReport(cleanupError, report ? failedReplayReport(report, cleanupError) : recorder.report(cleanupError));
    throw cleanupError;
  }
  return report!;
}

export async function runClientNegotiated(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  selection: NegotiatedAdapterSelection,
  opts: NegotiatedRunOptions = {},
): Promise<void> {
  await runClientNegotiatedWithReport(target, apalacheConfig, config, selection, opts);
}

async function runCallbackNegotiatedWithReport(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  selection: NegotiatedAdapterSelection,
  opts: NegotiatedRunOptions = {},
): Promise<ReplayReport> {
  validateReplayOptions(opts);
  const base: Register = {
    proto_step: "register",
    apalacheConfig,
    traceConfig: config,
    spec: opts.spec,
  };
  const { request, prepared } = prepareNegotiation(selection);
  const registration = encodeModelInterfaceRegistration(base, request);
  const t = await resolveTransport(target);
  return runNegotiatedReplay(t, apalacheConfig, prepared, opts, registration);
}

export async function runClientWithTracesNegotiated(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  tracePaths: string[],
  selection: NegotiatedAdapterSelection,
  opts: ReplayOptions = {},
): Promise<void> {
  await runClientWithTracesNegotiatedWithReport(target, apalacheConfig, tracePaths, selection, opts);
}

async function runCallbackTracesWithReport(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  tracePaths: string[],
  selection: NegotiatedAdapterSelection,
  opts: ReplayOptions = {},
): Promise<ReplayReport> {
  validateReplayOptions(opts);
  const base: RegisterTraces = {
    proto_step: "register_traces",
    apalacheConfig,
    itfTracePaths: tracePaths,
  };
  const { request, prepared } = prepareNegotiation(selection);
  const registration = encodeModelInterfaceRegistration(base, request);
  const t = await resolveTransport(target);
  return runNegotiatedReplay(t, apalacheConfig, prepared, opts, registration);
}

interface PreparedAsyncAdapter {
  readonly key: CompiledAdapterKey;
  readonly factory: AsyncAdapterFactory;
}

function prepareAsyncAdapter(
  selection: AsyncCompiledExecutionSelection,
): PreparedAsyncAdapter {
  if (selection.request !== undefined && selection.request !== "verify") {
    throw runnerError("negotiation_status_unexpected", "compiled selection requires verify mode");
  }
  if (selection.policy !== undefined && selection.policy !== "require") {
    throw runnerError("negotiation_status_unexpected", "async execution requires negotiation policy require");
  }
  const key = selectedAsyncKey(selection);
  return Object.freeze({ key, factory: selection.registry.resolve(key) });
}

async function closeReportTransport(t: Transport, deadlines: ReplayDeadlines): Promise<void> {
  try {
    await awaitReplayOperation(
      Promise.resolve().then(() => t.close()),
      undefined,
      deadlines.receiveMs,
      "close",
    );
  } catch (cause) {
    if (cause instanceof ReplayDeadlineError) throw cause;
    throw new ReplayCleanupError("model transport cleanup failed", cause);
  }
}

async function resolveReportTransport(
  target: string | Transport,
  signal: AbortSignal | undefined,
  deadlines: ReplayDeadlines,
): Promise<Transport> {
  throwIfReplayCancelled(signal);
  const t = typeof target === "string" ? spawnMirror(target) : target;
  const ready = (t as MaybeReadyTransport).ready;
  if (ready !== undefined) {
    try {
      await awaitReplayOperation(ready, signal, deadlines.registrationMs, "registration");
    } catch (error) {
      const primary = normalizeReplayFailure(error);
      try {
        await closeReportTransport(t, deadlines);
      } catch (cleanup) {
        retainReplayCleanupFailure(primary, cleanup);
      }
      throw primary;
    }
  }
  return t;
}

function requireAsyncMatchedReply(
  reply: ModelInterfaceReply | undefined,
  key: CompiledAdapterKey,
): void {
  if (reply === undefined) {
    throw runnerError("negotiation_missing", "model-interface negotiation reply is missing");
  }
  switch (reply.status) {
    case "matched":
      if (reply.semanticDigest !== key.semanticDigest) {
        throw runnerError(
          "interface_digest_mismatch",
          "server semantic digest does not match the compiled interface",
        );
      }
      return;
    case "mismatch":
      throw runnerError(
        "interface_digest_mismatch",
        "model-interface resolution did not match the requested semantic digest",
      );
    case "unsupported":
      throw runnerError("descriptor_schema_unsupported", "model-interface negotiation unsupported");
    case "unavailable":
    case "too_large":
    case "resolved":
    case "not_modified":
      throw runnerError(
        "negotiation_status_unexpected",
        `model-interface status ${reply.status} is invalid for an async compiled verify request`,
      );
  }
}

async function validateAsyncBinding(
  binding: AsyncLocalBinding,
  key: CompiledAdapterKey,
  config: ApalacheConfig,
  signal: AbortSignal | undefined,
  deadlines: ReplayDeadlines,
): Promise<void> {
  if (binding.semanticDigest !== key.semanticDigest) {
    throw runnerError("binding_digest_mismatch", "binding digest does not match async adapter key");
  }
  try {
    await awaitReplayOperation(
      Promise.resolve(binding.assertCompatibleConfig(config)),
      signal,
      deadlines.stepMs,
      "step",
    );
  } catch (cause) {
    if (cause instanceof ReplayCancelledError || cause instanceof ReplayDeadlineError) throw cause;
    throw runnerError(
      "binding_config_mismatch",
      `binding rejected the effective Apalache configuration for adapter key ${key.adapterId}`,
      cause,
    );
  }
}

async function runCompiledReportReplay(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  registration: string,
  selection: CompiledExecutionSelection,
  options: NegotiatedReportRunOptions,
): Promise<CompiledReplayReport> {
  if (selection.execution === "sync") {
    if (selection.targetProfile !== MIRRORECMA_TARGET_PROFILE) {
      throw runnerError("target_profile_mismatch", "sync execution requires mirrorecma-v1");
    }
    if (selection.stateComputerContractVersion !== STATE_COMPUTER_CONTRACT_VERSION) {
      throw runnerError("state_computer_contract_mismatch", "sync execution requires mirrors.state-computer/v1");
    }
  }
  const deadlines = normalizeReplayDeadlines(options.deadlines);
  throwIfReplayCancelled(options.signal);
  const syncPrepared = selection.execution === "sync"
    ? prepareAdapter(selection, selection.policy ?? "require")
    : undefined;
  const asyncPrepared = selection.execution === "async"
    ? prepareAsyncAdapter(selection)
    : undefined;
  const expected = syncPrepared?.key.semanticDigest ?? asyncPrepared!.key.semanticDigest;
  const t = await resolveReportTransport(target, options.signal, deadlines);
  let it: AsyncIterator<string>;
  try {
    it = t[Symbol.asyncIterator]();
  } catch (error) {
    const primary = normalizeReplayFailure(error);
    try {
      await closeReportTransport(t, deadlines);
    } catch (cleanup) {
      retainReplayCleanupFailure(primary, cleanup);
    }
    throw primary;
  }
  let binding: LocalBinding | AsyncLocalBinding | undefined;
  let hasPrimaryError = false;
  let primaryError: Error | undefined;
  let report: CompiledReplayReport | undefined;
  try {
    throwIfReplayCancelled(options.signal);
    t.send(registration);
    const decoded = await receiveNegotiatedFirstReply(it, expected, {
      signal: options.signal,
      deadlines,
    });
    const extension = decoded.modelInterface;
    if (extension?.kind === "failure") {
      throw runnerError("negotiation_status_unexpected", "spec_validated carried a registration failure");
    }
    const receive = () => awaitReplayOperation(
      receiveReplayMessage(it),
      options.signal,
      deadlines.receiveMs,
      "receive",
    );
    if (selection.execution === "sync") {
      const authorization = authorizeReply(syncPrepared!, extension);
      let factory: AdapterFactory;
      let label: string;
      if (authorization.kind === "compiled") {
        factory = syncPrepared!.factory;
        label = `adapter key for ${syncPrepared!.key.adapterId}`;
      } else if (authorization.kind === "fallback") {
        factory = syncPrepared!.fallbackFactory!;
        label = `legacy fallback for ${syncPrepared!.key.adapterId}`;
      } else {
        throw new Error("internal synchronous authorization mismatch");
      }
      const pendingFactory = Promise.resolve().then(() => {
        throwIfReplayCancelled(options.signal);
        return factory(apalacheConfig);
      });
      try {
        binding = await awaitReplayOperation(
          pendingFactory,
          options.signal,
          deadlines.stepMs,
          "step",
        );
      } catch (cause) {
        pendingFactory.then(
          (lateBinding) => Promise.resolve().then(() => lateBinding.dispose()),
          () => {},
        ).catch(() => {});
        if (cause instanceof ReplayCancelledError || cause instanceof ReplayDeadlineError) throw cause;
        throw runnerError("adapter_factory_failed", `adapter factory failed for ${label}`, cause);
      }
      validateBinding(binding, expected, label, apalacheConfig);
      report = await replayCore(t, it, synchronousReplayExecution(binding.computer), {
        matchedEvidence: options.matchedEvidence,
        structuredMismatch: true,
        signal: options.signal,
        receive,
      });
    } else {
      requireAsyncMatchedReply(extension, asyncPrepared!.key);
      const factoryController = new AbortController();
      const factoryDeadline = performance.now() + deadlines.stepMs;
      const relayFactoryAbort = () => factoryController.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", relayFactoryAbort, { once: true });
      if (options.signal?.aborted) relayFactoryAbort();
      const factoryTimer = setTimeout(
        () => factoryController.abort(new ReplayDeadlineError("step", deadlines.stepMs)),
        Math.max(0, Math.ceil(factoryDeadline - performance.now())),
      );
      const authority = createAsyncNegotiationAuthority(
        t,
        it,
        apalacheConfig,
        asyncPrepared!.key,
        { signal: options.signal, deadlines },
        Object.freeze({ signal: factoryController.signal, deadline: factoryDeadline }),
      );
      const pendingFactory = Promise.resolve().then(() => {
        throwIfReplayCancelled(factoryController.signal);
        if (performance.now() >= factoryDeadline) {
          throw new ReplayDeadlineError("step", deadlines.stepMs);
        }
        return asyncPrepared!.factory(apalacheConfig, authority);
      });
      try {
        binding = await awaitReplayOperation(
          pendingFactory,
          options.signal,
          deadlines.stepMs,
          "step",
        );
      } catch (cause) {
        factoryController.abort(cause);
        pendingFactory.then(
          (lateBinding) => Promise.resolve().then(() => lateBinding.dispose()),
          () => {},
        ).catch(() => {});
        if (cause instanceof ReplayCancelledError || cause instanceof ReplayDeadlineError) throw cause;
        throw runnerError(
          "adapter_factory_failed",
          `adapter factory failed for ${asyncPrepared!.key.adapterId}`,
          cause,
        );
      } finally {
        if (!factoryController.signal.aborted) {
          factoryController.abort(new Error("async adapter factory scope completed"));
        }
        clearTimeout(factoryTimer);
        options.signal?.removeEventListener("abort", relayFactoryAbort);
      }
      await validateAsyncBinding(
        binding as AsyncLocalBinding,
        asyncPrepared!.key,
        apalacheConfig,
        options.signal,
        deadlines,
      );
      report = await replayCore(
        t,
        it,
        asynchronousReplayExecution(
          (binding as AsyncLocalBinding).computer,
          options.signal,
          deadlines.stepMs,
        ),
        { structuredMismatch: true, signal: options.signal, receive, matchedEvidence: options.matchedEvidence },
      );
    }
    const coverageFn = binding.coverage;
    const coverage = coverageFn === undefined
      ? undefined
      : await awaitReplayOperation(
          Promise.resolve(coverageFn.call(binding)),
          options.signal,
          deadlines.stepMs,
          "step",
        );
    report = replayReport(report.acceptedTraces, report.acceptedSteps, coverage);
  } catch (error) {
    hasPrimaryError = true;
    primaryError = normalizeReplayFailure(error);
  }

  const cleanupErrors: unknown[] = [];
  // Closing first interrupts a registration/receive wait and transfers owned
  // model-process termination to the transport while binding cleanup proceeds.
  const pendingTransportClose = Promise.resolve().then(() => t.close());
  pendingTransportClose.catch(() => {});
  if (binding !== undefined) {
    try {
      await awaitReplayOperation(
        Promise.resolve(binding.dispose()),
        undefined,
        deadlines.receiveMs,
        "close",
      );
    } catch (cause) {
      cleanupErrors.push(
        runnerError("adapter_dispose_failed", "adapter binding disposal failed", cause),
      );
    }
  }
  try {
    await awaitReplayOperation(pendingTransportClose, undefined, deadlines.receiveMs, "close");
  } catch (error) {
    cleanupErrors.push(error instanceof ReplayDeadlineError
      ? error
      : new ReplayCleanupError("model transport cleanup failed", error));
  }
  const cleanupError = cleanupErrors.length <= 1
    ? cleanupErrors[0]
    : new AggregateError(cleanupErrors, "multiple replay cleanup operations failed");
  if (hasPrimaryError) {
    if (cleanupErrors.length > 0) retainReplayCleanupFailure(primaryError!, cleanupError);
    throw primaryError;
  }
  if (cleanupErrors.length > 0) throw cleanupError;
  return report!;
}

async function runCompiledNegotiatedWithReport(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  selection: CompiledExecutionSelection,
  options: NegotiatedReportRunOptions = {},
): Promise<CompiledReplayReport> {
  const base: Register = {
    proto_step: "register",
    apalacheConfig,
    traceConfig: config,
    spec: options.spec,
  };
  const request = createVerifyRequest(selection.metadata, selection.policy ?? "require");
  return runCompiledReportReplay(
    target,
    apalacheConfig,
    encodeModelInterfaceRegistration(base, request),
    selection,
    options,
  );
}

async function runCompiledTracesWithReport(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  tracePaths: readonly string[],
  selection: CompiledExecutionSelection,
  options: Omit<NegotiatedReportRunOptions, "spec"> = {},
): Promise<CompiledReplayReport> {
  const base: RegisterTraces = {
    proto_step: "register_traces",
    apalacheConfig,
    itfTracePaths: [...tracePaths],
  };
  const request = createVerifyRequest(selection.metadata, selection.policy ?? "require");
  return runCompiledReportReplay(
    target,
    apalacheConfig,
    encodeModelInterfaceRegistration(base, request),
    selection,
    options,
  );
}

/** Explicit execution selects the compiled report contract; callback runners retain progress snapshots. */
export function runClientNegotiatedWithReport(
  target: string | Transport, config: ApalacheConfig, traces: TraceGenerationConfig,
  selection: CompiledExecutionSelection, options?: NegotiatedReportRunOptions,
): Promise<CompiledReplayReport>;
export function runClientNegotiatedWithReport(
  target: string | Transport, config: ApalacheConfig, traces: TraceGenerationConfig,
  selection: NegotiatedAdapterSelection, options?: NegotiatedRunOptions,
): Promise<ReplayReport>;
export function runClientNegotiatedWithReport(
  target: string | Transport, config: ApalacheConfig, traces: TraceGenerationConfig,
  selection: CompiledExecutionSelection | NegotiatedAdapterSelection,
  options: NegotiatedReportRunOptions = {},
): Promise<CompiledReplayReport | ReplayReport> {
  return "execution" in selection
    ? runCompiledNegotiatedWithReport(target, config, traces, selection, options)
    : runCallbackNegotiatedWithReport(target, config, traces, selection, options);
}

export function runClientWithTracesNegotiatedWithReport(
  target: string | Transport, config: ApalacheConfig, traces: readonly string[],
  selection: CompiledExecutionSelection, options?: Omit<NegotiatedReportRunOptions, "spec">,
): Promise<CompiledReplayReport>;
export function runClientWithTracesNegotiatedWithReport(
  target: string | Transport, config: ApalacheConfig, traces: string[],
  selection: NegotiatedAdapterSelection, options?: ReplayOptions,
): Promise<ReplayReport>;
export function runClientWithTracesNegotiatedWithReport(
  target: string | Transport, config: ApalacheConfig, traces: readonly string[],
  selection: CompiledExecutionSelection | NegotiatedAdapterSelection,
  options: Omit<NegotiatedReportRunOptions, "spec"> = {},
): Promise<CompiledReplayReport | ReplayReport> {
  return "execution" in selection
    ? runCompiledTracesWithReport(target, config, traces, selection, options)
    : runCallbackTracesWithReport(target, config, [...traces], selection, options);
}
