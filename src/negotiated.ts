import { spawnMirror, type Transport } from "./transport.js";
import {
  type ApalacheConfig,
  type ApalacheSpec,
  type Register,
  type RegisterTraces,
  type StateComputer,
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
  type ReplayReport,
} from "./replay-report.js";

export const MIRRORECMA_TARGET_PROFILE = "mirrorecma-v1" as const;
export const STATE_COMPUTER_CONTRACT_VERSION = "mirrors.state-computer/v1" as const;

export const MIRRORECMA_ASYNC_TARGET_PROFILE = "mirrorecma-async-v1" as const;
export const ASYNC_STATE_COMPUTER_CONTRACT_VERSION =
  "mirrors.async-state-computer/v1" as const;

export {
  AsyncCompiledAdapterRegistry,
  CompiledAdapterRegistry,
  ModelInterfaceRegistrationError,
  NegotiatedRunnerError,
};
export type {
  AdapterFactory,
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

export interface CompiledAdapterSelection {
  readonly mode?: "compiled";
  readonly request?: "verify";
  readonly metadata: GeneratedModelInterface;
  readonly adapterId: string;
  readonly targetProfile: string;
  readonly stateComputerContractVersion: string;
  readonly registry: CompiledAdapterRegistry;
  readonly policy?: NegotiationPolicy;
  /**
   * Explicit opt-in for an old server or an `unsupported`/`unavailable`
   * preferred reply. Invoked only after that outcome is authenticated and
   * always returns a fresh, disposable binding.
   */
  readonly fallbackFactory?: AdapterFactory;
}

/** Development-oriented descriptor mode backed only by caller-local handlers. */
export interface DynamicHandlerSelection {
  readonly mode: "dynamic";
  readonly request?: "descriptor";
  readonly contract: ContractV1;
  readonly registry: DynamicHandlerRegistry;
  readonly descriptorCache: DescriptorCache;
  readonly policy?: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory;
  readonly dispose?: () => void | Promise<void>;
}

export type NegotiatedAdapterSelection =
  | CompiledAdapterSelection
  | DynamicHandlerSelection;

export interface NegotiatedRunOptions {
  readonly spec?: ApalacheSpec;
}

export type SyncCompiledExecutionSelection = CompiledAdapterSelection & {
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
  /** Async execution currently admits only the strict sandbox-compatible policy. */
  readonly policy?: "require";
}

export type CompiledExecutionSelection =
  | SyncCompiledExecutionSelection
  | AsyncCompiledExecutionSelection;

export interface NegotiatedReportRunOptions extends NegotiatedRunOptions {
  readonly signal?: AbortSignal;
  readonly deadlines?: Partial<ReplayDeadlines>;
}

type MaybeReadyTransport = Transport & { ready?: Promise<void> };

async function resolveTransport(target: string | Transport): Promise<Transport> {
  const t = typeof target === "string" ? spawnMirror(target) : target;
  const ready = (t as MaybeReadyTransport).ready;
  if (ready) await ready;
  return t;
}

function selectedKey(selection: CompiledAdapterSelection): CompiledAdapterKey {
  if (selection.targetProfile !== MIRRORECMA_TARGET_PROFILE) {
    throw runnerError(
      "target_profile_mismatch",
      `negotiated runner requires target profile ${MIRRORECMA_TARGET_PROFILE}`,
    );
  }
  if (selection.stateComputerContractVersion !== STATE_COMPUTER_CONTRACT_VERSION) {
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

interface PreparedAdapter {
  readonly kind: "compiled";
  readonly key: CompiledAdapterKey;
  readonly factory: AdapterFactory;
  readonly policy: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory;
}

interface PreparedDynamic {
  readonly kind: "dynamic";
  readonly semanticDigest: SemanticDigest;
  readonly registry: DynamicHandlerRegistry;
  readonly descriptorCache: DescriptorCache;
  readonly ifNoneMatch?: SemanticDigest;
  readonly policy: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory;
  readonly dispose?: () => void | Promise<void>;
}

type PreparedSelection = PreparedAdapter | PreparedDynamic;

/** Pure lookup performed before a transport is opened; it never invokes the factory. */
function prepareAdapter(
  selection: CompiledAdapterSelection,
  policy: NegotiationPolicy,
): PreparedAdapter {
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
): selection is DynamicHandlerSelection {
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

function prepareDynamic(selection: DynamicHandlerSelection): PreparedDynamic {
  if (selection.request !== undefined && selection.request !== "descriptor") {
    throw runnerError("negotiation_status_unexpected", "dynamic selection requires descriptor mode");
  }
  const semanticDigest = semanticDigestFromHex(selection.registry.semanticDigest);
  return Object.freeze({
    kind: "dynamic" as const,
    semanticDigest,
    registry: selection.registry,
    descriptorCache: selection.descriptorCache,
    policy: selection.policy ?? "require",
    fallbackFactory: selection.fallbackFactory,
    dispose: selection.dispose,
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
  factory: AdapterFactory,
  adapterId: string,
  config: ApalacheConfig,
): Promise<LocalBinding> {
  let binding: LocalBinding;
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
  binding: LocalBinding,
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
): Promise<void> {
  const it = t[Symbol.asyncIterator]();
  let binding: LocalBinding | undefined;
  let primaryError: unknown;
  try {
    const decoded = await receiveNegotiatedFirstReply(it, expectedDigest(prepared));
    const extension = decoded.modelInterface;
    if (extension?.kind === "failure") {
      throw runnerError(
        "negotiation_status_unexpected",
        "spec_validated carried a registration failure",
      );
    }
    const authorization = authorizeReply(prepared, extension);
    let label: string;
    if (authorization.kind === "compiled") {
      if (prepared.kind !== "compiled") throw new Error("internal compiled authorization mismatch");
      binding = await createBinding(prepared.factory, prepared.key.adapterId, config);
      label = `adapter key for ${prepared.key.adapterId}`;
    } else if (authorization.kind === "dynamic") {
      if (prepared.kind !== "dynamic") throw new Error("internal dynamic authorization mismatch");
      binding = bindDynamicDescriptor(
        authorization.descriptor,
        prepared.registry,
        prepared.dispose,
      );
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
    validateBinding(binding, expectedDigest(prepared), label, config);
    await replayCore(t, it, synchronousReplayExecution(binding.computer));
  } catch (error) {
    primaryError = error;
  }

  let cleanupError: unknown;
  if (binding !== undefined) {
    try {
      await binding.dispose();
    } catch (cause) {
      cleanupError = runnerError("adapter_dispose_failed", "adapter binding disposal failed", cause);
    }
  }
  try {
    await t.close();
  } catch (error) {
    if (primaryError === undefined && cleanupError === undefined) cleanupError = error;
  }

  if (primaryError !== undefined) throw primaryError;
  if (cleanupError !== undefined) throw cleanupError;
}

export async function runClientNegotiated(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  selection: NegotiatedAdapterSelection,
  opts: NegotiatedRunOptions = {},
): Promise<void> {
  const base: Register = {
    proto_step: "register",
    apalacheConfig,
    traceConfig: config,
    spec: opts.spec,
  };
  const { request, prepared } = prepareNegotiation(selection);
  const registration = encodeModelInterfaceRegistration(base, request);
  const t = await resolveTransport(target);
  try {
    t.send(registration);
  } catch (error) {
    await t.close();
    throw error;
  }
  await runNegotiatedReplay(t, apalacheConfig, prepared);
}

export async function runClientWithTracesNegotiated(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  tracePaths: string[],
  selection: NegotiatedAdapterSelection,
): Promise<void> {
  const base: RegisterTraces = {
    proto_step: "register_traces",
    apalacheConfig,
    itfTracePaths: tracePaths,
  };
  const { request, prepared } = prepareNegotiation(selection);
  const registration = encodeModelInterfaceRegistration(base, request);
  const t = await resolveTransport(target);
  try {
    t.send(registration);
  } catch (error) {
    await t.close();
    throw error;
  }
  await runNegotiatedReplay(t, apalacheConfig, prepared);
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
): Promise<ReplayReport> {
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
  let report: ReplayReport | undefined;
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
        { structuredMismatch: true, signal: options.signal, receive },
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

export async function runClientNegotiatedWithReport(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  config: TraceGenerationConfig,
  selection: CompiledExecutionSelection,
  options: NegotiatedReportRunOptions = {},
): Promise<ReplayReport> {
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

export async function runClientWithTracesNegotiatedWithReport(
  target: string | Transport,
  apalacheConfig: ApalacheConfig,
  tracePaths: readonly string[],
  selection: CompiledExecutionSelection,
  options: Omit<NegotiatedReportRunOptions, "spec"> = {},
): Promise<ReplayReport> {
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
