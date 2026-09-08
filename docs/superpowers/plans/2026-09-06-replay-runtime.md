# Replay runtime implementation plan

- [x] Add execution-control and report modules without editing protocol wire types.
- [x] Refactor the shared replay loop to await computation, enforce terminal races,
   collect bounded aggregates, and emit structured mismatches.
- [x] Add report-returning client runners and keep existing void-returning wrappers.
- [x] Extend negotiated local binding contracts and add deferred dynamic scopes;
   preserve negotiation gating and exactly-once cleanup on all paths.
- [x] Add focused report, async, and dynamic-scope acceptance tests. Run TypeScript
   checks and the existing negotiation/dynamic regression suites.
- [x] Report validation evidence and remaining limits to the integration owner.

Owner: replay_runtime. Shared seams: dynamic_binding supplies the asynchronous
descriptor binder; root owns public barrel exports and package/documentation
integration. No commits or pushes are part of this plan.

Follow-up review fixes are complete: aggregate coverage has explicit distinct-name
caps and dropped-event metadata; failed transport readiness owns cleanup; unsafe
rejection accessors, null-prototype objects, revoked proxies and primitive values
cannot replace the original failure or bypass cleanup. The report/async/runner/
generated-async suites pass 92 tests. Strict test compilation and both async
filesystem Counter smoke cases pass, including the real typed mismatch path.
