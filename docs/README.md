# MirrorECMA documentation

MirrorECMA performs model-based testing against an implementation supplied by the
caller. The current generic negotiation, generated-binding, replay, report, and
disposal APIs are the foundation. The 2.0 source cutover removes the Gate-aware
facade and optional peer; see the [migration guide](migration-v2.md).

Application-integration acceptance completed on 2026-09-16–17, including
relocated offline consumers, the three application matrices, actual restricted
authors and an automated fresh-evaluator onboarding study. The
[execution record](https://github.com/NzSN/Mirrors/blob/main/Docs/application-integration-progress.md)
distinguishes those results from earlier workflow gates, lists skipped tiers,
and records retained evidence and temporary-log availability. Publication and
human usability remain separate claims.

## Choose an entry point

| Need | Read | Status |
| --- | --- | --- |
| Define and run a new application suite | [Application suites](application-suites.md) | Default Node application API: immutable definition, checked corpus, matched acceptance and cleanup |
| Configure installed tools and run project doctor/check/replay | [Project tools](project-tools.md) | Declarative loader, CLI and installed acceptance gate |
| See complete local and Gate suite examples | [Application validation](../examples/application-validation/README.md) | WorkQueue, transfer and lease use generated suite bundles and `runSuite` / `evaluateSuite` |
| Maintain the synchronous registry compatibility path | [Generated Counter tutorial](../examples/generated-counter/README.md) | Low-level runnable example; not the default new-application path |
| Async operations, cancellation, reports, and binding lifetime | [Replay and async reference](replay-and-async.md), [work queue](../examples/work-queue/README.md) | Implemented APIs and runnable example |
| Understand MirrorECMA/Gate ownership | [Implementation boundary](implementation-boundary-design.md) | 2.0 source boundary; package publication separate |
| Review projected-collection workflow history | [Implementation boundary](implementation-boundary-design.md#projected-collection-workflow-findings), [Gate follow-ups](https://github.com/NzSN/MirrorGate/blob/main/docs/sandbox/restricted-workflow-followups.md) | Historical findings; suite native vectors and application-integration acceptance are delivered, while unrelated follow-ups remain open |
| Use one suite from source tests, CLI, or an evaluation proxy | [Reusable MBT harness](mbt-harness-design.md) | Runnable source/CLI suite; Gate-owned loopback service validated separately |
| Review the completed extraction and harness migration | [AH8 work packages](mbt-integration-tasks.md) | Integrated implementation and validation ownership |
| Run managed authoring and evaluate the result | [Installed Gate Counter workflow](https://github.com/NzSN/MirrorGate/blob/main/integrations/mirrorecma/examples/counter/README.md) | Actual coordinator/implementer MCP workflow validated |
| Run restricted evaluation | [Gate integration](https://github.com/NzSN/MirrorGate/blob/main/integrations/mirrorecma/README.md) | Separate package; old shape under `/legacy` |
| Reproduce the existing fresh-author experiment | [Blind Counter](../experiments/blind-counter/README.md) | Historical helper-driven experiment; current managed path is in Gate |
| Inspect historical shared-facade behavior and evidence | [Landing design](shared-orchestration-design.md), [acceptance ledger](shared-orchestration-acceptance.md) | Historical coupled implementation and recorded validation |

## Responsibilities and current limits

The user starts the coordinating agent and requests restricted implementation
directly from MirrorGate. A separate trusted
integration supplies the resulting implementation factory/proxy to MirrorECMA.
MirrorECMA does not gain agent prompts, Gate endpoints, build plans, or service
RPC as core MBT semantics. The managed-agent `author` proposal is
[superseded](managed-authoring-design.md), not an available API.

An implementation proxy invokes operations on an external SUT. An evaluation-
service proxy requests a whole MBT run. A source test, CLI, and service can share
one approved suite; the service and Gate integration remain external wrappers.
Private suites/models must stay outside implementer access even when test files
are versioned beside application source.

MirrorECMA's boundary does not depend on Mirrors compiler internals. Mirrors'
separate proposal-scaffolding and trace-projection additions preserve this
dependency direction. Gate's
[hosting design](https://github.com/NzSN/MirrorGate/blob/main/docs/agent-hosting-design.md),
[task ledger](https://github.com/NzSN/MirrorGate/blob/main/docs/agent-hosting-tasks.md),
and [optional evaluation service](https://github.com/NzSN/MirrorGate/blob/main/docs/evaluation-service-design.md)
describe the implemented external modules. [Final coordinated validation](https://github.com/NzSN/MirrorGate/blob/main/docs/managed-workflow-validation.md)
records their separate runtime, package, service and interop evidence.

Dated documents under `superpowers/` and the original server-mode design record
earlier decisions; use current source/API references and the acceptance ledger
when assessing what is implemented. Planning reviews and passing legacy gates
do not establish that runtime extraction, new hosting, or service delivery passed.
