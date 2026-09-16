# Work queue implementation contract

Export `createAdapter()` from `adapter.mjs`; return `{actions, observe}`.
Actions resolve to undefined. Store actual queue state; observe it directly.
Use bigint item IDs (positive, with 0 denoting no in-flight item), arrays for
Pending and a native Set of bigints for Completed.

- Initialize and Reset clear Pending/Completed, set InFlight to 0 and Failed
  false. Repeated Initialize must also clear previous state.
- Enqueue({Item}) appends unless Item is already pending, in flight or completed.
- Start requires an idle worker and nonempty Pending. Remove the FIFO head and
  put it InFlight, setting Failed false.
- Fail requires an in-flight job with Failed false; set Failed true.
- Retry requires an in-flight failed job; set Failed false without dropping or
  duplicating the job.
- Complete requires an in-flight job with Failed false. Add it to Completed
  and set InFlight to 0.

Except for Enqueue, actions take `{}`. `observe()` returns exactly
`{Pending, InFlight, Completed, Failed}` without mutating state. Calls are
serialized and awaited. Unknown/invalid operations may reject. Reset may occur
at any point. This single-worker contract does not require background execution.
