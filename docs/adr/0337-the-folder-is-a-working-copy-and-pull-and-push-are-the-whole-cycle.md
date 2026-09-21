# 0337. The folder is a working copy, and pull and push are the whole cycle

- **Status:** Accepted
- **Date:** 2026-09-02
- **Amended by:** [ADR-0418](0418-push-translates-file-differences-into-ordinary-edits.md) replaces current-store conflict comparison with file-versus-baseline edits and ordinary CRDT resolution; no remote-conflict preview or eventual folder-wins guarantee remains.
- **Amended by:** [ADR-0417](0417-a-data-address-holds-one-document.md) removes generation from working-copy identity and requires a fresh comparison baseline after coordinated document replacement.
- **Amends:** [ADR-0271](0271-a-workspace-mirrors-continuously-to-the-epicenter-folder-one-way.md) by withdrawing the continuous render and the one-way rule; [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md) by making the folder a working copy rather than only a mint source; [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) at the return path's mechanism, keeping its rule that values round-trip and a body does not
- **Relates:** [ADR-0234](0234-the-ark-owns-living-pages-and-markdown-is-an-explicit-checkout.md) (which invented this shape for one table and never generalized it), [ADR-0281](0281-a-generation-is-a-whole-database-and-a-device-chooses-which-one-it-holds.md) (the backup), [ADR-0330](0330-an-agent-uses-the-surfaces-a-person-uses.md) (who edits and who pushes)
- **Amended by:** [ADR-0338](0338-the-folder-wins-and-a-push-is-one-approval.md) allows body edits through the existing content node; its earlier folder-wins and mandatory-approval proposal is withdrawn.
- **Amended by:** [ADR-0343](0343-a-preview-is-an-output-and-the-side-that-showed-it-applies-it.md) separates file-change inspection from application; the earlier mandatory confirmation-loop proposal is withdrawn.
- **Amended by:** [ADR-0394](0394-a-backup-is-the-library-s-folder-kept-by-the-authority.md) at recovery: a saved folder is readable source material, not a historical generation or exact backup; document-only materialization retains the Pull/Push comparison baseline.
- **Built**, in `packages/app/src/data/artifact/checkout.ts` and `apps/epicenter/src/checkout.ts`: all three verbs, the manifest, and the `AGENTS.md` a pull generates. What is not is named at "What a push refuses" below, and each line there waits on its own record.

## Context

`~/Epicenter` was asked to be four things at once: a durable copy, a place to
grep and run an agent, a git artifact, and a surface external tools could edit.
Three of those are reads and get along. The fourth is a write, and it is where
every hard question came from.

Two prior records had already taken the frame apart without finishing it.
ADR-0289 withdrew the premise that an always-current folder is the product,
said "Epicenter has no always-current agent-facing surface," and left deleting
the mirror module as an available decision it did not take.
ADR-0234 replaced continuous rendering with "an explicit checkout of a page row
and its prose document," with one local base record per materialized page, for
the Ark alone.

The continuous render's last justification went with ADR-0336. ADR-0271 promoted
the folder because `navigator.storage.persist()` is refused in the Tauri WebView
(ADR-0275), so the folder was the copy that outlived a reclamation. An account is
required now, so the authority holds the rows and an eviction is a cache miss
(ADR-0292), not a loss.

What was left was the write direction, and a filesystem cannot carry the fact it
needed. A changed file proves someone typed those bytes. A new file proves the
same. A missing file proves nothing: a person deleting a note, `git checkout`, a
half-finished Dropbox sync, and a Time Machine restore all produce one signal.

## Decision

**`~/Epicenter` is a working copy. `pull` fills it, `push` sends it back, and
nothing happens in between.**

```txt
~/Epicenter/<data-id>/
  .epicenter/manifest.json     what pull handed over, and from where
  AGENTS.md                    what this folder is, generated from the definition
  kv.json                      the kv root's stored values
  <table>/<row-id>.md          one row, frontmatter and body
```

```txt
pull    render rows into the folder and write the manifest
diff    print the push plan and change nothing
push    show the plan, apply on confirm, then re-render
```

The three verbs are actions in the application's window. The application
renders, diffs, and decides; the host does one thing per verb through one route
(`CHECKOUT_ROUTE` in `apps/epicenter/src/routes.ts`, at the `CHECKOUT_PATH` both
ends read from `packages/app/src/data/artifact/checkout.ts`): `PUT` replaces the
folder with the checkout `pull` hands it, and `GET` returns the folder's files
for `push` and for the dirty check `pull` makes first. There is no CLI.

**A checkout is complete, so the set of paths sent IS the manifest on the
wire.** The mirror's pass was incremental, so it needed a line saying "that was
all of it" and a rule that nothing is removed until it arrives; neither
survives, and the incomplete case they guarded cannot be expressed.

**The manifest is the base.** There is no per-file base store and no watcher,
because `pull` already wrote down what it handed over.

```txt
{ baseURL, principalId, dataId, generation, pulledAt,
  rows: { "<table>/<row-id>": { values: { ... }, bodyHash } },
  kvHash }
```

A row's `id` is not among its `values`: it is the path, and a second copy of an
identifier on disk is a second thing that can be wrong. `kvHash` is a hash and
not values, because the kv root is one object with no per-field base a push
could resolve against and no address a plan could name; it is pulled so the
folder is complete to read, and an edit to it is reported rather than applied.

**Absence is unambiguous at push, because the manifest says what was pulled and
a person chose the moment.** A missing file is a deletion, and no table can say
where a deletion goes yet, so every one of them is refused in the plan rather
than guessed at. Where a table names a trash field it will land there as a
value; Honeycrisp's would be `deletedAt`
(`apps/honeycrisp/src/lib/data/index.ts`), so a deleted file trashes a note and
never removes a row. Removing a row stays the dialog in
`apps/honeycrisp/src/routes/components/NoteCard.svelte` that reads "This action
cannot be undone."

**A person whose manifest is stale resolves it inside the push they asked for,
and nothing on disk is rewritten to hide that.** Each field has three values:
`base` from the manifest, `file` from disk, and `store` now.

| base, file, store | what happens |
| --- | --- |
| `file == base` | the person did not touch it; the store's value stands and the plan says nothing |
| `store == base` | apply the file's value |
| `store == file` | already converged; nothing to do |
| all three differ | a conflict on that field, resolved in the plan |

```txt
push 412 files: 41 values, 1 deletion, 2 conflicts

  notes/9f2c.md   status   draft -> shipped
  notes/4d70.md   title    file "Q3 plan" / store "Q3 planning"   [file|store]
  notes/8a11.md   refused  the file is gone, and a deletion has nowhere to go
```

A body is not merged. No conflict marker is ever written into a file, no
`.orig` is left behind, and the unit is always a field.

**What a push refuses**, rather than guessing or silently dropping. A change the
plan does not carry is a change the re-render at the end would overwrite, so a
push holding any of these applies nothing at all and a person reads why:

| refusal | why, and what is missing |
| --- | --- |
| an edited body | A body renders out and does not read back (ADR-0329). This record said it pushes as a whole-value replace; `ContentCodec` declares `encode` and `decode` and no verb that replaces a live node in place, and giving it a third one is a decision about the definition vocabulary. |
| a new file | A row id is minted and never chosen (`packages/app/src/data/store/handles.ts`), because two devices creating one address produce two containers and one loses every field in it. A file cannot say which row it would be. |
| a missing file | Where a table names a trash field a deletion lands there as a value; no table can name one, which is the interim this record already sets. Adding `trash` to `TableDeclaration` reserves a third key beside `content` (ADR-0309), so it is an ADR rather than a push's business. |
| an edited `kv.json` | Pulled to read, never pushed, as below. |
| a removed frontmatter line | "Unset this" and "I did not mean to touch it" are the same signal, and a base cannot tell them apart. Setting the value to `null` says the first one. |

**`pull` refuses a dirty folder**, one whose files no longer match the manifest.
It shows the unpushed edits, and discarding them is the way past.

**A folder with no usable manifest is dirty, not clean.** Never pulled, manifest
deleted, manifest mangled by a conflict copy, and manifest written by another
account are one fact: nothing here wrote down what these files are. The
comparison runs against an empty base, so every row-shaped file already there is
shown to the person before anything replaces it. An arm that skipped the check
when there was no base is how the one refusal in this record gets bypassed by
editing a hidden file.

**`push` ends by re-rendering**, so a folder is never dirty after a successful
one.

**An agent edits; a person pushes.** `pull` writes an `AGENTS.md` at the folder
root from `compileData`'s output (`packages/app/src/data/definition/compile.ts`):
the tables, their fields and types, and the rules an agent needs. Values in the
frontmatter are what comes back; a body, a new file, and a deleted file do not,
and the table above is why. An agent never pushes. ADR-0330 makes the diff the thing that
makes an agent's work reviewable, and an agent that pushes its own work deletes
the review.

## Consequences

- **Deleted**, and the paths are named here for the last time because none of
  them resolves any more: `packages/app/src/data/artifact/`'s `mirror.ts`, its test
  and `protocol.ts`; `apps/epicenter/src/`'s `mirror.ts` and its test;
  `MIRROR_ROUTE` and its handler; and Honeycrisp's `attachMirror` wiring. What replaced them is smaller than
  what went: the debounce, the batch ceiling, the in-flight pass, the
  incomplete-pass rule, and the render-error-to-path mapping all had no
  question left to answer once a person chose the moment.
- **`pull` fails closed, and `renderArtifact` still does not.** Both are
  correct, and ADR-0325 already says why: a mirror that stops on one bad row
  leaves a folder that lies about the rest and re-renders on the next commit,
  while a row missing from a checkout is a deletion at the next push. `pull`
  collects the failures and refuses the whole checkout.
- **Never built:** ADR-0329's folder watcher, its echo suppression, its per-file
  base store, and the absence policy that watcher would have needed. Finishing
  the continuous design needed all four; the manifest replaces them.
- `renderArtifact` is `pull`'s half and `readArtifact` is `push`'s; `layout.ts`
  and `frontmatter.ts` serve both and are unchanged. `readArtifact` also stays
  the reader a mint uses (ADR-0293), which reads the folder as it is and
  consults no manifest.
- **The host gains a route that reads the folder**, which
  `apps/epicenter/AGENTS.md` refused under ADR-0271. That refusal served the
  one-way rule and goes with it. The host still holds no rows: it writes and
  reads files, and the application does the diff.
- **A person loses the incidental edit.** Fixing a typo in vim no longer lands by
  itself; it waits for a push. The application is one window away and was always
  faster for one field. Pulling a clean folder is safe in a way pushing never
  was, so freshness can return later without the watcher.
- The backup is the generation (ADR-0281), and it was already, since ADR-0289.
  A folder is current as of its `pulledAt` and says so.

## Considered alternatives

- **Keep the continuous mirror and add a watcher.** Rejected. It needs a base
  store, echo suppression, a debounce, and a policy for absence that no
  filesystem signal can justify, and it makes every `git checkout`, Dropbox
  sync, and Time Machine restore into an edit nobody made.
- **Refuse deletion through the folder.** Rejected. It makes a folder that resurrects files a person deleted, which is the
  behavior people already distrust in iCloud Drive, and it is unnecessary: the
  manifest makes absence a fact, and a trash field makes it cheap.
- **A threshold that refuses a push with too many deletions.** Rejected as a
  heuristic standing in for a fact. The confirmation is already the guard.
- **Two folders: a read-only mirror plus checkouts elsewhere.** Rejected. It asks
  a person to know which copy reverts and which one pushes, and the failure is
  editing the wrong one.
- **`export` and `import` as the verb names.** Rejected: those name re-homing
  between authorities (ADR-0325). ADR-0207's `push` was a continuous scan against
  host-owned receipts; this one is a deliberate cycle against a manifest that
  `pull` wrote, and the word is free.
