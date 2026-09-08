# Fresh restricted Counter authoring — 2026-09-08

**Result: passed, cleanup confirmed.** A fresh fullstack author started with an
empty submission, created both implementation and public tests through Gate,
submitted once, and passed privately held model traces after source freezing.

## Observed sequence

1. A trusted evaluator prepared a private Counter model with a fresh hidden
   trace-generation objective. Real Apalache generated four private traces;
   the real interface compiler resolved their identity to the generated port.
   The model, traces, configuration, interface lock, and expected states were
   excluded from the authoring, build, and execution mounts.
2. A fresh Codex `0.153.4` process used the `gpt-5.6-sol` model and fullstack
   developer role. It inherited no conversation and loaded no project
   instructions, memories, skills, plugins, or external apps.
3. Only `public_contract`, `gate_exec`, and `submit` were operational access
   tools. MCP resource discovery exposed no resources. A synthetic-model audit
   of the actual Codex dispatcher verified native shell, patch, and image-file
   calls were unavailable and an authorized Gate call worked. The real author
   transcript contains only the five approved calls listed below.
4. The author read the public contract, verified that its workspace was empty,
   wrote the two modules using Gate's restricted Node interpreter, ran its
   public tests, and submitted. No reference implementation was copied into
   either the submission or author context.
5. Gate froze the source, ran the submission's `build.mjs#runBuild` inside the
   restricted build environment, packaged the adapter, and froze the artifact.
   The evaluator's source hash exactly matched Gate's source receipt.
6. Required model negotiation succeeded before worker launch. One Node worker
   executed all four private traces, with four initializations and 36 ticks.
   Actual observations passed Mirrors comparison.
7. Gate rejected a post-prepare authoring request with `STATE_INVALID`.
   Authoring, build, and execution canaries passed. Worker exit and session
   cleanup were recorded, with no remaining resources.

## Author actions

| Call | Action | Outcome |
| --- | --- | --- |
| `public_contract` | Read approved semantics, signatures, and build requirements | Public contract returned |
| `gate_exec` / `author.node` | Inspect submission directory | `[]` |
| `gate_exec` / `author.node` | Create `adapter.mjs` and `build.mjs` | Two files created |
| `gate_exec` / `author.node` | Run submission-owned public checks | `public checks passed` |
| `submit` | Seal authoring | Submitted |

The [adapter](submission/adapter.mjs) stores a bigint in its factory closure.
`Tick` mutates that value; `observe` reads the same value. It does not contain a
trace interpreter, expected-state table, or oracle access. The
[public checks](submission/build.mjs) exercise initialization, increments,
negative and large bigints, reset, and independent instances.

## Evidence

- [Trusted evaluator evidence](evidence.json): empty and final source manifests,
  Gate receipts, transcript, guards, operation diagnostics, verdict, and cleanup.
- [Run summary and file hashes](summary.json).
- [Actual author event transcript](author-events.jsonl),
  [initial prompt](author-prompt.txt), and [final response](author-final.txt).
- [Author capability profile](author-profile.json) and
  [dispatcher access audit](tool-audit.json).
- [Verification with the final generated binding](final-verification.json):
  the same source and private cases passed again without additional authoring.

The frozen source hash is
`e0e4a4672aed30e8dcfd840e39eaa025f42e8a6a6881ab076f9ac13aeceafa81`.
The frozen artifact hash is
`58767d6769ab3a6681c4dfc54289333db2fea7c0c7c951a1b9888d21cd58bafe`.
These identities differ because the artifact includes the operator's restricted
execution guard and adapter, while source also contains submission-owned tests.

Private model and trace contents are deliberately absent from this archive;
their SHA-256 commitments are in the evaluator evidence. Temporary author-host
authentication copies were deleted. The Node worker ran under the real
Linux/Bubblewrap backend with Node `24.15.0`.

## Setup issues and scope

The first author launch was blocked by the client's MCP approval defaults and
wrote no files. After explicitly authorizing only the three Gate tools, an
author completed source and build successfully, but an evaluator-only sealing
probe mishandled an immediate `STATE_INVALID` rejection and stopped before any
worker launch. The probe was fixed and tested. The successful run then used a
new empty submission and a fresh author context; neither author received a
private model verdict or hidden-case feedback.

The experiment also required an additive public API repair: authoring commands
now return bounded, correlated stdout/stderr through `SandboxAuthoringSession`.
The successful evaluation calls public `evaluateSandboxed()` and uses the
packed public Gate SDK; it does not depend on a test-only evaluator entry point.

Final regression testing also exposed an existing fractional-timer race in the
generated async binding. The compiler now rechecks the monotonic deadline and
rearms early callbacks. The authored files were unchanged and passed the same
four private traces again with that corrected binding; the supplementary record
is separate from the original fresh-authoring evidence.

Final verification passed: MirrorECMA 340/340 Jest cases across 17 suites, all
relevant TypeScript checks, three evaluator sealing tests, the author dispatcher
audit, and Mirrors `lake test` with live Apalache (`ALL LAKE TESTS GREEN`).

This demonstrates the recorded Node workflow and access boundaries. It does not
prove that a public Counter model has never appeared in model training, nor
general noninterference or observation fidelity for arbitrary submitted code.
