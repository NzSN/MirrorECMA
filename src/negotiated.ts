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
  decodeModelInterfaceMirrorMessage,
  encodeModelInterfaceRegistration,
  ModelInterfaceProtocolError,
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
  replayLoop,
  receiveLine,
  requireValidRegistration,
} from "./replay.js";
import {
  ReplayControl, ReplayControlError, validateReplayOptions,
  type ReplayComputer, type ReplayOptions,
} from "./replay-control.js";
import {
  attachReplayReport, failedReplayReport, ReplayRecorder, type ReplayReport,
} from "./replay-report.js";

export const MIRRORECMA_TARGET_PROFILE = "mirrorecma-v1" as const;
export const STATE_COMPUTER_CONTRACT_VERSION = "mirrors.state-computer/v1" as const;
export const ASYNC_STATE_COMPUTER_CONTRACT_VERSION = "mirrors.async-state-computer/v1" as const;
export const MIRRORECMA_ASYNC_TARGET_PROFILE = "mirrorecma-async-v1" as const;

export type NegotiatedRunnerErrorCode =
  | "negotiation_missing"
  | "descriptor_schema_unsupported"
  | "descriptor_digest_invalid"
  | "descriptor_missing"
  | "not_modified_without_cache"
  | "negotiation_status_unexpected"
  | "adapter_not_registered"
  | "adapter_ambiguous"
  | "target_profile_mismatch"
  | "state_computer_contract_mismatch"
  | "interface_digest_mismatch"
  | "binding_digest_mismatch"
  | "binding_config_mismatch"
  | "adapter_factory_failed"
  | "adapter_dispose_failed"
  | "legacy_fallback_unavailable";

/** Stable, machine-readable local runner failure. */
export class NegotiatedRunnerError extends Error {
  constructor(
    readonly code: NegotiatedRunnerErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "NegotiatedRunnerError";
  }
}

/** A server-side structured registration failure, kept separate from local selection errors. */
export class ModelInterfaceRegistrationError extends Error {
  constructor(
    readonly code: string,
    readonly status: string,
    message: string,
  ) {
    super(message);
    this.name = "ModelInterfaceRegistrationError";
  }
}

function runnerError(
  code: NegotiatedRunnerErrorCode,
  message: string,
  cause?: unknown,
): NegotiatedRunnerError {
  return new NegotiatedRunnerError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

export interface CompiledAdapterKey {
  readonly semanticDigest: SemanticDigest;
  readonly adapterId: string;
  readonly targetProfile: string;
  readonly stateComputerContractVersion: string;
}

export interface LocalBinding {
  readonly semanticDigest: SemanticDigest;
  readonly computer: ReplayComputer;
  assertCompatibleConfig(config: ApalacheConfig): void;
  coverage?(): Readonly<Record<string, number>>;
  dispose(): void | Promise<void>;
}

export type AdapterFactory = (
  config: ApalacheConfig,
) => LocalBinding | Promise<LocalBinding>;

export interface CompiledAdapterRegistration {
  readonly key: CompiledAdapterKey;
  readonly factory: AdapterFactory;
}

function sameDigest(a: SemanticDigest, b: SemanticDigest): boolean {
  return a === b;
}

function exactKey(a: CompiledAdapterKey, b: CompiledAdapterKey): boolean {
  return sameDigest(a.semanticDigest, b.semanticDigest) &&
    a.adapterId === b.adapterId &&
    a.targetProfile === b.targetProfile &&
    a.stateComputerContractVersion === b.stateComputerContractVersion;
}

/** Immutable exact-key registry. It never guesses a compatible adapter. */
export class CompiledAdapterRegistry {
  private readonly registrations: readonly CompiledAdapterRegistration[];

  constructor(registrations: readonly CompiledAdapterRegistration[]) {
    this.registrations = Object.freeze(registrations.map((entry) => Object.freeze({
      key: Object.freeze({ ...entry.key }),
      factory: entry.factory,
    })));
  }

  resolve(key: CompiledAdapterKey): AdapterFactory {
    const exact = this.registrations.filter((entry) => exactKey(entry.key, key));
    if (exact.length > 1) {
      throw runnerError("adapter_ambiguous", `multiple adapters registered for ${key.adapterId}`);
    }
    if (exact.length === 1) return exact[0]!.factory;

    const sameIdentity = this.registrations.filter((entry) =>
      sameDigest(entry.key.semanticDigest, key.semanticDigest) &&
      entry.key.adapterId === key.adapterId
    );
    const sameTarget = sameIdentity.filter((entry) =>
      entry.key.targetProfile === key.targetProfile
    );
    if (sameIdentity.length > 0 && sameTarget.length === 0) {
      throw runnerError(
        "target_profile_mismatch",
        `adapter ${key.adapterId} is not registered for target profile ${key.targetProfile}`,
      );
    }
    if (sameTarget.some((entry) =>
      entry.key.stateComputerContractVersion !== key.stateComputerContractVersion
    )) {
      throw runnerError(
        "state_computer_contract_mismatch",
        `adapter ${key.adapterId} is not registered for StateComputer contract ${key.stateComputerContractVersion}`,
      );
    }
    throw runnerError("adapter_not_registered", `adapter ${key.adapterId} is not registered`);
  }
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
  readonly fallbackFactory?: AdapterFactory;
}

export type NegotiatedAdapterSelection =
  | CompiledAdapterSelection
  | DynamicHandlerSelection
  | DynamicHandlerFactorySelection;

export interface NegotiatedRunOptions extends ReplayOptions {
  readonly spec?: ApalacheSpec;
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
  readonly registry?: DynamicHandlerRegistry;
  readonly createRegistry?: DynamicHandlerFactorySelection["createRegistry"];
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
  options: ReplayOptions,
  registration: string,
): Promise<ReplayReport> {
  const control = new ReplayControl(options);
  const recorder = new ReplayRecorder(expectedDigest(prepared));
  const it = t[Symbol.asyncIterator]();
  let binding: LocalBinding | undefined;
  let disposeScope: (() => Promise<void>) | undefined;
  let primaryError: unknown;
  let failed = false;
  let report: ReplayReport | undefined;
  try {
    control.assertActive();
    t.send(registration);
    let decoded: ReturnType<typeof decodeModelInterfaceMirrorMessage>;
    try {
      decoded = decodeModelInterfaceMirrorMessage(await receiveLine(it, control));
    } catch (cause) {
      if (cause instanceof ReplayControlError) throw cause;
      const code = cause instanceof ModelInterfaceProtocolError &&
          /digest|semanticDigest/.test(cause.message)
        ? "descriptor_digest_invalid"
        : cause instanceof ModelInterfaceProtocolError &&
            /descriptor.*required for resolved/.test(cause.message)
          ? "descriptor_missing"
        : cause instanceof ModelInterfaceProtocolError && /descriptorSchema/.test(cause.message)
          ? "descriptor_schema_unsupported"
          : "negotiation_status_unexpected";
      throw runnerError(code, "invalid model-interface negotiation reply", cause);
    }
    if (decoded.message.proto_step === "register_error" &&
        decoded.modelInterface?.kind === "failure") {
      const failure = decoded.modelInterface;
      if (failure.expectedSemanticDigest !== undefined &&
          !sameDigest(failure.expectedSemanticDigest, expectedDigest(prepared))) {
        throw runnerError(
          "negotiation_status_unexpected",
          "structured register_error expectedSemanticDigest does not match the request",
        );
      }
      throw new ModelInterfaceRegistrationError(
        failure.code,
        failure.status,
        `register failed: ${decoded.message.error}`,
      );
    }
    requireValidRegistration(decoded.message);
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

export async function runClientNegotiatedWithReport(
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

export async function runClientWithTracesNegotiatedWithReport(
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
