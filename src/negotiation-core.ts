import { randomUUID } from "node:crypto";
import type { ApalacheConfig } from "./protocol.js";
import type { Transport } from "./transport.js";
import {
  MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
  ModelInterfaceProtocolError,
  decodeModelInterfaceMirrorMessage,
  type DecodedModelInterfaceMirrorMessage,
  type SemanticDigest,
} from "./model-interface.js";
import { receiveLine, requireValidRegistration } from "./replay-core.js";
import {
  awaitReplayOperation,
  ReplayCancelledError,
  ReplayDeadlineError,
  type ReplayDeadlines,
} from "./async-replay.js";
import { runnerError } from "./adapter-registry.js";

const authorizationBrand: unique symbol = Symbol("async-negotiation-authorization");

/** A server-side structured registration failure, separate from local selection errors. */
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

export interface AsyncNegotiationWitness {
  readonly [authorizationBrand]: true;
  readonly registrationId: string;
}

export interface AsyncNegotiationAuthority {
  readonly witness: AsyncNegotiationWitness;
  readonly registrationId: string;
  readonly descriptorSchema: typeof MODEL_INTERFACE_DESCRIPTOR_SCHEMA;
  readonly semanticDigest: SemanticDigest;
  readonly adapterId: string;
  readonly targetProfile: string;
  readonly stateComputerContractVersion: string;
  readonly request: "verify";
  readonly policy: "require";
  readonly status: "matched";
  readonly config: ApalacheConfig;
  readonly signal?: AbortSignal;
  readonly deadlines: ReplayDeadlines;
  /** Factory-only cancellation scope; never serialize this context. */
  readonly context: import("./async-replay.js").ReplayContext;
  /** Same session objects; source-local facade code must not disclose them. */
  readonly transport: Transport;
  readonly iterator: AsyncIterator<string>;
}

export interface FirstReplyOptions {
  readonly signal?: AbortSignal;
  readonly deadlines: ReplayDeadlines;
}

function negotiationDecodeError(cause: unknown): Error {
  const code = cause instanceof ModelInterfaceProtocolError && /digest|semanticDigest/.test(cause.message)
    ? "descriptor_digest_invalid"
    : cause instanceof ModelInterfaceProtocolError && /descriptor.*required for resolved/.test(cause.message)
      ? "descriptor_missing"
      : cause instanceof ModelInterfaceProtocolError && /descriptorSchema/.test(cause.message)
        ? "descriptor_schema_unsupported"
        : "negotiation_status_unexpected";
  return runnerError(code, "invalid model-interface negotiation reply", cause);
}

/** Read and validate exactly the first registration reply. */
export async function receiveNegotiatedFirstReply(
  it: AsyncIterator<string>,
  expectedDigest: SemanticDigest,
  options?: FirstReplyOptions,
): Promise<DecodedModelInterfaceMirrorMessage> {
  let decoded: DecodedModelInterfaceMirrorMessage;
  try {
    const line = options === undefined
      ? await receiveLine(it)
      : await awaitReplayOperation(
          receiveLine(it),
          options.signal,
          options.deadlines.registrationMs,
          "registration",
        );
    decoded = decodeModelInterfaceMirrorMessage(line);
  } catch (cause) {
    if (cause instanceof ReplayCancelledError || cause instanceof ReplayDeadlineError) throw cause;
    throw negotiationDecodeError(cause);
  }
  if (decoded.message.proto_step === "register_error" && decoded.modelInterface?.kind === "failure") {
    const failure = decoded.modelInterface;
    if (failure.expectedSemanticDigest !== undefined && failure.expectedSemanticDigest !== expectedDigest) {
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
  if (options === undefined) {
    requireValidRegistration(decoded.message);
  } else {
    const message = decoded.message;
    if (message.proto_step === "protocol_error") {
      throw new ModelInterfaceRegistrationError(
        "protocol_error",
        "protocol_error",
        message.error,
      );
    }
    if (message.proto_step === "register_error") {
      throw new ModelInterfaceRegistrationError(
        "register_error",
        "register_error",
        `register failed: ${message.error}`,
      );
    }
    if (message.proto_step !== "spec_validated") {
      throw new ModelInterfaceRegistrationError(
        "registration_reply_unexpected",
        message.proto_step,
        `expected spec_validated, got ${message.proto_step}`,
      );
    }
    if (typeof message.result !== "string") {
      throw new ModelInterfaceRegistrationError(
        "spec_invalid",
        "invalid",
        `spec invalid: ${message.result.invalid}`,
      );
    }
  }
  if (decoded.modelInterface?.kind === "failure") {
    throw runnerError(
      "negotiation_status_unexpected",
      "spec_validated carried a registration failure",
    );
  }
  return decoded;
}

export function createAsyncNegotiationAuthority(
  transport: Transport,
  iterator: AsyncIterator<string>,
  config: ApalacheConfig,
  key: {
    readonly semanticDigest: SemanticDigest;
    readonly adapterId: string;
    readonly targetProfile: string;
    readonly stateComputerContractVersion: string;
  },
  options: FirstReplyOptions,
  context: import("./async-replay.js").ReplayContext,
): AsyncNegotiationAuthority {
  const registrationId = randomUUID();
  const witness = Object.freeze({
    [authorizationBrand]: true as const,
    registrationId,
  });
  return Object.freeze({
    witness,
    registrationId,
    descriptorSchema: MODEL_INTERFACE_DESCRIPTOR_SCHEMA,
    semanticDigest: key.semanticDigest,
    adapterId: key.adapterId,
    targetProfile: key.targetProfile,
    stateComputerContractVersion: key.stateComputerContractVersion,
    request: "verify" as const,
    policy: "require" as const,
    status: "matched" as const,
    config: Object.freeze({ ...config }),
    signal: options.signal,
    deadlines: Object.freeze({ ...options.deadlines }),
    context,
    transport,
    iterator,
  });
}
