# Persistent transfer implementation contract

Implement `adapter.mjs`, exporting async `createAdapter()`. It returns
`{actions, observe}`. Use an isolated writable temporary directory for the real
payload bytes and journal. Actions return `undefined` or a promise resolving
to `undefined`; integer inputs/observations use `bigint`.
Chunk values are bytes in the inclusive range 0–255; offsets are nonnegative.

- `Initialize({})`: reset Session to 0, Phase to `idle`, Data to an empty
  sequence, Committed and Accepted to false, including on repeated calls.
- `Begin({})`: called only while idle or cancelled. Increment Session, clear
  payload, set Phase `open`, Committed false and Accepted true.
- `Chunk({Token,Offset,Value})`: accept only while open, with Token equal to
  Session and a nonnegative byte offset. Append the byte if Offset equals the
  current length. A retry at an existing offset succeeds without writing when
  its value matches. Reject gaps, wrong values and stale tokens. Set Accepted
  to the outcome. Rejection changes no other state.
- `Pause({})` / `Resume({})`: switch an open transfer to `paused` or a paused
  transfer to `open`. Preserve payload and other fields.
- `Restart({})`: discard in-memory service state and reopen the persisted
  journal and payload. Preserve every observable field. This models an orderly
  restart between completed operations, not a crash during a filesystem write.
- `Commit({})`: succeeds only while open with exactly two payload bytes. On
  success set Phase `done` and Committed true. Set Accepted to success; on
  rejection preserve every other field.
- `Cancel({})`: clear payload; set Phase `cancelled`, Committed false and
  Accepted true; retain Session to fence old clients after the next Begin.

`observe()` reads actual stored journal fields and payload bytes and returns
exactly `{Session, Phase, Data, Committed, Accepted}`. Data is an array of
bigints. Do not maintain a separate expected-state mirror. Operations are
serialized. Optional `dispose()` removes the isolated store after local use;
Gate independently owns physical sandbox cleanup.
