# 0795. Git merges a note's body, and Epicenter merges its front matter by key

- **Status:** Accepted (2026-11-05)
- **Date:** 2026-11-05
- **Amends:** [ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md) at its merge table and `settle`: a body merges by Git's line merge, and front matter by key; [ADR-0774](0774-one-write-makes-it-so-and-settles-a-change-the-way-sync-does.md) at "A body or whole text the write replaces is settled with `settle`" and the formatter writing the whole note: a body begun from shown text merges by the standard three-way line merge, and a write rewrites only the keys it changes; [ADR-0789](0789-a-conflict-is-a-mark-on-its-note-resolved-in-the-repair-editor.md) at the markers `settle` writes: a conflict is Git's markers, with fixed labels; [ADR-0793](0793-programs-only-compose-typescript-holds-what-epicenter-means-and-rust-holds-the-os-git-and-secrets.md) at "`settle` has one implementation, in TypeScript": the merge is Git's for bodies and a key merge written once in each language under one fixture; [ADR-0794](0794-a-sync-round-asks-its-host-to-settle-checks-out-only-what-did-not-move-and-retries-rather-than-guess.md) at a round asking its host to settle and a round with no live page: a round merges by itself; [ADR-0733](0733-your-own-git-in-an-epicenter-folder-is-plain-git.md) at a person's own `git merge` running Epicenter's merge driver: without it, plain Git conflicts on neighbouring keys.
- **Relates:** [ADR-0762](0762-epicenter-is-made-of-standards-and-places.md) (speak the standard), [ADR-0771](0771-plain-files-let-epicenter-refuse-renames-attachment-conflict-copies-and-a-second-store.md) (a file other than a note takes the later write), [ADR-0775](0775-a-write-never-fails-the-folder-keeps-it-until-it-lands.md) (a note that does not read).
- **Unbuilt:** all of it: the key merge in the core (Rust) and in `@epicenter/definition` (TypeScript) with one shared fixture; the core merging bodies with libgit2's `merge_file` and fixed labels, with no host callback; the page's three-way line merge for a body or whole text begun from shown text; writes that rewrite only the keys they change; ADR-0789's detection reading Git's markers; deleting `settle`'s body merge and conflict continuation (`packages/definition/src/merge/merge.ts`, `conflict.ts`), the YAML formatting inside the merge, the core's host-settle protocol (`packages/epicenter-core/napi`), and the keys parity test.

## Context

Epicenter merged notes with its own algorithm, `settle`: by key in the front
matter, by lines in the body with its own conflict blocks, through its own
YAML formatter. Because Git could not run it, the merge needed a host:
the CLI passed it to the core through Node-API, an app's page would answer a
round's call, a round with no page had to stop, an embedded JavaScript
engine was weighed for phones, and a test held two callers' arguments
together. An adversarial review of three reviewers asked whether Git's own
merge could replace it.

Each reviewer ran `git merge-file` on a Todo's front matter. With `done` and
`title` on neighbouring lines, one side changing each, Git reports one
conflict covering both: its line merge treats changes on adjacent lines,
with no unchanged line between them, as one change. One key per line does not
help. A front matter merged by lines would break notes in ordinary use, such
as a todo checked on one computer and renamed on another. In the body, Git's
line merge keeps edits to different parts and marks the same part, as
`settle` does.

## Decision

**A note's body merges by Git's line merge.** A round merges it with
libgit2's `merge_file`; the page merges a body or whole text begun from shown
text, over a file that moved, with the same standard three-way line merge.
Both write Git's conflict markers with fixed labels, `current` and
`incoming`, never a device or a time, so two computers merging one clash
write the same text. A note holding markers shows ⚠ and is resolved in the
repair editor (ADR-0789).

**A note's front matter merges by key, by a small textual rule.** A key is a
`key:` line at the first column and the indented lines under it; nothing is
parsed as YAML.

| Change | Result |
| --- | --- |
| a key one side changed | that side |
| a key both sides changed | the later write: in a round, this computer's side, which reaches the server later |
| a key one side deleted and the other changed | the change |
| keys both sides added | both, in the order the fixture fixes |

A front matter that does not split into such keys on either side, with
lines at the first column that are not keys, comments, blank lines, or a key
written twice, merges by Git's line merge instead, and a conflict there
leaves the note to Repair. A front matter with no closing fence is all body.
Two notes created at one path merge as both sides changing every key, and
their bodies as a conflict against an empty base. The rule is written once
in Rust, for the core, and once in TypeScript, for the page, and both are
held to one fixture of cases, the bytes included.

**A file other than a note takes the later write, and an edit beats a delete,
for notes and files alike.**

**A write rewrites only the keys it changes.** A field set applies its keys
to the file as it is and leaves the other lines as they were typed, so a
note an agent or a person wrote is not reformatted by a save, and a
formatter that changes between versions touches only keys being edited.
Block style stays the house style.

**A round merges by itself.** It needs no host, no page, and no JavaScript.

## Consequences

- `settle`'s body merge, its conflict continuation, the YAML formatting
  inside the merge, the host protocol, the rule for a round with no page,
  the question of an embedded JavaScript engine, and the keys parity test
  go.
- A round can finish with no app window open, including where a phone runs
  native code in the background.
- Epicenter's own merge is the key rule, about forty lines in each language.
- A person's own `git pull` without Epicenter's merge driver conflicts on
  neighbouring keys that Epicenter would have merged.
- Two additions at one place in a body, which `settle` sometimes kept side by
  side, become a conflict.

## Considered alternatives

- **Git's line merge for the whole note, one key per line:** neighbouring keys
  conflict, so a todo checked on one computer and renamed on another stops
  reading.
- **`settle` with a host, as ADR-0794 decided:** a merge Git cannot run, and
  every program that runs a round must reach it.
- **A ⚠ when both sides changed a key:** shows the replacement, at the cost of
  marks to clear after ordinary edits on two devices.
