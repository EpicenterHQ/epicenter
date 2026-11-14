# 0894. Whispering 8 keeps its recordings and their audio in its own data directory, and needs no Epicenter

- **Status:** Proposed
- **Date:** 2026-11-13
- **Supersedes:** [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) (a program's Git clone, filed by the host) and [ADR-0888](0888-the-host-merges-with-gits-line-merge-and-a-file-it-cannot-merge-takes-the-later-side-whole.md) (merging what a clone pushes). A program delivering to a home is not yet decided ([ADR-0896](0896-each-collection-has-one-writer-of-record-and-epicenter-never-reconciles-two-writable-copies.md), "Not yet").
- **Amends:** [ADR-0890](0890-a-programs-folder-is-its-own-and-holds-only-what-its-apps-contract-declares.md) at the default folder (`data/` in the program's local data directory, not `~/Whispering`), at `recordings/k3x9.local.webm` (audio is `recordings/k3x9.webm`), at "holds only what the contract declares" (and the files beside a record that share its id), and at "Keychain: API keys, sign-ins" (provider API keys; Whispering has no sign-in). [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) at the `clone` noun, which goes. [ADR-0892](0892-the-cli-releases-to-npm-and-whispering-8-is-a-new-install-with-its-own-update-address.md) at "Import from Whispering 7", which goes. [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) at "a program's own sign-ins (Whispering's account)": a program's own secrets, such as Whispering's provider API keys. [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) at the `.local` row's "precious, kept here on purpose", the "Keep audio on this Mac only" setting, and the rejection of the app data directory. [ADR-0856](0856-binary-files-go-through-git-lfs.md) at Whispering's "Keep audio on this Mac only", which goes.
- **Relates:** [ADR-0840](0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md) (the folder sync product, whose client Whispering stops using), [ADR-0893](0893-a-records-path-is-its-path-in-the-apps-data-repository.md) (a record's path, which is its path in this folder).
- **Unbuilt:** all of it, in Whispering 8.0.

## Context

Whispering is the one program people other than its author install. Version
8 is a new install with its own identifier (ADR-0892), and its author chose a
clean break. On the author's Mac, v7.11 keeps 15,309 recordings as Markdown
in `~/Library/Application Support/com.bradenwong.whispering`, 2.7 GB of
models beside them, and 7 GB in WebView storage (IndexedDB).

Whispering today writes through `@epicenter/folder`, the client of the folder
sync product (`programs/whispering/src/lib/files.svelte.ts:14`), and signs in to
Epicenter for hosted transcription (`@epicenter/account`). This
computer's settings are already files at the top of the app's data directory
on the desktop and `localStorage` on the web (`packages/local/src/settings.ts`).
Local models live in the shared Hugging Face cache
(`packages/transcription/src/lib.rs:5-8`).

ADR-0887 gave a program a Git clone of its app's data. A clone needs Git on
every device, and a phone or a browser tab has none.

## Decision

**Whispering 8 keeps its recordings, and their audio beside them, in `data/`
in its own local data directory. It writes plain files that satisfy the
`whispering` app's contract, keeps no Git, and needs no Epicenter. Audio is
never deleted unless the person asks.**

```txt
~/Library/Application Support/so.epicenter.whispering/   Tauri's appLocalDataDir
  data/                          the folder: records and the files beside them
    recordings/k3x9.md
    recordings/k3x9.webm         audio, kept, sharing its record's id
  microphone.json, shortcuts.md, local-transcription.json, ...
                                 this computer's settings (packages/local)
Keychain                         provider API keys
Hugging Face cache               local models, shared with other programs
```

- **The folder is a setting.** Settings shows it with "Show in Finder",
  "Copy path", and "Change…". On the home, it may be
  `~/Epicenter/apps/whispering/data`; Whispering then has the folder and
  writes files there.
- **Audio is kept.** Settings shows its size and offers "Delete audio older
  than…". Nothing deletes audio on its own.
- **A record's audio is a file beside it with the same id.** The contract
  declares that a recording may have one; `defineCollection` takes `.md`
  paths only (`packages/app/src/path.ts:79`), so how it declares a file
  beside a record is decided when it is built.
- **This computer's settings stay this computer's.** The microphone, the
  global shortcut, the window, the folder, and the home's address are files in
  `packages/local`'s settings. `shortcuts.md` leaves the contract: a global
  shortcut belongs to one computer.
- **Provider API keys are in the Keychain** (the platform's credential store
  elsewhere). Whispering has no sign-in: hosted transcription and
  `@epicenter/account` leave it.
- **Whispering writes plain files** with Tauri's file system on the desktop
  and the browser's storage on the web. `@epicenter/folder` leaves it. Its
  tests check what it writes with `epicenter check` against the contract.
- **No import from v7.** A person who wants their v7 recordings copies the
  Markdown files.
- **First run asks one question:** where transcription runs, a local model or
  an API key. Nothing mentions Epicenter.

**In an app's data folder, a `.local` file is this computer's working file:
rebuildable or re-enterable.** Secrets, caches, locks, and temporary files
fit. A file that cannot be replaced is not `.local`. Whispering's folder needs
none.

## Consequences

- Whispering 8.0 ships without an Epicenter, a home, or Git, and commits only
  to the file format.
- A person using Whispering alone may sync its folder with iCloud Drive or
  Syncthing: no `.git`, and each file has its own id.
- Removing Whispering's app data, through an uninstaller or a cleaner, loses
  the recordings and their audio. Settings and the README say so, and say
  where the folder is. ADR-0858 rejected the app data directory for this
  loss; with no second visible place on a connected device, the owner accepts
  it. `appLocalDataDir` is not Windows' roaming profile.
- Models download again; v7's `models/` is left behind.
- Device state that should follow the person becomes a collection, as ADR-0890
  says.

## Considered alternatives

- **`~/Whispering` (ADR-0890).** A second visible place on each device beside
  the home's copy.
- **Audio in `audio/` beside `data/`.** Safe from a stray `git add` only while
  a device held `.git`; with none, beside its note is simpler.
- **Discard audio after transcribing unless kept.** v7 kept audio by default,
  and its author wants it kept.
- **Provider keys in `credentials.json`,** as built. A plain file on a laptop.
- **Keep `shortcuts.md` in the contract.** A file that travels and changes on
  each computer, with a per-computer override already in settings.
- **Import from v7.** Reading v7's WebView storage for a clean break its
  author does not need.
