# MirrorECMA documentation

MirrorECMA performs model-based testing against an implementation supplied by the
caller. The current generic negotiation, generated-binding, replay, report, and
disposal APIs are the foundation. The 2.0 source cutover removes the Gate-aware
facade and optional peer; see the [migration guide](migration-v2.md).

## Choose an entry point

| Need | Read | Status |
| --- | --- | --- |
| Connect a local implementation to a generated model interface | [Generated Counter tutorial](../examples/generated-counter/README.md) | Runnable example |
| Async operations, cancellation, reports, and binding lifetime | [Replay and async reference](replay-and-async.md), [work queue](../examples/work-queue/README.md) | Implemented APIs and runnable example |
| Understand MirrorECMA/Gate ownership | [Implementation boundary](implementation-boundary-design.md) | 2.0 source boundary; package publication separate |
| Review projected-collection workflow follow-ups | [Implementation boundary](implementation-boundary-design.md#projected-collection-workflow-findings), [Gate follow-ups](https://github.com/NzSN/MirrorGate/blob/main/docs/restricted-workflow-followups.md) | Proposed ownership and acceptance criteria; not implemented |
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
