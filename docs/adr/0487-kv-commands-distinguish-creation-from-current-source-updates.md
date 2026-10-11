# 0487. One KV file exposes stored values; applications own defaults

- **Status:** Proposed
- **Date:** 2026-10-02

## Context

KV is a sparse map in one reserved root `kv.json`. Applications may interpret it
as preferences or other small shared values. Its public contract should not
assume that every caller is a settings application.

A missing file has no source or hash. Missing keys have no stored values.
Defaults supplied by an application are useful but are not observations about
the file. Mixing user keys with capture metadata would also reserve ordinary
keys such as `source`, `issues`, or `defaults`.

## Decision

`folder.kv` reads one fixed `kv.json`. Usable stored values live under `values`,
separate from snapshot metadata. It uses the same parse-error and field-issue
shapes as table interpretation did before ADR-0518.

```ts
type KvReading<TValues> = {
  readonly values: DeepReadonly<Partial<TValues>>;
  readonly parseError: ParseError | undefined;
  readonly issues: readonly FieldIssue[];
};

type KvSnapshot<TValues> = KvReading<TValues> & {
  readonly path: 'kv.json';
  readonly source: string;
  readonly sha256: string;
};

type FileKv<TValues> = {
  inspect(source: string): KvReading<TValues>;
  get(): Promise<Result<KvSnapshot<TValues> | undefined, KvReadError>>;
  create(values: DeepReadonly<Partial<TValues>>):
    Promise<Result<KvSnapshot<TValues>, KvWriteError>>;
  update(values: DeepReadonly<Partial<TValues>>):
    Promise<Result<KvSnapshot<TValues>, KvWriteError>>;
};
```

`get` returns `Ok(undefined)` only for file absence. A read or UTF-8 failure is
an operation error. Readable malformed or non-object JSON is a snapshot with
`parseError`, empty `values`, and empty `issues`. Parsing success yields
independently validated declared values and an issue array. Missing keys are
permitted and omitted; invalid stored values are omitted and reported. Unknown
keys remain in source. Values and diagnostics are detached and recursively
readonly and frozen. `inspect` performs the same work without storage or capture
metadata and returns a plain reading.

The format is a strict JSON object, with an optional initial BOM. Comments and
trailing commas fail parsing. Reading duplicate root keys follows `JSON.parse`'s
last value interpretation. Structured updates refuse repeated occurrences of a
key they are asked to change. Unknown duplicate keys remain untouched.

`create` validates the supplied partial map and publishes exclusively without
reading. `update` owns supplied values before awaiting, reads current source
once, patches only supplied root keys, and replaces against that read's hash.
Absence is `NotFound`; a publication race is `Conflict`. Neither command retries
or creates an absent file implicitly. Successful receipts describe submitted
source and its hash without rereading. Receipt interpretation finishes before
publication, so successful publication needs no subsequent validation.

Syntax-tree offsets preserve untouched source, including unknown nested numeric
tokens. Malformed or non-object current JSON refuses update with `Unparsed`,
carrying the shared `ParseError`. Successfully parsed JSON that cannot be
patched safely, including a repeated supplied key, refuses with
`UnsupportedSource`. A readable map can therefore have valid values while a
particular update is refused. Invalid supplied values remain an invalid-input
preparation error. Complete-text repair uses `folder.files.replace(snapshot,
source)`. That returns a raw `FileCapture`; inspect the UTF-8-decoded submitted
bytes for diagnostics, without attaching an older interpretation to the new
hash. Write inputs accept recursively readonly values. Folder copies and freezes
them before validation without freezing caller-owned data. Parsed stored values
are also frozen before schema callbacks run. A callback attempting mutation
produces a field issue on read or an invalid-input preparation error on write.

Applications apply defaults once where they derive usable application state:

```ts
const { data: snapshot, error } = await folder.kv.get();
if (error) return showReadFailure(error);
const kv = { ...KV_DEFAULTS, ...(snapshot?.values ?? {}) };
showDiagnostics(snapshot?.parseError, snapshot?.issues ?? []);
```

Missing files, missing keys, and omitted invalid values fall back to application
defaults. Broken JSON can display defaults alongside its parse diagnostic.
Acquisition errors must be handled before applying this policy. Valid `null`
overrides a default. Merging is shallow: each stored root value replaces that
root's default, without implicitly merging nested objects.

Neither `get`, schema compilation, nor folder opening inserts or persists
defaults. The application may expose `KV_DEFAULTS` itself; Folder has no
`defaults` member or resolution helper. A patch contains only deliberate edits,
not the entire default-resolved map. Initialization is an explicit `create`
policy, including handling a competing creation. Library code does not freeze or
modify application-owned default objects.

## Consequences

The `values` namespace permits arbitrary declared user keys without colliding
with capture metadata. Snapshots describe real files, and reads do not invent
captures for absence. Defaults can change independently of stored data.

Current-source commands need no preliminary caller read. They assign supplied
values deliberately; they do not protect an earlier displayed snapshot.
Full-text editing retains captured-baseline protection through `files.replace`.

## Considered alternatives

Flattening KV keys into the snapshot reserves metadata names. Returning defaults
from `get` hides absence and invalid source, and can persist values a person
never chose. Multiple root KV files add addressing before a concrete caller
needs it; ordinary files remain available. Per-key publications split one
command into several saves. An upserting update hides creation policy. Row
editors use interpreted save receipts; there is no current typed KV repair
caller that needs a separate replacement helper. Ordinary file repair remains
available without adding that facade. A captured structured update changes the
concurrency policy of existing current-source commands.

## Implementation

[KV interpretation and commands](../../packages/folder/src/kv.ts) implement
this sparse stored-value contract. [KV tests](../../packages/folder/src/kv.test.ts)
cover absence, parse diagnostics, independent validation, readonly ownership,
source preservation, and conditional publication. Whispering derives defaults
where it reads application settings.
