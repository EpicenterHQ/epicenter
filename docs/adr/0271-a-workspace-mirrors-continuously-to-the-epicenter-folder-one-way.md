# 0271. A workspace mirrors continuously to the Epicenter folder, one way

- **Status:** Accepted
- **Date:** 2026-08-27
- **Amends:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md) at what a host may hold. That record refused a second CONVERGENT plane and said so in its own words ("The refusal is of a second CONVERGENT plane, not of the host holding bytes"), then permitted the host to hold blob bytes on exactly that reasoning. A one-way mirror cannot diverge for the same reason a blob cannot: nothing merges it back.
- **Amends:** [ADR-0264](0264-a-table-declares-its-row-documents-derivation-and-file-codec.md), which left this open: "where its output goes, an export or a rendered folder, is a later record's decision." ADR-0267 took the export branch. This takes the other one, and then takes over from it.
- **Amends:** [ADR-0267](0267-a-workspace-exports-and-imports-as-a-legible-folder-structured-artifact.md) and [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) at who produces the artifact and when. The artifact's shape is unchanged; export stops being a verb a person invokes, and "a directory, zipped for download" is refused with it.
- **Revives:** [ADR-0207](0207-rows-render-continuously-to-markdown-and-frontmatter-is-the-only-way-back.md), the render direction only. Its folder, its one-file-per-row shape, and its "point your agent at `~/Epicenter`" premise return. Its entire write direction does not.
- **Relates:** [ADR-0268](0268-a-row-exports-as-one-markdown-file-and-its-codec-is-mandatory.md) (the file shape this renders), [ADR-0270](0270-an-application-has-two-workspaces-and-moving-a-row-between-them-is-the-primitive.md) (the two workspaces this lays out), [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md).
- **Amended by:** [ADR-0329](0329-frontmatter-round-trips-and-the-body-only-renders-out.md) at the word "one way," which is withdrawn for a row's values only: an application may read its own folder's frontmatter and apply it to its own store, against a base of what that file was last rendered at. Two sentences here go with it: "there is no push, no receipt, no watcher, and no conflict concept," and "nothing derived from a file ever reaches a row." Both now hold for the body alone. The layout, the manifest, the leave-it-alone rule, the do-not-rewrite-matching-bytes rule, and the body's one direction are unchanged.
- **Amended by:** [ADR-0289](0289-the-folder-is-where-a-generation-is-minted-from-not-a-surface-kept-current-for-its-own-sake.md) at why the render runs continuously. Everything this record decides about what a pass contains still governs: the layout, the one direction, the manifest, the leave-it-alone rule, and the do-not-rewrite-matching-bytes rule. What is withdrawn is the premise revived from ADR-0207, that an always-current folder is the product and a stale folder is therefore a defect.
- **Partly built:** the render. `renderRow` in `packages/app/src/data/artifact/` turns one row into one file and `renderArtifact` yields that call in a loop, one file at a time, which is the boot pass. The host file sink, the folder root, and the signal that says which rows a commit touched do not exist.
- **Amended by:** [ADR-0337](0337-the-folder-is-a-working-copy-and-pull-and-push-are-the-whole-cycle.md) by withdrawing the continuous render and the one-way rule. The folder is filled by `pull` and read by `push`. The layout, the leave-it-alone rule for a failed row, and the do-not-rewrite-matching-bytes rule are unchanged.

## Context

ADR-0268 made a row into one Markdown file with its fields as frontmatter, so an export is a folder a person can read in any editor. The same rendering, run on every commit instead of on demand, is a live folder: `ls ~/Epicenter` is the database, and pointing a coding agent at it needs no API, no client, and no permission model.

ADR-0207 built exactly that and it was deleted with the host replica it read from (`apps/epicenter/src/folder/`, reading `source.replicaPath`). Two things killed it, and neither was rendering. It read the host's own replica, which no longer holds application data (ADR-0226). And it was a second WRITER: `epicenter push`, base-versus-mine receipts, per-field diffs travelling back into the store. ADR-0234 later tried the write direction again for Ark pages and retreated to a deliberate checkout with a three-way-safe patch.

What is different now is that the render no longer needs the host to own anything. The application holds the rows and the codec; it only lacks a filesystem.

## Decision

**A workspace renders continuously to a folder, one direction, and nothing reads it back.**

```txt
~/Epicenter/
  local/
    so.epicenter.honeycrisp/
      kv.json
      notes/<rowId>.md
      folders/<rowId>.md
  account/
    so.epicenter.honeycrisp/
      notes/<rowId>.md
```

**The application states, and the host reconciles.** One route takes a pass: the files an application rendered, plus a manifest of every path its workspace holds. The application owns the rows and the `file` codec, so it decides what each file contains; the host owns the folder, so it writes, removes what the manifest does not name, and rebuilds the index from what survived. The application never asks what the folder currently holds, and there is no route that would let it.

The host does read files. Both reads are derived-to-derived: names, to know what a render no longer justifies, and contents, to build `tables.sqlite` beside them. The seam this record guards is narrower than "the host never reads" and is the one that matters: **nothing derived from a file ever reaches a row.**

**A pass that did not finish deletes nothing.** The manifest is last and arrives exactly once, so a dropped connection leaves files written and the folder stale rather than gutted. A path in the manifest with no contents means "leave that file alone", which is how a row whose codec threw keeps the file it already has.

**A file whose bytes already match is not rewritten.** A rename replaces the inode, so rewriting unchanged files would make Time Machine, rclone, and Spotlight see the whole vault as new on every pass, which would contradict the backup story this record sells.

**The folder is build output.** An edit to a mirrored file does not survive the next render. There is no push, no receipt, no base-versus-mine comparison, no scan, no status verb, no watcher, and no conflict concept. To fork your data, copy the folder and restore the copy (ADR-0272).

**The folder is build output, and it is also the recovery copy.** Those are not in tension, because the direction never changes: nothing here is read back into a store, and getting data back in is restore (ADR-0272), which replaces a workspace rather than merging into one.

The promotion is forced by a measurement, not chosen. `navigator.storage.persist()` is refused in the real Tauri WebView, so the browser makes no promise that the durable record survives storage pressure (ADR-0275). It survives a quit and relaunch today, and nothing observed has reclaimed it, but "not promised" is what this folder answers. So `~/Epicenter` is the copy that outlives a reclamation the store cannot prevent, and a person deleting it is deleting that, which is something the product owes them plainly rather than in a footnote.

**The top level says where data lives, and every level means one thing.** `local/` and `account/` are places; inside each, a full reverse-DNS database id names an application; inside that, a table; inside that, a row. `local/` is an address and will mean this machine forever. `account/` is a VIEW: it holds whoever is signed in now, and signing in as someone else changes what the same path means. Naming the account instead was priced and refused, because it costs a nickname, somewhere to store it, a marker file, a rename verb, a collision rule, and a sweep that must read the marker before deleting anything, all for a person who wants to read one account's files while signed into another. Third-party applications are expected to return, so the definition id is spelled in full: `com.acme.notes` and `so.epicenter.notes` are different folders and the vendor prefix is what says so.

**Only the active connection's account workspace is mirrored.** The desktop holds one connection record (ADR-0262/0263), so at most one account workspace is live. Replicas retained for accounts you are not signed into get no folder. Signing into a different account re-renders `account/`, which is what Dropbox does when you link a different account, and is acceptable precisely because switching accounts is a rare, deliberate, identity-level act rather than a routine one.

**The mirror mirrors.** Deleting a row deletes its file. Deleting a file brings it back at the next render. A row that never conformed still renders, because the artifact reads what is stored rather than what the declaration names (ADR-0267).

**The mirror is the only producer, and export stops being a verb.** There is no Export button and no downloaded archive. The files are already on disk and already current, so a backup is `cp -r`, sharing is `zip -r`, and both are things the operating system already does better than an application would. What a person invokes is Reveal in Finder, which is a shortcut rather than a feature.

**Browser-targeted export is refused, not deferred.** ADR-0227 already refused hosted web ("A browser tab is not a target"), so the only browser is the WebView inside Tauri, which always has a host beside it. Keeping a download path for a runtime that was already refused is what forced two artifact producers and, with them, a whole-workspace-in-memory assembly step. With one producer the render streams row by row straight to disk, and nothing ever holds the whole artifact at once.

**Desktop only, and that is now the whole story rather than half of it.** A build with no host beside it (a development server opened in a real browser) has no mirror and no export. That is a development degradation, not a product mode.

## Consequences

- "Point your agent at `~/Epicenter`" works with no API, no client library, and no new permission surface. The agent reads files.
- Backup stops being a feature. The folder is on disk and current, so `cp -r`, Time Machine, or rclone are the backup story, and Epicenter never holds a legible plaintext copy of a person's notes. The end-to-end encryption option that `sync/authority.ts` protects by never decoding bytes stays unspent.
- `git init ~/Epicenter` makes a restore auditable with tools that already exist, which is a consequence of the files being real rather than a feature anyone builds.
- `store.onCommitted` gets its first consumer since the SQL projection was deleted (ADR-0269). The phase-order contract it guarantees, followers marked dirty before any table subscriber reads, is what a renderer needs.
- ADR-0010's warning applies and is accepted with a mitigation owed: "a continuous producer with no consumer, paid on every edit." The consumer exists now (a coding agent with `ls` and `Read`), and the cost is a file write joining every commit, which needs debouncing and an atomic write so an agent cannot read a half-rendered file.
- One artifact producer instead of two. The zip assembly, the download flow, the save dialog, and the archive-progress model are not built, and the whole-map return shape becomes a per-row render that streams to disk. The in-memory ceiling on a large vault goes away by there being nowhere to hold one, rather than by optimizing.
- `apps/epicenter/AGENTS.md` currently says "Do not rebuild any of them here" about the folder renderer. That instruction is superseded for the render direction and stays in force for the write direction.

## Considered alternatives

- **Keep an Export button beside the mirror.** Refused. It is a second producer of the same bytes, and the second one is the one that has to assemble a whole workspace in memory to hand over an archive. Its only unique consumer was a browser build that ADR-0227 already refused.
- **Zip the Epicenter folder on demand instead of mirroring.** There is no folder to zip. The store lives in IndexedDB inside the WebView and the host owns no application data (ADR-0226/0227). "Just zip the directory" is not a shortcut past building this; it is this.
- **A two-way folder, as ADR-0207 built it.** Refused. It is where receipts, three-way merges, conflict semantics, and a scan-and-push pipeline come from, and ADR-0234 retreated from it after building it once. The write direction has a door already: restore.
- **Let a file you touched stop being re-rendered until you import or discard it.** ADR-0207's "hold back exactly what you could still push." Refused: knowing what you touched is what receipts are for, and this is the seam through which the entire deleted machinery grows back.
- **One folder whose contents swap as you switch between the two places.** Refused: `local/` and `account/` are separate folders, so neither ever means the other. `account/` swapping when you sign in as a different person is a different case and is accepted above, for the reason Dropbox accepts it: switching accounts is a rare, deliberate, identity-level act.
- **A per-file transfer: `PUT` one file, `GET` the listing, `DELETE` the strays, `POST` the index.** Built first and refused. It made the application reconstruct what the folder held in order to drive it, which is a fact the host already had, and every defect the design produced sat on that seam: a wildcard route param Hono does not capture, a `..` that passed a grammar check, and a file deleted because its render failed. One verb that states the target deletes the seam rather than fixing its symptoms.
- **Path segments that encode the replica address exactly.** Refused: the account address carries a percent-encoded server URL and an opaque auth id, and ADR-0207 set the bar this fails ("the default has to be typeable"). Restore takes a destination as an argument, so a path never has to be parsed back into a store.
