import type { ReplayComputer } from "./replay-control.js";
import type { ApalacheConfig, StateComputer } from "./protocol.js";
import type { SemanticDigest } from "./model-interface.js";
import type { AsyncStateComputer } from "./async-replay.js";
import type { AsyncNegotiationAuthority } from "./negotiation-core.js";

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

export function runnerError(
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

export interface CallbackLocalBinding extends Omit<LocalBinding, "computer"> {
  readonly computer: ReplayComputer;
}

export interface AsyncLocalBinding {
  readonly semanticDigest: SemanticDigest;
  readonly computer: AsyncStateComputer;
  assertCompatibleConfig(config: ApalacheConfig): void | Promise<void>;
  coverage?(): Readonly<Record<string, number>> | Promise<Readonly<Record<string, number>>>;
  dispose(): void | Promise<void>;
}

export type AdapterFactory<B extends CallbackLocalBinding = LocalBinding> = (
  config: ApalacheConfig,
) => B | Promise<B>;

/**
 * The authority argument is present only after a strict compiled async match.
 * External implementation factories can use it for admission before constructing a port.
 */
export type AsyncAdapterFactory = (
  config: ApalacheConfig,
  authority: AsyncNegotiationAuthority,
) => AsyncLocalBinding | Promise<AsyncLocalBinding>;

export interface CompiledAdapterRegistration<B extends CallbackLocalBinding = LocalBinding> {
  readonly key: CompiledAdapterKey;
  readonly factory: AdapterFactory<B>;
}

export interface AsyncCompiledAdapterRegistration {
  readonly key: CompiledAdapterKey;
  readonly factory: AsyncAdapterFactory;
}

function exactKey(a: CompiledAdapterKey, b: CompiledAdapterKey): boolean {
  return a.semanticDigest === b.semanticDigest &&
    a.adapterId === b.adapterId &&
    a.targetProfile === b.targetProfile &&
    a.stateComputerContractVersion === b.stateComputerContractVersion;
}

interface Registration<F> {
  readonly key: CompiledAdapterKey;
  readonly factory: F;
}

class ExactAdapterRegistry<F> {
  private readonly registrations: readonly Registration<F>[];

  constructor(registrations: readonly Registration<F>[]) {
    this.registrations = Object.freeze(registrations.map((entry) => Object.freeze({
      key: Object.freeze({ ...entry.key }),
      factory: entry.factory,
    })));
  }

  resolve(key: CompiledAdapterKey): F {
    const exact = this.registrations.filter((entry) => exactKey(entry.key, key));
    if (exact.length > 1) {
      throw runnerError("adapter_ambiguous", `multiple adapters registered for ${key.adapterId}`);
    }
    if (exact.length === 1) return exact[0]!.factory;
    const sameIdentity = this.registrations.filter((entry) =>
      entry.key.semanticDigest === key.semanticDigest && entry.key.adapterId === key.adapterId
    );
    const sameTarget = sameIdentity.filter((entry) => entry.key.targetProfile === key.targetProfile);
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

  entries(): readonly Registration<F>[] {
    return this.registrations;
  }
}

/** Immutable exact-key synchronous registry. */
export class CompiledAdapterRegistry<B extends CallbackLocalBinding = LocalBinding> {
  private readonly registry: ExactAdapterRegistry<AdapterFactory<B>>;
  private readonly registrations: readonly Registration<AdapterFactory<B>>[];
  constructor(registrations: readonly CompiledAdapterRegistration<B>[]) {
    this.registry = new ExactAdapterRegistry(registrations);
    this.registrations = this.registry.entries();
  }
  resolve(key: CompiledAdapterKey): AdapterFactory<B> {
    return this.registry.resolve(key);
  }
}

/** Immutable exact-key asynchronous registry. */
export class AsyncCompiledAdapterRegistry {
  private readonly registry: ExactAdapterRegistry<AsyncAdapterFactory>;
  private readonly registrations: readonly Registration<AsyncAdapterFactory>[];
  constructor(registrations: readonly AsyncCompiledAdapterRegistration[]) {
    this.registry = new ExactAdapterRegistry(registrations);
    this.registrations = this.registry.entries();
  }
  resolve(key: CompiledAdapterKey): AsyncAdapterFactory {
    return this.registry.resolve(key);
  }
}
