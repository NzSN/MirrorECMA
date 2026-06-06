export {
  runClient,
  runClientWithTraces,
  presetClient,
  type State,
  type StateComputer,
  type TraceGenerationConfig,
} from "./client.js";

export {
  type MirrorMessage,
  type Value,
  type Register,
  type RegisterTraces,
  type ReportState,
  type SpecValidated,
  type InitialState,
  type NextStep,
  type StepOk,
  type StepMismatch,
  type AllStepsDone,
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
