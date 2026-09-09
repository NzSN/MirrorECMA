# Blind Counter authoring experiment

Status: existing helper-driven experiment and historical acceptance source.
Its author-host scripts still launch/configure the agent outside Gate's control
API. The [current target](../../docs/implementation-boundary-design.md) instead
has the coordinator call Gate directly, with a separate integration supplying
the implementation to generic MirrorECMA MBT. [AH8](../../docs/mbt-integration-tasks.md)
owns managed-workflow migration. The current helper-driven evaluator imports
`mirrorecma` and `mirrorgate-mirrorecma/legacy` as installed public packages;
it does not use removed MirrorECMA root exports. This compatibility import change
does not replace helper hosting with the managed Gate API.

This experiment starts with an empty source directory, lets an isolated coding
agent author a Counter through MirrorGate-managed Node or Python commands, seals
and builds that source in a separate restricted phase, and evaluates the frozen
artifact through MirrorECMA against a privately held Counter model and traces.

The [completed 2026-09-08 run](results/2026-09-08/REPORT.md) passed four private
traces after fresh Gate-only authoring, restricted build, and source freezing.
Its authored source, public transcript, capability audit, and cleanup receipts
are archived alongside the report; private model and trace contents are not.

It is an evaluator harness, not a Counter implementation. No existing Counter
source is copied into the submission. The only author-visible materials are the
files under [`public/`](public/), MirrorGate's sanitized public port manifest,
and outputs from that author's correlated tool commands.

Install compatible locally packed `mirrorecma` (2.0), `mirrorgate` and
`mirrorgate-mirrorecma` packages in the evaluator consumer before running it.
`mirrorEcmaCompiledRoot` now identifies `dist-test` containing only the generated
fixture/evidence tree; library code resolves through package names. The original
configuration field is retained for this historical helper interface.

## Boundary and flow

```text
isolated author -> MCP shim -> Unix JSONL broker -> SandboxAuthoringSession.exec
                                            |              |
                                            |              v
                                            |       MirrorGate authoring bwrap
                                            v
                                      submit/seal
                                            |
                         fixed restricted build hook + source snapshot
                                            |
                           frozen guarded Node worker artifact
                                            |
                 generated async binding <-> Mirrors private replay
```

The evaluator config, Gate policy, `Counter.tla`, private traces, expected
states, Gate control channel, and detailed evaluator diagnostics never enter
the broker contract. The agent host must disable every access-capable tool other
than its broker-backed MCP tools; this harness cannot make an unrestricted host
agent blind.

## Broker contract

The broker is a local Unix socket in a caller-created mode-`0700` directory.
Each connection carries one LF-terminated JSON request and receives one
LF-terminated JSON response. Request IDs are positive, unique safe integers.

```json
{"id":1,"op":"contract"}
{"id":2,"op":"exec","toolId":"author.node","args":["--version"]}
{"id":3,"op":"exec","toolId":"author.python","args":["-c","print('ok')"]}
{"id":4,"op":"submit"}
```

`contract` returns the public files and manifest. `exec` selects one of two
fixed operator commands and appends at most 65,535 bytes of arguments. It always
runs at the submission root. The response includes exit code, correlated
stdout/stderr, byte counts, and truncation flags. At most 65,536 bytes per
stream are returned. Gate operation failures are reduced to a fixed public
error category. `submit` permanently closes authoring and lets preparation
start.

The harness creates an exclusive ready file after the Gate session exists and
the evaluator-owned authoring canary has passed. Its schema is
`mirrorecma.blind-counter-broker-ready/v1`. It contains the socket address and
public bounds but no evaluator, model, trace, or control paths. The MCP shim may
read this trusted file; it must not return the socket address or host paths to
the author.

## Operator setup

Use fresh private paths; do not modify and reuse the checked-in example JSON.
Create a submission root containing an empty `fresh-counter/` directory and a
separate mode-`0700` directory for the broker socket and ready file. Keep the
operator/evaluator configs, policy, private model, traces, and evidence outside
the submission root and every approved runtime mount. Create the synthetic
canary named by `publicProbePaths` as a regular file outside those roots. Its
path is intentionally public; its random contents remain evaluator-private.

Build the generic example/generated fixture output and pack MirrorGate's public SDK:

```bash
pnpm run build:examples
npm --prefix /operator/MirrorGate pack --pack-destination /private/blind-counter/pack
```

Extract that archive as `node_modules/mirrorgate` under the MirrorECMA consumer
that contains the evaluator and compiled output, and set `gateSdkRoot` to that
exact directory. The harness verifies normal package resolution selects the
same packed `mirrorgate/control` and `mirrorgate/worker` files, and records the
packed tree identity. It calls the public compiled `evaluateSandboxed` facade
with the generated async Counter binding. `counterInterfaceLockPath` selects
the compiler-owned lock used to reconstruct the trusted descriptor; include
that path in the private boundary probes.

Copy `operator-config.example.json` to the private area, replace every path,
and generate the exclusive control policy:

```bash
node experiments/blind-counter/make-policy.mjs \
  --config /private/blind-counter/operator-config.json
```

The policy exposes fixed `/runtime/node/bin/node` and isolated
`/usr/bin/python3 -I -S` authoring tools. `publicProbePaths` contains only an
intentionally disclosed synthetic canary path outside every mount. The fixed
build command checks that this canary and the named evaluator environment
canaries are absent, invokes the author's own `build.mjs#runBuild`, validates
`adapter.mjs`, and writes a frozen execution wrapper. That wrapper repeats the
same synthetic-canary guard before importing the submitted adapter in the
worker. Never put an actual model, trace, evaluator-config, or policy path in
`publicProbePaths`: build argv and the frozen wrapper are inspectable by the
submission.

Copy `evaluator-config.example.json` to the private area and replace every
path. `privateProbePaths` must include the evaluator config itself, the policy,
the compiler-owned interface lock, the private spec, and every private trace.
These actual paths are used only in an evaluator-owned authoring probe before
the broker opens; they are excluded from the public transcript, build command,
and artifact. Set every named environment canary only in the trusted evaluator
process.

Start the evaluator:

```bash
BLIND_COUNTER_PRIVATE_CANARY=unpublished-random-value \
node experiments/blind-counter/evaluator.mjs \
  --config /private/blind-counter/evaluator.json \
  --broker-socket /private/blind-counter/broker/author.sock \
  --ready-file /private/blind-counter/broker/ready.json
```

After `broker.ready`, start the isolated author host. Its only resource-capable
MCP methods should map to `contract`, `exec`, and `submit`. Before giving the
real task to the author, query its advertised tool inventory and verify that a
non-Gate tool request is rejected.

The included author-host helpers implement that restriction for the tested
Codex CLI `0.153.4`. Use an exact local catalog containing `gpt-5.6-sol` and
an existing operator-owned Codex authentication file. The authentication copy
stays in the private author-host directory and is deleted by the runner.
Neither file belongs in the submission or experiment archive.

```bash
python3 author-host/audit_tools.py \
  --host-root /private/blind-counter/tool-audit \
  --catalog /operator/codex/models_cache.json \
  --output /private/blind-counter/tool-audit.json

python3 author-host/prepare_author.py \
  --host-root /private/blind-counter/author \
  --broker /private/blind-counter/broker/author.sock \
  --catalog /operator/codex/models_cache.json \
  --auth /operator/codex/auth.json

printf '%s\n' \
  'Read public_contract, implement from the empty workspace using only gate_exec, run public checks, and submit.' \
  > /private/blind-counter/author/prompt.txt

python3 author-host/run_author.py --host-root /private/blind-counter/author
```

Run these commands from this experiment directory; every `--host-root` must
be fresh. The configuration disables native shell, patch, image, browser,
memory, plugin, app, and delegation access. Model-catalog delegation is also
disabled because feature flags alone do not remove it. Only the three Gate
MCP methods receive explicit approval; the ordinary host tools stay absent.
Resource discovery returns no resources. The audit uses a synthetic local
model to exercise the actual dispatcher, including an approved Gate call and
rejected native calls; the real author uses a separate fresh context.

Place the evaluator copy and the compiled MirrorECMA tree under an ancestor
containing `node_modules/mirrorgate` extracted from the packed SDK. This keeps
both public imports resolving to the same SDK without installing Gate into the
ordinary MirrorECMA checkout. The successful run used this isolated layout.

## Evidence and acceptance

The trusted evidence file is created with mode `0600` and never overwritten.
It records:

- the empty initial source manifest and hash;
- the complete public broker request/response transcript;
- the post-authoring source manifest and hash;
- Gate's authoritative source, artifact, manifest, policy, runtime, and
  prepared-revision identities;
- rejection of an authoring command after preparation sealed the source;
- authoring/build/execution private-boundary guards;
- confirmation that no actual evaluator-private path string occurs in the
  trusted policy/build command or submitted source (the generated artifact is
  composed only from those two inputs);
- hashes of the compiled evaluator, packed Gate SDK, Mirrors binary, private
  spec, private traces, and public bundle;
- a bounded redacted public verdict, Gate event counts, and cleanup receipt.

Acceptance requires a passed private replay, confirmed cleanup, matching local
and Gate source hashes, a successful fixed build guard, and `STATE_INVALID` for
the post-prepare authoring attempt. Control v1 may reject that attempt directly
or return an operation whose terminal outcome carries `STATE_INVALID`; the
harness records which form occurred and rejects every other result. A passed replay also proves the frozen
execution wrapper reached and passed its guard before loading the submitted
adapter. Preserve the ready file, evidence file, isolated author tool inventory,
MCP rejection result, and author-host transcript together for review.

This experiment establishes the tested access and workflow boundaries for one
Linux/Bubblewrap Node run. It does not prove general noninterference or that an
arbitrary observer truthfully reflects its SUT; the public contract therefore
requires `observe` to read the implementation's actual stored count.
