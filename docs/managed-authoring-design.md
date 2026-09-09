# Superseded: managed authoring through MirrorECMA

The proposal to add a managed-agent `author` option to MirrorECMA was superseded
on 2026-09-09 by [MBT against implementations](implementation-boundary-design.md).
MirrorECMA retains implementation-neutral MBT semantics. The user-started
coordinator interacts directly with MirrorGate; a separate trusted integration
supplies the resulting implementation proxy to MirrorECMA.

This superseded proposal was not implemented. The existing experimental
`evaluateSandboxed` facade still requires the migration described in the new
design; neither removal of that facade nor runtime decoupling has happened yet.
