# Private reproduction bundles

Status: R1 contract, schema `mirrorecma.reproduction-bundle/v1`.

A reproduction bundle is evaluator-owned, inert data. It records enough fixed
identity and normalized failure information to ask a trusted local or Gate
evaluator to reproduce one result. It never selects executable code, imports a
module, runs a hook, resolves an ambient URL, installs a dependency, or changes a
Gate policy. The caller supplies the approved implementation factory, resolver
registry, installed tools, and execution profile after validation succeeds.

The JSON schema is [`../schemas/reproduction-bundle-v1.schema.json`](../schemas/reproduction-bundle-v1.schema.json).
Schema validation is necessary but not sufficient: the semantic checks below are
also mandatory.

## Versioning and identities

Version 1 is a closed object. Consumers fail closed on an unknown major or minor
schema name and on unknown fields. A future additive field therefore requires a
new reviewed schema and explicit consumer support; a consumer never guesses that
an unknown field is harmless.

`evidenceLinks.runRef`, `componentRefs`, `artifactRefs`, and
`catalogSelectionRef` are opaque
references owned by the E1 evidence-envelope and C2 framework-catalog contracts.
This contract does not restate or reinterpret their fields. At the R1 baseline
their logical schemas are `mirrors.evidence-envelope/v1.0` and
`mirrors.framework-catalog/v1`. Bundle validation delegates those references to
their owners before accepting the bundle.

The reproduction-specific `identities` object is fixed and complete:

| Field | Meaning |
| --- | --- |
| `suite` | Suite ID plus SHA-256 of its frozen definition. |
| `model` | SHA-256 of the reviewed model source closure. |
| `corpus` | SHA-256 of the ordered occurrence list plus its exact trace count. Repeated traces remain repeated occurrences. |
| `generatedInterface` | Semantic interface digest, generated module SHA-256, target profile, and state-computer contract. |
| `implementation` | Evaluator admission ID and approved source/package closure SHA-256. |
| `executionProfile` | Named local or Gate profile and immutable profile SHA-256. |

All SHA-256 values are lower-case hex over the bytes named by their owning
contract. Product or package version strings are metadata, never substitutes for
these identities. Loading checks the shape, name, and declared digest of every
identity and external reference without invoking a resolver. Explicit replay
preflight later checks compatibility and resolves admitted references before
constructing an implementation, importing its entry module, opening its model
transport, or acquiring a Gate worker. Missing, duplicate, or mismatched
identities return a structured refusal.

## Failure signatures

`signature.primary` and `signature.cleanup` are independent. Coordinates are
zero-based. Signature equality first requires the same bundle schema and then
exact equality of every field in both components; no message text participates.

| Primary kind | Equality fields |
| --- | --- |
| `behavioral_mismatch` | `code`, `traceIndex`, `stateIndex`, `action` |
| `timeout` | `stage`, `budgetMs` |
| `execution_error` | `origin` (`observer` or `implementation`), `stage`, `code` |
| `codec_error` | `stage`, `code` |
| `coverage_unmet` | the exact sorted, duplicate-free `requirements` list |
| `cancellation` | `stage`, `code` |

Cleanup equality uses `status` and, for `failed` or `unconfirmed`, its stable
`code`. `succeeded` forbids a code. A cleanup-only bundle has `primary: null` and
failed or unconfirmed cleanup. `primary: null` with successful cleanup is
contradictory. A timeout, execution/observer error, codec error, coverage failure,
cancellation, or cleanup-only failure never equals a behavioral mismatch. A
mismatch with failed cleanup also does not equal the same mismatch with successful
cleanup.

Stability and reduction require exact equality of the complete declared
signature and independently confirmed (or explicitly non-applicable) cleanup for
every required scope. A policy cannot weaken this equality to primary behavior
alone. A candidate is eligible only after stable, resettable reproduction. An
original mismatch bundle with failed cleanup remains authoritative but is not
eligible until an independent clean capture establishes that precondition.

## Captured data and external references

Each capture is either bounded inline bytes or an immutable external reference.
Inline bytes use base64 and a digest over decoded bytes. They are never parsed as
JavaScript or treated as a module. External references have exactly `type`,
`sha256`, and an evaluator-owned `resolver`; they contain no URL, filesystem path,
command, package locator, or credentials. The caller provides a closed resolver
registry. Resolution must reproduce the declared bytes and digest without ambient
network lookup.

The mandatory decoder limits are checked while reading, before allocating the
implementation or Gate worker:

| Limit | Value |
| --- | ---: |
| UTF-8 bundle bytes | 8,388,608 |
| JSON nesting depth | 32 |
| JSON nodes | 100,000 |
| members per object | 256 |
| elements per array | 4,096 |
| UTF-8 bytes per string | 65,536 |
| ordered traces | 4,096 |
| captures | 128 |
| external references | 64 |
| decoded bytes per inline capture | 262,144 |
| decoded bytes across inline captures | 1,048,576 |
| diagnostic text bytes across captures | 16,384 |

The 65,536-byte string limit applies to ordinary decoded strings. The `base64`
field alone has a 349,528-character encoded limit so a 262,144-byte inline
capture is representable; decoded bytes and canonical base64 are still checked
against the stricter inline limits.

The in-memory capture API rejects cycles, accessors, functions, symbols,
prototypes other than `null`/`Object.prototype`, and graphs beyond these bounds
before canonicalization. JSON fixtures cannot themselves contain a cycle; the
rejected `$ref` fixture reserves and rejects graph-reference syntax so a producer
cannot smuggle a cyclic object encoding into the byte form.

The validator rejects executable or ambient authority fields such as `script`,
`command`, `module`, `entryPoint`, `dependency`, `url`, and `path` wherever they
are not explicit identity metadata. It also rejects credential field names and
well-known credential forms, including authorization/cookie headers, passwords,
private keys, bearer tokens, access/secret keys, and connection strings. Capture
producers must redact before hashing; redaction changes the artifact identity and
is recorded as a new capture rather than mutating retained evidence.

## Consent, handling, and disclosure

Capture requires an affirmative evaluator policy naming the allowed capture
roles, maximum retention, access principals, and redaction profile. Default
consent is denied. The trusted store records creation, access, redaction,
retention expiry, and deletion outcomes through E1 evidence links. Deletion is an
explicit store operation; expiry does not claim bytes were erased until the store
confirms it. Bundles and resolved artifacts remain private unless a separate
disclosure policy approves individual public fields.

The only public projection is `mirrorecma.reproduction-public-summary/v1`:

- opaque E1 run reference;
- normalized top-level status (`mismatch`, `timed_out`, `failed`, `cancelled`, or
  `cleanup_failed`);
- cleanup status;
- explicitly approved aggregate counts;
- explicitly approved implementation hashes.

It excludes expected/actual states, trace values, action and coordinate details,
diagnostic/exception text, raw paths, external-reference details, private
revisions, model/corpus/interface content, and capture payloads. A private-data
canary placed in every sensitive field must be absent from serialized public
output.

## Refusal order and inertness

Loading means bounded UTF-8/JSON decoding and validation only. The loading order
is: structural bounds; closed schema; credential/executable-field scan; E1/C2
reference shape validation; and reproduction identity/digest declaration
validation. Loading stops there and never invokes an external resolver. A
separately requested replay preflight then checks compatibility and resolves only
an admitted resolver name to bytes whose digest must match. Only after that
preflight may the caller create an already approved implementation or acquire
Gate resources. Every rejected fixture must leave counters for resolver calls,
imports, network requests, subprocesses, factory calls, and Gate acquisitions at
zero.

The eight accepted fixtures are behavioral mismatch, timeout, observer error,
implementation error, codec error, unmet coverage, cancellation, and cleanup
failure. Each fixture contains exactly one bounded inline capture and one
immutable external reference, so both forms are exercised for every family.
Rejected fixtures cover the semantic failures that JSON Schema alone cannot
express. R2 must preserve these refusal and zero-side-effect properties.

## Runtime API and replay order

`decodeReproductionBundle` and `validateReproductionBundle` are the production
decoders. They apply byte, fatal UTF-8, duplicate-key, graph, schema, E1/C2
reference, credential, and capture checks without invoking a resolver.
`captureReproduction` normalizes a `SuiteResult`, retains the trusted raw result
non-enumerably, and reports requested persistence separately without rewriting
the behavioral outcome.

`preflightReproduction` takes evaluator-owned expected identities, a catalog
selection, E1/C2 validators, a closed resolver allowlist, and a bounded resolver
callback. Evidence/compatibility callbacks and external resolution each have
explicit deadlines and cancellation; external bytes also have per-reference and
aggregate limits. `replayReproduction` invokes its evaluator only after that
preflight. A reported reproduction is accepted only when both its expected and
observed signatures equal the bundle signature.

`inspectProjectReproductionAuthority` derives identities from actual prepared
suite, model-closure, ordered-corpus, generated-module, implementation-entry,
server, and execution-profile bytes without importing either module.
`reproduceProject` validates the explicit `catalogSelectionRef` and
`combinationId` before imports, then rechecks server/model/implementation hashes
at use. It never embeds the provisional catalog digest.

The installed command is `mirrorecma reproduce --project FILE --bundle FILE
--framework-input FILE --combination ID --evidence-envelope FILE
--output-root PRIVATE_OUTPUT [--artifact-store DIRECTORY]`. `framework-input` contains exactly `catalogRaw`
and the C5 `InstalledFrameworkObservation`; its manifests/cache bind finalized I2
artifact and runtime-tree identities. The evidence envelope must hash to the
bundle's `runRef`. The optional artifact store is content-addressed by capture
SHA-256 and admits only resolver `evidence-envelope/v1`. Exit 0 means the exact
signature reproduced, 1 means it did not reproduce, and 2 means refusal or
operational failure. Existing `replay` exit semantics are unchanged.
The output root is a pre-existing owner-only mode-`0700` directory. The command
exclusively creates `reproduction-result.json`
(`mirrorecma.reproduction-replay/v1`) and `reproduction-cleanup.json`
(`mirrorecma.reproduction-cleanup/v1`, containing the retained suite outcome
and cleanup record). Qualification supplies the optional content-addressed
artifact store explicitly so its frozen argv does not depend on whether the
selected bundle currently uses inline or external captures.

`classifyReproductionStability` records attempt, total, per-attempt, and cleanup
budgets. Timeout/cancellation gives the aborted suite a separate cooperative
settlement budget, and loss of cleanup independence stops later attempts.
`reduceReproductionPrefix` binds the complete bundle digest, exact stable result,
mismatch coordinate, reset eligibility, and successful cleanup. It
model-validates each prefix before SUT acquisition. Any invalid shorter prefix
prevents a `shortest reproducing prefix` claim.

## Initial domain-reduction candidate

The source-backed candidate for R5 is `lease-service-input-shrink/v1`, not a
general reducer. Its first transform changes a supported `Client` or `Token`
integer from 2 to 1 without deleting steps, so trace/state/action coordinates are
preserved. The known `overlapping-ownership` mismatch at
`(0, 2, "acquire")` survived `Client: 2 -> 1`: the faulty service reported
`Accepted = TRUE` while the model reported `FALSE`.

The request binds the selected trace's byte digest and the exact repeated ordered
occurrences `[0, 1]` in addition to the original bundle/corpus identity. The
fresh-candidate validity oracle is an evaluator-owned Apalache explorer over
the pinned LeaseService source closure. For each unchanged action sequence it constrains the
next state's `action_taken` and `parameters`, advances the model, and materializes
the full model state before any SUT construction. The interface lock supplies the
stable-ID/wire/input mapping. Supported fields are `Acquire.Client`,
`Renew/Release/Write.Client`, and `Renew/Release/Write.Token`, each in `{1,2}`;
`Advance.Amount` remains fixed at 3. Unsupported actions and fields are preserved.
The profile records the model closure, interface lock, Apalache launcher/JAR,
Java executable/archive, qualification reference, and validator implementation
identities. A version string does not imply distribution qualification. This profile requires pinned Apalache and
the private spec; ordinary checked-corpus replay remains Java-free. A second
application returns `reduction_profile_unsupported` without mutation.

The pure request contract and development evidence are documented in Mirrors'
[`model-interface-reduction.md`](../../Mirrors/Docs/model-interface-reduction.md).
Cached Apalache 0.61.0 and the exact Microsoft OpenJDK `25.0.4+7-LTS` archive
generated and typechecked the complete candidate trace. The real local suite
reproduced the same signature with cleanup confirmed. Installed-distribution
qualification remains a separate I2/C5/E4 evidence claim.
