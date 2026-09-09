# Superseded: managed authoring through MirrorECMA

The proposal to add a managed-agent `author` option to MirrorECMA was superseded
on 2026-09-09 by [MBT against implementations](implementation-boundary-design.md).
MirrorECMA retains implementation-neutral MBT semantics. The user-started
coordinator interacts directly with MirrorGate; a separate trusted integration
supplies the resulting implementation proxy to MirrorECMA.

The superseded MirrorECMA managed-author option was not implemented. The
[2.0 migration](migration-v2.md) is complete: `evaluateSandboxed` moved to
`mirrorgate-mirrorecma/legacy`, and core has no Gate dependency or facade.
Managed authoring instead uses Gate control v2 and its installed MCP adapter;
[final validation](https://github.com/NzSN/MirrorGate/blob/main/docs/managed-workflow-validation.md)
includes actual coordinating and implementing Codex processes.
