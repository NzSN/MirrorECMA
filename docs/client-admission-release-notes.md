# Client admission changes

Prepared 2026-10-15 for the next release.

Compiled negotiated runners now enforce the exact generated target and computer
contract pair consistently across callback and explicit execution entry points.
`mirrorecma-v1` requires `mirrors.state-computer/v1`. `mirrorecma-async-v1` and
`mirrorecma-async-v2` require `mirrors.async-state-computer/v1`. Invalid selections
fail before adapter lookup, transport acquisition, or implementation construction,
even when their digest and adapter ID match a registered key. Error codes remain
`state_computer_contract_mismatch` for incompatible contracts and
`target_profile_mismatch` for unsupported targets or execution/target mismatches.

Applications that registered an asynchronous computer under `mirrorecma-v1`
must regenerate and use the appropriate async target with its matching adapter
key. Use the compiler-owned bundle generation and freshness checks documented in
[project tools](project-tools.md). Relabeling old generated metadata does not
produce a correctly generated async binding. A real synchronous binding continues
to use the synchronous pair. Dynamic descriptor selections keep their existing
target-neutral scope and cleanup behavior.

On POSIX, TLS client keys now require exact permission mode `0600`, including
clear set-user-ID, set-group-ID, and sticky bits. Owner-only `0400` and `0700`
keys, group/other-accessible keys, and special-bit variants are rejected locally.
The diagnostic states the required mode. After reviewing the intended key path,
owners can set its mode explicitly with `chmod 0600 /path/to/client.key`.
MirrorECMA never changes caller-owned key contents or permissions automatically.
Native Windows retains its existing platform-specific behavior; this POSIX rule
does not establish a Windows ACL check.

These are local admission changes. Correct compiled pairings and POSIX `0600`
keys retain the existing wire messages; no server or certificate migration is
required. Deploy the new client package together with any regenerated bindings.
