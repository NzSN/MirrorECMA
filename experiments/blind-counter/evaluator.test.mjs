import assert from "node:assert/strict";
import test from "node:test";

import { verifyAuthoringSealed } from "./evaluator.mjs";

test("seal probe accepts an immediate STATE_INVALID control error", async () => {
  let calls = 0;
  const telemetry = {};
  const rejected = Object.assign(new Error("sealed"), {
    name: "ControlError",
    code: "STATE_INVALID",
    stage: "authoring",
  });
  await verifyAuthoringSealed({
    authoringExec: async () => {
      calls += 1;
      throw rejected;
    },
  }, telemetry);
  assert.equal(calls, 1);
  assert.deepEqual(telemetry.seal, {
    status: "failed",
    code: "STATE_INVALID",
    stage: "authoring",
    rejection: "immediate",
  });
});

test("seal probe accepts an asynchronously failed operation", async () => {
  let waits = 0;
  const telemetry = {};
  await verifyAuthoringSealed({
    authoringExec: async () => ({
      wait: async () => {
        waits += 1;
        await Promise.resolve();
        return {
          operationId: 9,
          status: "failed",
          error: {
            code: "STATE_INVALID",
            stage: "authoring",
            message: "sealed",
            operationId: 9,
          },
        };
      },
    }),
  }, telemetry);
  assert.equal(waits, 1);
  assert.deepEqual(telemetry.seal, {
    status: "failed",
    code: "STATE_INVALID",
    stage: "authoring",
    rejection: "operation",
  });
});

test("seal probe fails closed for any other rejection", async () => {
  const telemetry = {};
  const rejected = Object.assign(new Error("backend unavailable"), {
    name: "ControlError",
    code: "BACKEND_ADMISSION_FAILED",
    stage: "authoring",
  });
  await assert.rejects(
    verifyAuthoringSealed({ authoringExec: async () => { throw rejected; } }, telemetry),
    (error) => error === rejected,
  );
  assert.equal(telemetry.seal, undefined);
});
