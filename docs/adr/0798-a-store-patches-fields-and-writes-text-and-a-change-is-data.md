# 0798. A store patches fields and writes text, and a change is data

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0779](0779-a-store-is-four-verbs-and-a-browser-recording-lands-whole.md) at "a store is four verbs": a fifth, `patch`, applies field changes where the file lives; [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "A write reads the file just before writing it" for named fields: the store applies them to the file as it is; [ADR-0797](0797-front-matter-is-a-strict-grammar-and-anything-else-is-body.md) at a field set normalizing a note outside the grammar first: the page normalizes, with a write, and no store normalizes.
- **Relates:** [ADR-0773](0773-a-folder-opens-at-a-place-every-place-is-a-store-and-the-server-never-merges.md) (the server never merges, which this keeps), [ADR-0795](0795-git-merges-a-notes-body-and-epicenter-merges-its-front-matter-by-key.md) and [ADR-0796](0796-a-field-is-a-line-its-value-is-json-and-a-write-patches-only-the-fields-it-changes.md) (fields are lines; bodies merge by lines), [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (queued writes), [ADR-0750](0750-sync-is-like-save-any-program-can-sync-a-folder-and-none-owns-it.md) and [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (no background service; programs never call each other).
- **Amended by:** [ADR-0800](0800-a-stores-wire-speaks-http-conditional-requests-and-apps-connect-agents-to-the-cli.md) at each place keeping its own transport: a store reached over HTTP reads and writes one file as HTTP's conditional requests do.
- **Unbuilt:** all of it: `patch` in every store (the shell in Rust; the server, Node, memory, and served stores in TypeScript) with its answers; the folder sending field changes as patches; the page coalescing an editor's queued writes for one path; the change vocabulary on every transport and in the page's queue; the conformance cases for `patch` over every store and the Rust `patch` against the shared fixture; `epicenter set` as a patch.

## Context

An adversarial review tested sending every write as an intent the store
applies where the file lives. Field changes passed: applied to the file as it
is, they are idempotent and never stale. Text did not: a body merge the store
applied, whose reply was lost, is sent again (Tauri resends a failed call, and
the web's queue resends a write as it is), and merging it a second time over
the conflict markers the first left nests them. A delete that carries nothing
the person saw cannot keep an edit over a delete. The review agreed on the
line it had drawn earlier: fields are intents; text is a copy.

## Decision

**A store has five verbs:** `list`, `read`, `watch`, `write(path, bytes |
null, over)`, and `patch(path, { set, delete })`.

**`patch` applies field changes to the file as it is.** It replaces, adds, or
removes field lines with the primitive of ADR-0796, held to one fixture in
Rust and TypeScript, and answers the bytes and version it wrote. Sent twice,
it writes the same file, so it is never stale. It never creates a file: over
an absent path it answers `gone`. It never normalizes: over a file outside the
grammar it answers `outside` and changes nothing. In both cases the page, which
holds the whole note, decides: it recreates the note with a write over
`'absent'`, or normalizes it (TypeScript reads YAML) or keeps its text and adds
the change beside it, with a write over the version it read.

**Text, deletes, and attachments are writes over the version read.** An
editor's save, a whole-text repair, Normalize, a delete (`null`), and a
recording are `write(bytes, over)`. The page merges an editor's text against
what it showed (ADR-0795) before writing it. A lost reply's resend answers
`'stale'`, and the page finds its own text already there. A delete over a note
that moved answers `'stale'`, and the page keeps the note. An editor's queued
saves for one path coalesce into one write of the latest text.

**The server patches field lines and merges no prose.** Teammates changing
fields on the web never see `'stale'`.

**A change is data.** Every transport and every queue carries one vocabulary,
discriminated by `op`; code calls typed methods that map to it one to one.

```ts
type Change =
  | { op: 'patch'; path: string; set?: Record<string, Json>; delete?: string[] }
  | { op: 'write'; path: string; text: string | null; over: Version | 'absent' }
  | { op: 'write'; path: string; bytes: Base64; over: Version | 'absent' };
```

Each place keeps its own transport: the shell's commands, the server's routes,
a served store's requests, the CLI. The page's unsent writes are this JSON, and
the conformance suite replays sequences of it against every store.

**The file system coordinates writers.** Inside a program, one queue per path
writes in order. Across programs, a patch needs no coordination, a write is
guarded by its version, and a file is replaced by an atomic rename; no program
routes another's writes. An agent changes fields with `epicenter set`, a patch
like any other.

## Consequences

- A field change never retries and never conflicts with a field change to
  another key, on any store.
- A desktop field write and a round use the same Rust primitive.
- Retry after `'stale'` stays for text, deletes, and attachments, in the page.
- One change vocabulary is what the shell, the server, the CLI, a queue, and a
  test exchange.

## Considered alternatives

- **Every write an intent, text included:** a resent body merge nests conflict
  markers, and a delete without a base loses an edit.
- **A per-folder writer process every program routes through:** a background
  service (ADR-0750) that programs call (ADR-0762), down exactly when it is
  needed, and bypassed by any agent that writes the file.
- **One `apply` method taking the union:** the same payload, with call sites
  that lose their types.
