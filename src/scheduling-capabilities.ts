/** Experimental API declaration, not an artifact qualification certificate. */
export const SCHEDULING_CAPABILITIES = {
  "schema": "mirrors.scheduling-capabilities/v1",
  "stability": "experimental",
  "profiles": [
    "mirrorecma.worker-checkpoints/v1",
    "mirrorecma.finite-checkpoint-exploration/v1"
  ],
  "interfaces": [
    "startWorkerSchedule",
    "runWorkerSchedule",
    "ScheduleBindingSession",
    "replayScheduledTraces",
    "exploreFiniteSchedules"
  ],
  "claims": {
    "fixedScheduleReplay": true,
    "incrementalCheckpointBinding": true,
    "finiteDeclaredExploration": true,
    "genericNativeScheduler": false,
    "arbitraryThreadPreemption": false,
    "hardInProcessTermination": false,
    "partialOrderReduction": false
  },
  "qualification": "Static API declaration only; exact artifact observations belong to separate acceptance records. Native application bridges have separate, bounded profiles."
} as const;
