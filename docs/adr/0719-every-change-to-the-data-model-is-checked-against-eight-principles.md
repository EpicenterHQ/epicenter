# 0719. Every change to the data model is checked against eight principles

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-03
- **Supersedes:** [ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md) (every change to the data model is checked against nine principles): its principles describe browser clones, IndexedDB datasets and a merge that writes no conflict marker, which ADR-0700 and the records cited below replace.
- **Unbuilt:** ADR-0705 through ADR-0718 and ADR-0720, which the principles cite, are Proposed and unbuilt in part; the principles describe the model those records build toward.
- **Amended by:** [ADR-0730](0730-everything-not-derived-from-an-apps-site-is-one-of-five-stored-kinds.md) at principle 5: "Derive from the site; store only data, decisions, proofs, exceptions, and caches"; [ADR-0731](0731-every-app-signs-in-as-its-site.md) at principle 6: each app signs in as its site, and a machine groups those sign-ins; [ADR-0741](0741-epicenter-reconciles-only-states-it-made.md) at principle 8: "Epicenter reconciles what it made; anywhere else, the screen says what it found and the command that fixes it."; [ADR-0751](0751-every-native-app-carries-one-sync-core.md) at principle 6's "syncing goes through Epicenter's engine" and principle 7's "one engine": each native app syncs through its own copy of one sync core.

## Context

[ADR-0627](0627-every-change-to-the-data-model-is-checked-against-nine-principles.md)
kept a maintained summary of the data model in nine principles. Its
principle 2 has a browser clone holding Git objects and refs, principle 5
keeps each browser origin's dataset in IndexedDB, and principle 6 has one
merge in which the last edit wins and no conflict marker is written.
[ADR-0700](0700-apps-share-data-through-a-file-contract-recorded-in-git.md)
amended principles 1, 2, 5, 6, 7 and 9: the web never syncs, notes merge
with conflict blocks, and binaries travel as Git LFS.

Records 0705 to 0718 then add documents beside folders, a shared field
vocabulary, slug names, fixed roots, one engine per machine, one merge rule
by extension, a machine home at `~/.epicenter`, and an app's site as its
identity. Amending 0627 again would leave most of its sentences describing
the replaced model.

## Decision

**Three sentences say where everything is.**

- **Everything you own is in `~/Epicenter`.** Each app keeps its folder there,
  named from the app's address. A folder that lives somewhere else is a link
  inside it.
- **Everything a machine shares is in `~/.epicenter`.** The sync engine, the
  sign-in, local copies of documents, and logs. Secrets stay in the keychain.
- **You sign in a machine, not an app.** One account per machine. Every
  Epicenter program on it shares that sign-in.

**Every change to the data model is checked against these principles.** The
cited records govern where a principle and a record differ.

1. **Records are files or documents; a database is only ever a cache.** An
   app keeps what lasts as notes and files in a folder, or as a document
   synced through the account. SQLite lives in AppData and is rebuilt from
   them ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md)).
2. **One field language, one export format.** The field language is a written
   subset of JSON Schema, which each reader (`check`, generic views, `query`, a
   document app) interprets directly
   ([ADR-0727](0727-json-schema-is-the-field-language.md)). Markdown notes with
   attached files are every store's export, and moving data between stores is
   an export then an import
   ([ADR-0705](0705-an-apps-data-lives-in-two-kinds-of-store.md),
   [ADR-0707](0707-an-app-that-needs-co-editing-is-a-document-app.md),
   [ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md)).
3. **An app's site is its identity, every name derives from its host, and
   the environment picks the roots.** `https://whispering.epicenter.so`
   identifies the app, and a folder's `AGENTS.md` names the contract URL served
   from it. An app at a direct subdomain of `epicenter.so` is named by its
   label (`~/Epicenter/whispering`); every other app lives in its owner's
   folder (`~/Epicenter/bradenwong.com/zhongwen`); AppData is the reversed host;
   production and development differ only in roots ([ADR-0723](0723-an-apps-site-is-found-by-convention.md), [ADR-0722](0722-an-apps-names-derive-from-its-sites-host.md),
   [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md)).
4. **Each app has two places on a machine with the same note names.** The
   synced folder holds what follows the person; the device's AppData holds
   overrides. `settings.md` and `shortcuts.md` are read as defaults, then the
   folder's note, then the device's (Whispering's `shortcuts.md`, `apps/whispering/src/lib/settings.tauri.ts`).
   Epicenter's machinery is a third place, `~/.epicenter` ([ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md),
   [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md)).
5. **Find things by convention; store only the exceptions.** A program
   derives a folder's path from the app's site and the environment, and
   Epicenter finds every folder by scanning the root and its owner folders,
   following links. No program stores where a folder is; a folder that lives
   elsewhere is a link at its derived path, so no list of folders exists
   ([ADR-0721](0721-an-apps-folder-is-derived-never-stored.md), [ADR-0712](0712-an-apps-folder-resolves-against-a-fixed-library-root.md), [ADR-0718](0718-epicenters-machinery-on-a-machine-lives-in-a-hidden-home-every-program-reads.md),
   [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)).
6. **Apps work alone; Epicenter and the account add capabilities and never
   take custody.** A folder app needs no account and no Epicenter to save
   locally; syncing goes through Epicenter's engine. Signing in
   grants capabilities, not storage, and one sign-in serves every first-party
   program on the machine ([ADR-0720](0720-you-sign-in-a-machine-not-an-app.md)). Inference is independent of sync
   ([ADR-0634](0634-hosted-inference-is-independent-of-repository-sync.md),
   [ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md),
   [ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md)).
7. **One engine and one merge rule wherever Git runs; conflicts stay
   visible.** A `.md` note merges fields and body with `settle`, a file with a
   binary extension goes to Git LFS, and every other file merges as text by
   line. A browser runs no
   Git ([ADR-0713](0713-one-epicenter-engine-per-machine-syncs-every-apps-folder.md),
   [ADR-0714](0714-a-files-extension-decides-how-every-folder-merges-it.md),
   [ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md)).
8. **Where a guarantee is weaker, the screen says so.** A browser variant
   shows "On this browser", Epicenter shows "Not synced", and a document copy
   from an older generation is refused with a choice
   ([ADR-0706](0706-a-browser-variant-runs-the-desktop-code-with-weaker-guarantees.md),
   [ADR-0709](0709-a-document-is-rebuilt-into-a-fresh-generation-by-copying-its-current-state.md),
   [ADR-0715](0715-the-epicenter-app-browses-every-folder-and-document-a-person-has.md)).

## Consequences

- A change that breaks a principle names the principle and the record that
  changes it.
- When a cited record changes, the principle is restated in the same change.
- A hosted service is checked against principle 6: it adds no prerequisite to
  opening local data and no file format or merge rule.

## Considered alternatives

- **Amending ADR-0627 again.** Its principles 2, 5 and 6 describe browser
  clones, IndexedDB datasets and a merge with no conflict marker, all replaced
  by ADR-0700; another amendment would leave most of its text describing the
  old model.
- **A principles page outside the ADRs.** Two places would hold one rule, and
  the page would drift from the records that govern it.
