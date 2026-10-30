# Two worlds prototype v2: results

Throwaway prototype for ADR-0692 as revised, 2026-10-27: a permanent document
(no epochs), rows keyed by stable id with the path as an attribute, settings as
one map written to `kv.json`, LFS pointers, deterministic materialization, a
Git tree parsed with the id repair rule, and pushes merged structurally. An
in-process stand-in for the server object; agents edit Markdown text in a
clone. Reuses the line diff and line merge from `../two-worlds-prototype/`.

Run: `bun test packages/folder/evidence/two-worlds-prototype-v2` (16 tests, all pass).

| Claim | Result |
|---|---|
| The first checkpoint writes `id` as every row's first key | Holds. |
| A rename in an app keeps typing on another device | Holds; the file moves at the next checkpoint. Control: keyed by path, the same rename loses the typing. |
| `git mv` by an agent while someone types | Holds: the id is kept, and the typing survives. |
| Id repair | Holds: a copied file gets a new id, a deleted `id` line keeps its id by path, a new file gets an id; each is written back by the merge commit. |
| A push merges by field | Holds: an agent's `pinned` and a person's `title` merge cleanly; the same field changed both ways is rejected with `notes/ideas.md: field title`. |
| `kv.json` merges by key | Holds; unknown keys are kept, and the file is canonical. |
| Schema-blind pushes | Holds: a row breaking the app's schema is accepted and shows as an issue through the app's own check. |
| Invalid files | Holds: kept byte for byte, shown as source, and written as a row with an id once fixed in the app. |
| Paths outside the layout | Holds: kept across commits and never loaded. |
| A device back after a long time offline | Holds: it merges like a live peer, including another device's edits and an agent's push. |
| One merge rule for people | Holds: two rewrites of one paragraph give `Paragraph 1 is rewritten by arewritten by b.` whether or not a device was offline; which side comes first varies between runs, and every device converges on the same text. |
| Deterministic formatting | Holds: `id`, the declared order, then unknown keys sorted. |
| LFS pointers | Holds: an upload's entry becomes a standard pointer file, and a relative path resolves to it. |
| Idempotent migrations | Holds: two devices migrating `due` to `dueDate` at once converge; a non-idempotent migration applies twice. |

## What it found that the ADR does not yet say

- **The server cannot know which folders an app declares**, because it reads no
  schema. The prototype's server loads the whole canonical layout (every
  `<folder>/<name>.md`, `kv.json`, LFS pointers), and each app shows the tables
  it declares. Only paths outside the layout are kept and not loaded.
- **Key order needs the schema, and the server writes the files.** The
  prototype has the app write each table's declared key order into the
  document (`order:<table>`); the server uses it when present and sorts
  otherwise. The alternative is always sorting, which needs nothing.
- **An invalid file has no readable id**, so its identity is its path; renaming
  one in a clone makes it a new row.

## Limits

In-process and synchronous; frontmatter writing handles scalars and JSON-style
lists only; files outside the layout merge as whole files; no real LFS server.
