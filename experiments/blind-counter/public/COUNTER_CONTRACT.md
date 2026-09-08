# Counter public implementation contract

Submit exactly two ECMAScript modules at the workspace root:

- `adapter.mjs` exports `createAdapter()`.
- `build.mjs` exports `runBuild()` and performs the submission's own public
  checks. It may import `adapter.mjs`. A successful call returns `undefined`.

`createAdapter()` returns an object with exactly these public operations:

```text
actions.Initialize({})
actions.Tick({ Stride })
observe() -> { Count }
```

The implementation requirements are:

1. `Initialize` resets the implementation's stored count to `0n`.
2. `Tick` adds the supplied `Stride` bigint to that stored count.
3. `observe` returns the actual stored count as the bigint field `Count`.
4. Action functions return `undefined`. They may be synchronous or async.
5. `createAdapter` may be synchronous or async. An optional `dispose` function
   may be returned.
6. The adapter must expose exactly `Initialize` and `Tick` in `actions`.

The evaluator holds its model, replay cases, expected states, and diagnostics
privately. The sandbox gives authoring tools a writable `/workspace`, a private
scratch directory, the approved Node and Python runtimes, no network, and no
inherited host environment. Use relative paths and keep all submission files
in the workspace root.

The build phase runs `runBuild()` in a fresh restricted environment over a
read-only frozen source snapshot. The evaluator then packages `adapter.mjs`
from that snapshot for the restricted worker. No live authoring path is mounted
in the evaluation worker.
