# Generated asynchronous ports — implementation plan

Status: implemented and verified on 2026-09-06. Design: [async emission](../specs/2026-09-06-async-emission-design.md).

- [x] Agree `ReplayContext`, `AsyncStateComputer`, target and contract constants
  with the replay owner; expose types through the public barrel.
- [x] Extend `Shell/ModelInterface/Emit/TypeScript.lean` with opt-in async
  rendering and target-specific manifest, preserving synchronous output bytes.
- [x] Extend `Shell/ModelInterface/Compiler.lean` and
  `tools/ModelInterfaceGen.lean` target handling and ownership validation.
- [x] Add focused compiler/emitter tests for accepted targets, target mismatch,
  and deterministic output without altering the semantic lock.
- [x] Generate an async Counter fixture into a distinct owned directory;
  compile it against current MirrorECMA public types.
- [x] Execute async Counter replay with operation/observation order assertions,
  real mismatch, and abort/late-resolution cases.
- [x] Rerun existing sync compiler golden checks and client Counter acceptance;
  document the new target and matching client contract.

Done: async target output can drive an actual asynchronous implementation with
the promised lifecycle, and synchronous target output remains unchanged.


Validation: `python3 tools/check-async-emitter.py` in Mirrors passed deterministic
emission, manifest profile/semantic identity, cross-target publication rejection
without writes, unsupported-target rejection, and unchanged synchronous golden
bytes. The gate is included in `lake test`, which passed. The shared publisher
now validates incoming ownership manifests; its existing race regression uses
valid manifest bytes to preserve that test's publication-race intent.

Generated async Counter unit regressions and the real filesystem Counter smoke
passed, including faulty increment, delayed callbacks, cancellation, disposal,
and swallowed reentrancy from observation getters. A post-encoding lifecycle
check prevents those getters from restoring a poisoned binding. The full client
CI gate passed with 385 tests and all current example checks.
