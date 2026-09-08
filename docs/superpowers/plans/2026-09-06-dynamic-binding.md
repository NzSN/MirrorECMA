# Dynamic binding implementation plan

Date: 2026-09-06

Design: [Dynamic binding type coverage and lifecycle](../specs/2026-09-06-dynamic-binding-design.md)

## Tasks and ownership

| Task | Owner | Files | Acceptance |
| --- | --- | --- | --- |
| D1: Validate and snapshot opaque protocol values | `dynamic_binding` | `src/opaque-itf.ts` | Every Value tag supported; frozen copies; bounded, canonical collection validation; genuine runtime brand |
| D2: Integrate opaque values into dynamic codecs | `dynamic_binding` | `src/dynamic-binding.ts` | Every descriptor type accepted, including all nested containers; forged or mismatched native observations poison binding |
| D3: Add async binder and lifecycle control | `dynamic_binding` | `src/dynamic-binding.ts` | Explicit context signal; sequential action/observers; failed/cancelled/reentrant invocations cannot continue or be reused |
| D4: Enforce disposal for both binders | `dynamic_binding` | `src/dynamic-binding.ts` | Cleanup once; concurrent disposal shares promise; all later computer calls reject |
| D5: Defer registry/SUT construction to verified negotiation | `replay_runtime` | `src/negotiated.ts`, negotiated tests | Zero factories on invalid reply; returned scope disposed on binder failure; late async factory cleanup |
| D6: Cover adversarial and async behavior | `dynamic_binding` | `test/model-interface-dynamic.test.ts`, `test/async-dynamic-binding.test.ts` | Meaningful roundtrips, ordering, cancellation, poisoning, and callback-count assertions |
| D7: Export and document public API | parent integration | `src/index.ts`, root documentation | New APIs usable through the package barrel; unchanged sync examples still type-check |
| D8: Preserve prototype-looking wire labels | `dynamic_binding` | `src/protocol.ts`, `test/opaque-wire.test.ts` | Own data properties survive state/record encode and decode; object prototypes and original golden bytes remain unchanged |

## Dependency order

1. Read MI8/MI17 and distinguish the descriptor algebra from portable MITL.
2. Agree `ReplayContext`/`AsyncStateComputer` with the replay owner before coding.
3. Implement D1 and D2, then D3 and D4 using shared descriptor/registry validation.
4. Integrate D5 independently once the binder signatures exist.
5. Run D6, export through D7, and run package/example type checks and negotiated regressions.

No runtime dependency, generated artifact edit, message/type schema change,
commit, or push is required for these tasks. D8 makes a narrow protocol codec
correction required for complete opaque record fidelity.

## Validation record

All tasks are implemented. D5 was integrated by the replay owner; D7 exports were
integrated by the parent. Verified on 2026-09-06:

- `pnpm run check` passed for the package source.
- `NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand --watchman=false test/model-interface-runner.test.ts test/model-interface-dynamic.test.ts test/async-dynamic-binding.test.ts`
  passed: 3 suites, 88 tests, including negotiated factory ownership and timeout
  integration.
- `pnpm exec tsc --noEmit --target es2022 --module node16 --moduleResolution node16 --strict --skipLibCheck test/model-interface-dynamic.test.ts test/async-dynamic-binding.test.ts`
  passed. This explicitly type-checks the new tests because Jest disables
  TypeScript diagnostics.
- `git diff --check` passed.
- D8 wire-label correction: `NODE_OPTIONS=--experimental-vm-modules pnpm exec jest --runInBand --watchman=false test/protocol.test.ts test/golden.test.ts test/opaque-wire.test.ts`
  passed: 3 suites, 79 tests. The original protocol and golden corpus remain
  unchanged, while nested opaque records preserve prototype-looking labels
  through real JSON encoding/decoding without prototype mutation.
- `pnpm exec tsc --noEmit --target es2022 --module node16 --moduleResolution node16 --strict --skipLibCheck test/opaque-wire.test.ts`
  passed.

An initial command forwarded an extra literal `--` through the package test
script, so Jest ignored the Watchman flag and encountered sandbox socket denial.
The direct `pnpm exec jest --watchman=false` invocation above resolved it; this
was an invocation/environment failure, not an assertion failure. Broader CI and
live smoke gates remain the parent integration task.
