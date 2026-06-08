export {
  runClient,
  runClientWithTraces,
  runClientGenTraces,
  presetClient,
  type State,
  type StateComputer,
  type ApalacheConfig,
  type TraceGenerationConfig,
} from "./client.js";

export {
  type MirrorMessage,
  type Value,
  type Register,
  type RegisterTraces,
  type RegisterTraceGen,
  type ReportState,
  type SpecValidated,
  type InitialState,
  type NextStep,
  type StepOk,
  type StepMismatch,
  type AllStepsDone,
  type GenTracesDone,
  type ProtocolError,
  type RegisterError,
  encodeClientMessage,
  encodeState,
  decodeMirrorMessage,
  asInt,
  asStr,
  asRecord,
  getParam,
  getParamInt,
} from "./protocol.js";

export { spawnMirror, type Transport } from "./transport.js";
