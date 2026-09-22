# Config and working-copy execution

## Task boundary

The execution handoff is `/tmp/epicenter-config-execution-handoff.md`.
Task-start HEAD was `5cf1ffb78c4ef04570f36ea746e11f5f62fe0126`, ahead 42 and
behind 1. The task started with the CLI, compiler, field-diff, and ADR drafts
listed in that handoff. Other dirty app, Svelte, UI, skill, and report files
belong to concurrent work. No staging, commits, rebases, or deployments are
part of this execution.

## Wave 1: executable config validation

The CLI imports `epicenter.config.ts` through the existing compiler. The
abandoned JSON compiler and recursive schema gate are deleted. Global
console diagnostics use stderr; the command report uses stdout. Import and
compile failures reach the command error boundary. File parsing retains
per-file diagnostics and strict UTF-8 decoding.

Compiler regression coverage includes contextual invalid-regex errors,
nullable-wrapper keyword refusal, stored nullable presence, and local JSON
Schema references. Artifact, definition, and Matter tests: 364 pass. App data
and scripts typechecks pass. All 30 subprocess CLI tests pass (93 assertions),
including a real Honeycrisp definition import. Two independent reviewers each
reran the CLI and compiler tests: 39 pass, 113 assertions.

The first review found a remaining output defect: a config's named
`node:console` import writes to stdout under Bun 1.3.14 even after global
console redirection. `syncBuiltinESMExports` and Bun loader hooks did not
redirect that built-in export in isolated subprocess checks. Global console
and deferred global diagnostics pass. In the continuation, the user authorized
the trusted-code exception after verification. Named builtin console exports,
including namespace access, remain outside global console redirection. ADR-0420
and the README now state that output can be invalid JSON even with exit code 0.

Both reviewers retained existing compiler semantics and the separation of
config, manifest, and receiving permissions. Their accepted steering for the
remaining implementation is:

- Remove the old app-side confirmation and repeated-preview lifecycle. Its
  only callers are tests and a benchmark. The canonical-folder host owns
  captured input and unfinished state; the app owner admits and applies edits.
- Let the filesystem host interpret manifest metadata. Keeping it blind would
  distribute folder-operation state across the host and app.
- Select a user-editable title from actual product callers. Honeycrisp derives
  note titles from body content, so the config smoke test is not evidence that
  title is an independently permitted mutation.
- Refuse reserved row fields before any mutation, even if a permission list
  includes them. Check all raw row identities in the synchronous apply span.

The documentation hygiene check reports 64 issues, matching the count noted
in the handoff. No broad ADR status changes were made.

## Remaining checkpoints

Config validation's review checkpoint is closed. The following implementation
remains unfinished.

1. Replace three-way planning and the unused confirmation lifecycle with complete captured-file preflight and
   receiving-owner permissions; add ordinary KV deletion with persistence and
   replication evidence. Keep live submission unavailable before durability.
2. Establish durable unfinished state, canonical folder exclusion,
   manifest-owned paths, and preservation of concurrent file edits. Prove
   failure ordering and fresh-folder reconciliation.
3. Route Pull and Push to an existing running owner and prove a durable title
   edit plus no-op repeat, destination checks, and interruption refusal.

Each substantive checkpoint requires two fresh read-only reviewers and
resolution before dependent implementation.

## Continuation review

Files read by the coordinator and two reviewers, including relevant excerpts
and caller searches:

```text
/tmp/
`-- epicenter-config-execution-handoff.md
repository/
|-- package.json
|-- bunfig.toml
|-- .agents/skills/
|   |-- adversarial-review/
|   |   |-- SKILL.md
|   |   `-- references/deletion-prizes.md
|   |-- post-implementation-review/SKILL.md
|   |-- greenfield-clean-breaks/SKILL.md
|   |-- typescript/SKILL.md
|   |-- testing/
|   |   |-- SKILL.md
|   |   `-- references/honest-tests.md
|   |-- monorepo/SKILL.md
|   |-- documentation/SKILL.md
|   |-- google-devdocs-style/SKILL.md
|   `-- writing-voice/SKILL.md
|-- scripts/
|   |-- epicenter.ts
|   |-- epicenter.test.ts
|   `-- tsconfig.json
|-- docs/
|   |-- adr/
|   |   |-- 0125-record-definitions-are-release-local-lenses-and-never-migrate-user-data.md
|   |   |-- 0418-push-translates-file-differences-into-ordinary-edits.md
|   |   |-- 0419-stores-open-for-explicit-owners-and-compose-live-projections.md
|   |   |-- 0420-epicenter-working-copies-use-the-matter-file-contract.md
|   |   |-- 0421-apps-and-file-tools-compose-around-explicit-stores.md
|   |   `-- 0422-git-versions-working-copy-content-not-submission-state.md
|   `-- reports/
|       |-- 20260922-config-execution.md
|       |-- 20260922-working-copy-checkpoint.md
|       `-- 20260922-working-copy-vision-review.md
|-- apps/
|   |-- epicenter/
|   |   |-- README.md
|   |   `-- src/
|   |       |-- checkout.ts
|   |       `-- server.ts
|   |-- honeycrisp/src/lib/data.ts
|   `-- whispering/src/
|       |-- lib/whispering/
|       |   |-- app.ts
|       |   |-- recordings.ts
|       |   |-- recordings.test.ts
|       |   `-- recordings-markdown-export.test.ts
|       `-- routes/(app)/(config)/recordings/RecordingDetailModal.svelte
|-- packages/app/src/data/
|   |-- README.md
|   |-- __benchmarks__/checkout.bench.ts
|   |-- artifact/
|   |   |-- checkout.ts
|   |   |-- checkout.test.ts
|   |   |-- field-changes.ts
|   |   |-- field-changes.test.ts
|   |   |-- format.ts
|   |   |-- frontmatter.ts
|   |   `-- import.test.ts
|   |-- definition/
|   |   |-- compile.ts
|   |   |-- compile.test.ts
|   |   |-- declaration.ts
|   |   |-- declaration.test-d.ts
|   |   |-- index.ts
|   |   `-- json.ts
|   `-- store/
|       |-- document.ts
|       |-- handles.ts
|       |-- persistence.ts
|       `-- store.ts
`-- node_modules/.bun/@y+y@14.0.0-rc.24/node_modules/@y/y/src/
    `-- ytype.js
```

Two fresh read-only reviewers traced the cumulative changes and actual callers.
Both retain the single-process validator, existing compiler, shared file parser,
and separate row/KV omission semantics. No file moves are justified for config
validation. The local helpers name decoding, conformance, and diagnostic phases;
they do not create competing owners.

The current and proposed organization are the same for this repair:

```text
Current                         Proposed
scripts/                        scripts/
|-- epicenter.ts                 |-- epicenter.ts
`-- epicenter.test.ts            `-- epicenter.test.ts
```

The single-use `result()` closure in `validateFolder` can be inlined at its
return without changing the design. That cosmetic edit is deferred. The test
fixture's repeated `mkdir` serves callers that add nested fixture paths; it is
not evidence of redundant production writes.
The final reread also found and corrected the data README's stale claim that
updates validate supplied values. The ordinary store update path does not run
conformance checks; that interpretation belongs to reads and explicit validation.

The coordinator reproduced automatic package resolution against a local test
registry. The original command made a registry request for a missing dependency,
contradicting the no-install requirement. The root script and executable shebang
now pass `--no-install`; launcher tests exercise both entrypoints with an isolated
registry and cache. The executable also has its required executable permission.
The missing dependency uses a version-qualified import: without `--no-install`,
even the repository-root launcher attempts a registry request. A nonexistent
package that merely reports an error would not prove installation is disabled.

The console reproduction agrees with Bun's documented
[Node.js compatibility limits](https://bun.com/docs/runtime/nodejs-compat):
`syncBuiltinESMExports` is a no-op. The accepted exception avoids adding a
loader or isolated process solely to intercept trusted code. Tests cover named
and namespace builtin exports and an explicit config filesystem side effect.

The remaining workflow should replace the legacy `createWorkingCopy` lifecycle,
including `Confirm`, repeated previews, `sameReading`, `samePreview`, app-side
`inUse`, live-store conflict comparison, body rewriting, row admission/deletion,
and Push file writeback. Only tests and a benchmark call that lifecycle.

The host owns captured files, manifest paths, differences, and durable unfinished
state. The receiver owns destination checks, permissions, reserved-key checks,
raw row existence, ordinary mutations, and their durability acknowledgement.
Make field-diff helpers return raw differences when wiring this host caller;
remove their permission arguments and `FileContractError` then. Keep the JSON
comparison private because no external caller uses it. Replace the old host
whole-folder replacement route rather than preserving an alternate write path.

Before any live Push, prove these additional findings:

- Yjs rejects the attribute key `__proto__` after earlier mutations in the same
  transaction have landed. A transaction does not roll those writes back.
  Reject unsupported storage keys at the ordinary store boundary and throughout
  whole-submission row/KV admission, even if a permission list grants them.
  The coordinator independently reproduced a failed title-plus-`__proto__`
  update leaving the new title stored. The relevant store sources match the
  task-start baseline; this is an inherited behavior the new preflight must cover.
- Whispering's `updateRecording` updates and then reads a conforming typed row.
  It can mutate and then throw for a permitted nonconforming value. The receiver
  must use ordinary table updates after raw admission, not this product wrapper.
- Canonical-folder exclusion does not exclude editors. Retain the planned
  preservation proof for Pull; a check followed by rename does not establish it.

Fresh-folder-only Pull could delete replacement coordination, but would make
people repeatedly transfer edits and repository context. That changes the
accepted working-folder workflow and was not adopted. Preserve captured baseline
advancement after local durability, durable unfinished state, and explicit
fresh-folder reconciliation after uncertain operations.

## Continuation verification

- `bun test packages/app/src/data/artifact packages/app/src/data/definition packages/matter-core scripts/epicenter.test.ts`: 399 passed, 0 failed, 961 assertions across 24 files.
- `bun x tsc --noEmit -p packages/app/tsconfig.data.json`: passed before launcher repairs; no data-engine source changed during those repairs.
- `bun x tsc --noEmit -p scripts/tsconfig.json`: passed after repairs.
- Scoped Biome formatting and tracked-file whitespace checks passed.

The coordinator reread all six repaired files and repeated the inlining, smell,
invariant, and API checks. The repair adds no production helper or lifecycle.
The launcher test uses the real command and executable, and the local registry
returns only 404 responses, so a regression cannot install a package. No live
owner mutation, staging, commit, or deployment occurred. Verification used the
installed Bun 1.3.14; the repository's declared version is 1.4.2.
