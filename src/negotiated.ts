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
  createVerifyRequest,
  decodeModelInterfaceMirrorMessage,
  encodeModelInterfaceRegistration,
  ModelInterfaceProtocolError,
  semanticDigestFromHex,
  type GeneratedModelInterface,
  type ModelInterfaceReply,
  type NegotiationPolicy,
  type SemanticDigest,
} from "./model-interface.js";
import {
  replayLoop,
  receiveLine,
  requireValidRegistration,
} from "./replay.js";

export const MIRRORECMA_TARGET_PROFILE = "mirrorecma-v1" as const;
export const STATE_COMPUTER_CONTRACT_VERSION = "mirrors.state-computer/v1" as const;

export type NegotiatedRunnerErrorCode =
  | "negotiation_missing"
  | "descriptor_schema_unsupported"
  | "descriptor_digest_invalid"
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
  readonly computer: StateComputer;
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

export interface NegotiatedRunOptions {
  readonly spec?: ApalacheSpec;
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

interface PreparedAdapter {
  readonly key: CompiledAdapterKey;
  readonly factory: AdapterFactory;
  readonly policy: NegotiationPolicy;
  readonly fallbackFactory?: AdapterFactory;
}

/** Pure lookup performed before a transport is opened; it never invokes the factory. */
function prepareAdapter(
  selection: CompiledAdapterSelection,
  policy: NegotiationPolicy,
): PreparedAdapter {
  const key = selectedKey(selection);
  return Object.freeze({
    key: Object.freeze({ ...key }),
    factory: selection.registry.resolve(key),
    policy,
    fallbackFactory: selection.fallbackFactory,
  });
}

type ReplayAuthorization = "matched" | "fallback";

function requireMatchedReply(
  prepared: PreparedAdapter,
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
    return "fallback";
  }
  switch (reply.status) {
    case "unsupported":
    case "unavailable":
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
      return "fallback";
    case "matched": {
      if (reply.semanticDigest !== prepared.key.semanticDigest) {
        throw runnerError(
          "interface_digest_mismatch",
          "server semantic digest does not match the compiled interface",
        );
      }
      return "matched";
    }
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
  key: CompiledAdapterKey,
  config: ApalacheConfig,
): void {
  if (!sameDigest(binding.semanticDigest, key.semanticDigest)) {
    throw runnerError(
      "binding_digest_mismatch",
      `binding digest does not match adapter key for ${key.adapterId}`,
    );
  }
  try {
    binding.assertCompatibleConfig(config);
  } catch (cause) {
    throw runnerError(
      "binding_config_mismatch",
      `binding rejected the effective Apalache configuration for ${key.adapterId}`,
      cause,
    );
  }
}

async function runNegotiatedReplay(
  t: Transport,
  config: ApalacheConfig,
  prepared: PreparedAdapter,
): Promise<void> {
  const it = t[Symbol.asyncIterator]();
  let binding: LocalBinding | undefined;
  let primaryError: unknown;
  try {
    let decoded: ReturnType<typeof decodeModelInterfaceMirrorMessage>;
    try {
      decoded = decodeModelInterfaceMirrorMessage(await receiveLine(it));
    } catch (cause) {
      const code = cause instanceof ModelInterfaceProtocolError &&
          /digest|semanticDigest/.test(cause.message)
        ? "descriptor_digest_invalid"
        : cause instanceof ModelInterfaceProtocolError && /descriptorSchema/.test(cause.message)
          ? "descriptor_schema_unsupported"
          : "negotiation_status_unexpected";
      throw runnerError(code, "invalid model-interface negotiation reply", cause);
    }
    if (decoded.message.proto_step === "register_error" &&
        decoded.modelInterface?.kind === "failure") {
      const failure = decoded.modelInterface;
      if (failure.expectedSemanticDigest !== undefined &&
          !sameDigest(failure.expectedSemanticDigest, prepared.key.semanticDigest)) {
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
    const authorization = requireMatchedReply(prepared, extension);
    if (authorization === "matched") {
      binding = await createBinding(prepared.factory, prepared.key.adapterId, config);
    } else {
      binding = await createBinding(
        prepared.fallbackFactory!,
        `${prepared.key.adapterId} legacy fallback`,
        config,
      );
    }
    validateBinding(binding, prepared.key, config);
    await replayLoop(t, it, binding.computer);
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
  selection: CompiledAdapterSelection,
  opts: NegotiatedRunOptions = {},
): Promise<void> {
  const base: Register = {
    proto_step: "register",
    apalacheConfig,
    traceConfig: config,
    spec: opts.spec,
  };
  const request = createVerifyRequest(selection.metadata, selection.policy ?? "require");
  const registration = encodeModelInterfaceRegistration(base, request);
  const prepared = prepareAdapter(selection, request.policy);
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
  selection: CompiledAdapterSelection,
): Promise<void> {
  const base: RegisterTraces = {
    proto_step: "register_traces",
    apalacheConfig,
    itfTracePaths: tracePaths,
  };
  const request = createVerifyRequest(selection.metadata, selection.policy ?? "require");
  const registration = encodeModelInterfaceRegistration(base, request);
  const prepared = prepareAdapter(selection, request.policy);
  const t = await resolveTransport(target);
  try {
    t.send(registration);
  } catch (error) {
    await t.close();
    throw error;
  }
  await runNegotiatedReplay(t, apalacheConfig, prepared);
}
