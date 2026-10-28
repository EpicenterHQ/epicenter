# 0692. People and agents write one Git repository through ordered mutations

- **Status:** Proposed
- **Date:** 2026-10-27
- **Would supersede:** [ADR-0690](0690-merges-happen-only-where-history-records-the-common-ancestor.md); [ADR-0684](0684-browser-folders-submit-frozen-file-changes-instead-of-running-git.md), [ADR-0685](0685-hosted-git-records-browser-publication-receipts-in-a-protected-ref.md) and [ADR-0650](0650-a-browsers-current-folder-is-one-immutable-tree.md), since a browser no longer runs Git.
- **Would amend:** [ADR-0534](0534-data-folders-are-the-only-data-model.md), [ADR-0686](0686-one-https-site-is-one-portable-release-and-one-data-area.md), [ADR-0687](0687-opening-a-site-url-opens-its-derived-folder.md), [ADR-0689](0689-an-edit-shows-what-you-typed-the-queue-carries-it-the-folder-shows-what-landed.md) (the live desktop folder is retired); [ADR-0622](0622-a-losing-edit-stays-a-parent-of-the-merge-commit.md) (a conflicting push is refused; people's overlapping text becomes conflict markers); [ADR-0529](0529-commits-happen-only-on-sync-or-when-a-person-saves-a-version.md), [ADR-0530](0530-applications-record-a-version-at-natural-moments.md) (the server makes people's commits); [ADR-0585](0585-a-folders-epicenter-json-is-a-description-for-readers-without-code.md), [ADR-0648](0648-a-folders-saved-views-live-in-its-optional-epicenter-json.md) (apps publish schemas with their releases; saved views are settings); [ADR-0621](0621-epicenters-library-writes-only-text-to-a-repository-in-v1.md) (binary files as Git LFS pointers, later).
- **Relates:** [ADR-0457](0457-a-row-filename-is-its-exact-id-and-a-title-is-a-field.md), whose path addressing this keeps; [ADR-0632](0632-a-lens-belongs-to-its-reader.md): the app brings its own schema; [ADR-0295](0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md); [ADR-0620](0620-history-in-a-repository-only-grows.md).
- **Evidence:** [storage shape benchmark](../../packages/folder/evidence/storage-shape-benchmark/RESULTS.md); [prototype v1](../../packages/folder/evidence/two-worlds-prototype/RESULTS.md) and [prototype v2](../../packages/folder/evidence/two-worlds-prototype-v2/RESULTS.md), which tested an earlier per-note Yjs variant.
- **Unbuilt:** all of it; see Verification.

## Context

ADR-0690 kept files as the authority on every device: a desktop folder written
through a checked queue, a browser Git working tree, and a merge at sync. It
could not show edits on other devices promptly, it needed conflict UI for
people who never asked for it, and its browser engine opened 50,000 rows in
1.93 s. The benchmarks showed that speed comes from storing parsed data in one
record (0.065 s at 50,000 rows), not from a CRDT. The owner set the product
rules: the remote is a real Git repository agents can clone; teams of people
and agents collaborate on it; edits appear on other devices within a second or
two; people resolve nothing; agents repair what merges badly; apps work offline;
schemas are an app's lens, never enforced by the server.

## Decision

**Git is the record, and one server object per repository orders every
write.** People, apps and agents send batches of writes against a known base:
this file, from this version, now reads like this. The server merges each one into the
current text, broadcasts the result, and commits changed files to `main` once
they are a minute old or when asked. Devices keep the files' text and their
own unsent edits, so apps work offline. Clones read Git directly and may lag
the server by that minute.

- **Files.** The repository's data is its Markdown files and Git LFS pointers.
  An app selects files with named path templates such as
  `projects/{project}/tasks/{stem}.md` or `settings.md`: each segment is a
  literal or one parameter with an optional suffix, a parameter never spans a
  `/`, a template without parameters names one file, and an app whose
  templates could claim the same file is refused when it is defined. Parameters
  become typed columns, and apps never write a path string; every call passes
  every segment, including the stem, which a template never generates (apps may
  use plain helpers such as `slug` or `timestamp`). A Markdown file no
  template names (a README, say) is synced and never validated. Binary files
  are always LFS objects (see Blobs). Other text files stay in Git and are not
  downloaded to app devices.
  Identity is the path, and Git is its history: every commit records the
  server sequence it includes, and every path event since the previous commit
  is recorded in a trailer with its sequence (`Epicenter-Create`,
  `Epicenter-Move`, `Epicenter-Delete`, `Epicenter-Restore`,
  `Epicenter-Relocate`); only the server writes `main`, so tracing reads
  trailers rather than guessing from tree differences. An edit whose base is older than the
  last commit is routed through that history, so it follows a move and never
  lands on a different note recreated at the same path; the server object keeps
  no history table and no window, so a device may return after any time
  offline. An edit whose note can no longer be found (its path was deleted and
  reused by a different note) is saved by the server, in the same transaction,
  as a sibling note `<stem> (<user>, <YYYY-MM-DD>).md`, and later edits aimed at
  the old path follow it there.
- **Operations.** Every request is one batch, `{ device, n, changes }`, applied
  all or nothing, with one outcome per change; a `git push` is the same batch.
  A change is `write(path, base, text)` (create, edit, or, with no text,
  delete), `move(from, to)`, which treats a note's path as one of its fields
  (the current path wins: a second move of the same note, or a move onto a path
  another note holds, is not applied and becomes a notice), or
  `append(path, text)`, which needs no base and adds text exactly at the end of
  whatever the server holds. Later changes in a batch follow a move made earlier
  in it, so a callback is always one batch. A batch carries the device's
  repository position, and each write's base is the hash of the text it started
  from; the base text travels with it when the server lacks it (`need-base`),
  and the server refuses a base text that does not hash to its hash. Setting a
  value is a write that changes one frontmatter field. A batch carries its
  policy, chosen by the verb that built it: `mark` for people, `refuse` for
  callers that wait. A batch's outcome is `applied`, `need-base` or, for
  `refuse` batches on overlap, `refused`; a `mark` batch is never refused
  except on a protocol fault such as a batch out of order; within `applied`,
  each file reports its overlaps and how each was settled, an edit kept over a
  delete, and its text when that differs from what was sent. The per-device
  number makes a retry return its recorded outcome, and a number at or below
  the last one applied is never applied twice; the server stamps each batch
  with the signed-in user, for permissions, history and `Co-authored-by` lines.
  A reply streamed by an assistant is relayed live without being stored, then
  written as one append.
- **Two verbs.** `repo.write(b => ...)` and the direct handle calls are a
  person's change: it resolves when saved in the device's database, works
  offline, and is never refused because of a change made elsewhere; it can be
  refused at once only for its own invalid input (a path, size or storage
  failure). What happened shows in the data, and what needs a person's
  attention (a rename or field value not applied, an edit saved as a sibling, a
  protocol fault, which keeps the text the device showed) goes to
  `repo.notices`, kept until dismissed. `repo.send(b => ...)` is for a caller
  that waits: online only, it names the read each change guards (`{ from:
  note }`, or `'latest'` said explicitly), does not change the device's copy
  until the server answers, and is refused on overlap. A send whose answer was
  lost ends `Unanswered` with an id, and `repo.verdict(id)` returns the stored
  outcome later. Both verbs build with one set of handles. The CLI's commands
  use `send` and fall back to a Git commit only when certainly offline. Unsent
  writes to one path merge into one before sending.
- **Repairing files.** A file either does not parse (its frontmatter is broken)
  or parses but does not match an app's schema. `<SourceEditor>`, a built-in
  CodeMirror 6 component, edits any note's whole text and shows the parse and
  schema status as you type, saving every keystroke through
  `repo.files.writeText(path, text)` or an open file. The rule is enforced
  where it protects someone: no synced file (on the server, in Git, on other
  devices) ever goes from parsing to not parsing. A device saves text that does
  not parse and holds it, unsent, until it parses again (see Devices); the
  server keeps the current text and leaves a notice if a merge would break one,
  and refuses it for a caller that waits. A new file breaks nothing, so it may
  arrive broken and be repaired here.
- **The app API.** `defineApp` maps identifier names to templates, each with a
  schema or a blob declaration; the repository's own members (`files`,
  `notices`, `sql`, `pending`, `verdict`, `write`, `send`, `close`) are reserved
  names, so adding one later is a deliberate breaking change. Every handle
  takes a parameter object whose keys TypeScript reads from the template:
  `repo.tasks.get({ project: 'acme', stem: 'fix-login' })`; `list` takes some
  segments as a filter and `watch` follows it; a template without segments
  takes none. Note handles offer `get`, `list`, `watch`, `open`, `create`,
  `patch` (which requires the note to exist; `create` is the only creation),
  `setField`, `append`, `rename` and `delete`; an open note's writes merge from
  the text it showed. Blob handles offer `put`, `open`, `list` and `delete`.
  `repo.files` reads and writes any synced Markdown file's whole text
  (`readText` returns `{ path, text, version }`, a usable `from`), lists files
  and opens one live; `app.check(text, { as })` reports parsing and schema
  status. `repo.sql.read` and `repo.sql.watch` query the app's views and cannot
  change anything. Everything that can be followed shares one contract: `read()`
  and `subscribe(onChange)`. A shorthand that fills in some segments (`in`) is
  deferred until call sites show it is needed.
- **The Epicenter merge.** One pure function, used by the server, by devices
  replaying unsent edits, and by the CLI, merges a write against its base:
  frontmatter by key, where on a clash the current value wins and the other is
  recorded in the outcome; the body by line, where changes on neighboring lines
  do not conflict, then by word within overlapping lines, so letters never
  blend; two insertions at the same point are both kept, in server order; two
  creates at one path become one file, frontmatter merged by key and both
  bodies kept. For people, a delete loses to an edit it had not seen. A
  prototype passes 15,000 random cases for these rules and merges cleanly five
  of six cases where `git merge-file` conflicts.
- **Overlaps.** The merge reports every clash as one kind of overlap: a field,
  a body span, a span touching an existing conflict block, a delete against an
  edit, two creates, or a path that is reused, taken or gone. One policy
  settles them by whether the caller waits for the answer. A request that waits
  (a `git push`, an online `epicenter` command) is refused, naming each overlap.
  A device's edit, already shown as done, is marked: a body overlap becomes Git
  conflict markers with a base section, in server order, labeled with who, when
  and the sequence, never nested, so editors such as VS Code show accept and
  compare actions and the app renders each block as a card; a field overlap
  keeps the current value; an unseen delete loses to an edit. Every overlap is
  stored with its batch and named in the commit's `Epicenter-Overlap` trailer.
- **Blobs.** A blob is immutable bytes named by their SHA-256, scoped to the
  repository, referenced by a canonical LFS pointer at a path whose template
  declares its extensions (the media type comes from the extension). A pointer
  is replaced as a whole, never merged: equal pointers are the same change; for
  people the current one stays and the other is saved at a sibling path with a
  notice; a waiting caller is refused. At every level a pointer names only
  bytes that level can reach: a device seals the bytes, hashing them as it
  writes, before saving the pointer; the pointer is held until its bytes are
  uploaded and verified, while uploads run on their own track, in parallel and
  in any order, so nothing behind them waits; the server admits a pointer only
  for verified bytes, uploaded to a staging key and promoted to an immutable
  one no client can write, and Git inherits that guarantee. Devices fetch bytes
  on demand and cache them by hash, so a cache is never stale; bytes the server
  lacks are pinned by whatever names them, and every other copy can be evicted.
  Every host speaks the Git LFS batch protocol with one upload per object.
  Published bytes are deleted only when an admin purges them from a Storage
  view, which warns that old checkouts lose them and leaves a lasting marker;
  a reference index of which commits name which bytes keeps that view exact,
  and uploads that were never published expire on their own. The repository's
  `.gitattributes` is the union of its apps' blob templates, committed before
  any matching file is added. Limits start at 2 GB per blob and 10 GB per
  repository, a server limit rather than space promised on a device.
- **Agents.** Online, `epicenter` commands send the same batches and wait for
  the answer; offline, the same commands edit the local clone and commit, and
  the commit goes through `git push` when the server is reachable. A `git push` is not
  replayed: its net change since its merge base becomes one batch, with the
  pushed commit as a parent of the result. It is refused, with the file and
  reason, if it overlaps changes since that base, if it breaks a note's
  frontmatter that parsed at that base, if a note exceeds 1 MB stored, or if a binary bypasses LFS; a refusal
  commits the overlay first, so the agent's next pull is current. `epicenter
  pull` asks the server to commit first.
- **Schemas.** The app brings its own schema, published with its release;
  `epicenter check --schema <url>` validates a clone. The server reads none.
- **The server object.** It holds only an overlay: files changed since the last
  commit, the batches since then, the last number applied per device, recent
  outcomes, and the sibling paths it created since the last commit. Each commit records the server
  sequence it includes; `main` moves only by compare-and-swap, and the overlay
  is cleared only up to what Git holds. At rest it holds almost nothing.
- **Reading.** Devices read committed files without the server object: the head
  commit and its sequence, the whole commit as one Git pack on first open, then
  a diff between two commits and changed files by content hash. They ask the object only for changes after that sequence, or
  are told to resync from the head.
- **Devices.** A device keeps replicas: one copy of one repository, written by
  one account or a guest, bound to one server, in one storage area (a browser
  origin's OPFS, a desktop data store, or a CLI clone's Git directory). A
  replica is named by a random id and holds one SQLite database, its blob
  objects and a small descriptor; a repository is named once by whoever creates
  it, the server adopts that id when it is published, and a rename moves
  nothing. The database records its repository and server, and the server
  refuses a replica that greets it for a different one. Replicas meet only at
  the server. Each file's text sits at levels, with one gate between each: what
  the person sees, what this device has queued (its text passes once it parses),
  and what the server has (a change passes once the server applies it). A change
  moves down when its gate opens; when a level below changes, the levels above
  merge onto it, so nothing waiting is lost. A file is therefore synced, sending
  or held, and the reason for holding is named. A callback's changes that can
  move now go together as one batch; a change whose gate is closed waits on its
  own. Strict engine tables, named with a `/` so no app view can collide with
  them, hold the files (this device's text, the text the server acknowledged,
  the hash and sequence), the outbox in order, the device's metadata and the
  notices; each app's templates become temporary read-only views on the owner's
  connection, and any change re-runs live queries, whose results are compared
  before re-rendering. One tab or process owns a replica at a time; another tab
  offers "Use here", which waits for the first to release it. The owning tab
  saves pending writes and closes its database when hidden or frozen, and never
  takes it back on its own. A device asks the browser to keep its storage at
  the first change that exists nowhere else, and says when it may not; a
  repository that exists only in a browser is labelled at risk, with Export.
  Signing out stops sync and hides that account's replicas; removing one is a
  separate step that warns about unsent work. Without a server, an app works
  fully, with no history.

## Consequences

Devices lose Git, the browser working tree, the write queue, checked writes
and the close guard, and the design uses no CRDT. Files keep the formatting
their writers gave them; only the edited span changes. People never resolve a
conflict in the app; overlapping text waits in a visible card, and agents can
find and repair it with ordinary tools. The cost is concentrated in the server
object and in a small protocol of our own, shaped like the push and pull of
sync engines such as Replicache. Two people typing in the same words at the same
moment produce a conflict block; a live co-editing session can be
added later if teams need it, replacing only body merging for that note.

Accounts in one browser origin are not isolated from each other, and the
browser can still evict an origin's unsent work; separate browser profiles,
publishing and Export are the protections.

## Verification

Prototypes v1 and v2 tested an earlier per-note Yjs variant; they establish
open times and push-merge behavior, not this design. Independent reviews by
Codex and Claude reviewers agreed on its class. A local spike of the read path
and the overlay found first open from content-addressed notes under 2 s for
5,000 notes at 150 ms latency, reconnect by tree comparison moving a few MB
rather than the whole repository, and the overlay surviving retries, the
resync race and crashes at three points; it also found that writing 50,000
records to IndexedDB took 17 s in Chromium, one reason the device store is
SQLite. Before acceptance: SQLite in OPFS at 5,000 and 50,000 notes in Chromium
and WebKit, with the tab-leader pattern; tests for the character merge and the
conflict-marker lifecycle; a deployed,
fault-injected spike against a non-production namespace that kills the server
object around each SQLite commit, Git update and reply, and retries the same
mutation and push; and device memory measured on a phone.

A deployed run against a separate Artifacts namespace measured the overlay
choice. Committing each edit before acknowledging it took 84 ms at 50 files
but about 15 s at 5,000 files in one folder, and twenty edits in one commit
cost the same as one, so the overlay stays: an edit is acknowledged after its
overlay write (38 ms at the client) and committed in the background. Reading
5,000 files one request each through Artifacts took 28 s even 32 at a time, so
a first open needs a packed snapshot rather than per-file reads. A first
implementation of the engine and server core in `packages/repository`
(branch `claude/repository-engine`) passes 111 tests, including fourteen
end-to-end scenarios over a real Git repository.

A second deployed run settled the read path and showed what commits cost. The
whole 5,000-file commit arrives as one 478 KB Git pack: a `git clone` from the
owner's machine took 1.5 s, and the same pack fetched and unpacked through a
Worker took 3.3 s, against 28 s for per-file reads, so no R2 copies are needed
for first open. Commit time follows the trees a commit rewrites, not the
repository's size: one edit took 156 ms with 5,000 files in 100 folders and
9.9 s with the same files in one folder. Commits run in the background, so a slow
commit delays only how soon Git and clones catch up, never an edit; spreading
a large table across folders (for example `recordings/{year}/{stem}.md`) is
recommended, not required. Cloudflare describes Artifacts as a Git server in
WebAssembly with one Durable Object per repository, which fits a cost per
entry of each rewritten folder. Two writers racing on `main` always produced
exactly one winner.

Three adversarial reviews, each with two Codex reviewers and one Claude
reviewer working independently and then converging, settled the app API, the
blob design and the device layout. They found, among other things, that writes
chose their starting point by method (which lost text in one app), that a batch
with a move was silently split, that pointers were merged as text and broke,
and that a device database was not bound to its repository. A browser probe
showed that a `File` handed from the worker to the page keeps reading after the
worker ends, in Chromium, WebKit and Firefox. The engine on
`claude/repository-engine` carries the first fixes (read-only SQL, notices kept
until dismissed, writes starting from what the server will have, `send`
naming its read, moves inside one batch); held text, the renamed API, the
replica layout and blobs are still being built.
