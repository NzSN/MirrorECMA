# Compiler-generated projected-corpus test artifacts

These files come from the public synthetic fixture at
`Mirrors/test/fixtures/model-interface/projected-cells`. They contain no private
application model or trace. The explicit `approved: true` review is test data
bound to that fixture's unchanged proposal; it is not inferred human approval.

Regenerate from the Mirrors checkout:

```sh
python3 tools/model-interface-projected-corpus/check.py \
  --out /tmp/projected-cells-acceptance
```

The resulting `relocated-install/application` contains the checked `corpus/`,
`sealed/`, `ProjectedCells.lock.json`, and `source/` trees. Refresh the matching
files here by copying those compiler outputs. For `bundle/`, copy only files
listed by `application/generated/.suite-bundle-generated.json` from that
`generated/` directory; emitted JavaScript used for the installed runtime is
not part of this TypeScript test fixture. Do not edit generated artifacts or
extract a companion contract from an unsealed proposal.

`test/projected-corpus.test.ts` verifies the loader's strict parsing, file and
workflow identities, containment, resource bounds, source normalization, and
mutation rejection before acquisition. The cross-repository command separately
runs one suite locally and through Gate's real worker bridge, checking native
Set/Map values, success and Update/Update coverage, an actual expected/actual
model mismatch, deferred acquisition, and independent cleanup outcomes.

The copied artifacts are source regression fixtures. A passing unit test alone
does not establish installed runtime acceptance or release qualification.
