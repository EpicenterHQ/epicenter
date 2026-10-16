# 0522. Settings are independent keys set one at a time

- **Status:** Proposed
- **Replaced by:** [ADR-0576](0576-a-folder-has-one-write-a-merge-by-unit-where-the-writer-acting-wins.md), which makes settings a declared `settings` table (Proposed); this record is deleted when that is built.
- **Date:** 2026-10-11
- **Relates:** [ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md) (rows are documents; this is the other shape), [ADR-0464](0464-file-table-updates-conditionally-replace-the-captured-whole-file.md) (refusal without retry, with one scoped exception here)
- **Unbuilt:** application adoption (Whispering reads two legacy keys).

## Context

`kv.json` held a sparse map of declared values. `get` returned a snapshot
with a partial projection, a `parseError`, and per-field issues in a second
diagnostic vocabulary. `create` wrote a new file, and `update` patched the
assigned keys inside the exact source, conditional on its own read, without
retry. The Git merge of `kv.json` meanwhile regenerated the whole file, and
read duplicate keys differently from `get`. No application wrote `kv.json`.

Rows were just redesigned as documents
([ADR-0518](0518-a-row-is-read-through-one-pipeline-and-repaired-as-text.md)):
a draft is the whole row, so a write is guarded by the bytes it replaces and a
change made elsewhere is a conflict the person resolves. Settings are not
like that. A theme toggle says "the theme is dark", whatever the file held a
moment ago; asking the person to resolve a conflict over it would be wrong.

## Decision

**A setting is an intent: `kv.get()` reads every setting, and
`kv.set(key, value)` changes one.**

```ts
folder.kv.get(): Result<KvReading<T> | undefined, KvReadError>
// KvReading = { path, sha256, values: Partial<T>, issues }
folder.kv.set(key, value): Result<KvReading<T>, KvWriteError> // undefined removes the key
```

- Reading is per key. `values` holds every declared key whose stored value
  validated; a stored value that does not conform is left out and reported
  at its line, so one broken setting falls back to the application's
  default without hiding the others. Issues use the row vocabulary,
  `{ message, line?, field? }`.
- Only text a folder cannot hold is `InvalidKv`: not one strict JSON object,
  a key twice at any depth, an unpaired surrogate, or nesting beyond 64
  containers. A value over the nesting or width budget is an issue on read,
  as a set of it is refused, so a value read can always be set back. It
  carries the exact text and hash and is repaired as text.
- `set` refuses a value that is undeclared, does not conform, or cannot be
  stored before anything is read. It reads the current file, merges the key
  into the raw members, and publishes guarded by that read. Untouched keys
  keep their raw text.
- Sets from one handle apply in call order; a later set of a key waiting
  behind a running one replaces it.
- When another writer published first, or a reply was lost as `Unconfirmed`,
  a set re-reads and re-applies itself, up to three attempts, then reports
  the last refusal. This is the one place the
  folder retries ([ADR-0464](0464-file-table-updates-conditionally-replace-the-captured-whole-file.md)
  forbids retrying elsewhere), and it is sound only because a set's intent
  does not depend on the file's previous contents.
- `undefined` removes a key, so the application's default applies again,
  including a default changed later. A missing file is created.
- One top-level key is one fact. Settings that must change together belong
  in one key with an object value.
- One module owns `kv.json` text: the Git merge's strict member reader
  decides validity, and its formatter writes every file, for a merge and for
  `set` alike.
- The folder applies no defaults; schema `default` annotations stay inert.

## Consequences

Removed: `create`, `update`, and `inspect`; the in-place source patcher; the
snapshot's `text` and `parseError`; `TableError.Unparsed` and
`UnsupportedSource`; and `reading.ts` (`ParseError`, `FieldIssue`,
`DeepReadonly`, and its freezing helpers). Reader and merger now agree on
duplicate keys.

Two windows setting different keys both keep their changes, and a Git pull
that changed other keys merges silently. On the same key, the latest local
set wins; two clones that changed the same key differently still reach the
merge's per-key conflict. The first
set normalizes hand formatting of the file, as a merge already did.

## Considered alternatives

- **Settings as a row** edited with autosave. Puts a document guard on
  independent facts, so a toggle could raise "Reload theirs / Keep mine",
  and loses per-key Git merge.
- **Whole-file validity with a guarded `replace`.** One broken key would hide
  every setting, as when an older build reads a newer enum value.
- **Keep the in-place patcher, guarded, without retry.** Surfaces conflicts a
  retry resolves, and keeps a second writer whose formatting the merge
  discards.
- **`update(patch)` with several keys.** Invites saving a stale object read
  earlier; a fact that changes with another is one key.
- **Per-key accessors, `kv.theme.set('dark')`.** Reads well, but needs
  generated objects and collides with keys named `get`, `set`, or `then`.
- **A separate `remove(key)`.** Says what `set(key, undefined)` already says.
- **Delete folder KV.** Possible while nothing writes it, but intent-shaped,
  synced settings have no good home in rows.

## Verification

`packages/folder/src/kv.test.ts` covers per-key reading with located issues,
`InvalidKv` at its line, creation in the merge format, raw text kept for
untouched keys, agreement with `mergeKv`, removal, refusal before any read,
ownership at the call, call-order application, a lost race re-applied, a race
lost on every attempt, concurrent creation, and refinement isolation.
