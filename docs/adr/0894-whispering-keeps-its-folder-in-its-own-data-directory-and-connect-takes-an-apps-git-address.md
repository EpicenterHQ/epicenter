# 0894. Whispering keeps its folder in its own data directory, and Connect takes an app's Git address

- **Status:** Proposed
- **Date:** 2026-11-13
- **Amends:** [ADR-0890](0890-a-programs-folder-is-its-own-and-holds-only-what-its-apps-contract-declares.md) at the default folder: the program's own data directory, not `~/Whispering`. [ADR-0887](0887-a-program-keeps-a-clone-of-an-apps-data-repository-and-the-host-files-what-it-pushes.md) at how a program connects: it takes the app's Git address.
- **Relates:** [ADR-0858](0858-where-a-file-lives-decides-whether-it-travels-survives-or-dies-with-its-program.md) (where a file lives), [ADR-0875](0875-a-package-is-published-when-an-app-outside-the-monorepo-imports-it.md) (when a package is published), [ADR-0889](0889-an-app-runs-on-epicenter-a-program-works-with-it-and-they-meet-at-the-apps-contract.md) (programs), [ADR-0892](0892-the-cli-releases-to-npm-and-whispering-8-is-a-new-install-with-its-own-update-address.md) (Whispering 8).
- **Unbuilt:** all of it, in Whispering 8 and 8.1, and the launcher's Git addresses.

## Context

ADR-0890 put Whispering's folder at `~/Whispering`, visible in the home
folder, so people and agents could read recordings. On a device, Whispering is
that folder's only reader: once connected, people and agents read the host's
copy at `~/Epicenter/apps/whispering/data`. A visible folder on each device
advertises a second place to look. Apps whose only reader is the app keep
their data in their own directory: Whispering v7.11 (about 18,000 files in
`~/Library/Application Support/com.bradenwong.whispering` on the owner's Mac),
MacWhisper, Voice Memos, Apple Notes, Bear, and Day One. Apps whose folder is
the product keep it visible: Obsidian, Zotero, Superwhisper.

## Decision

**Whispering's folder is `data/` in its own local data directory, a setting
the person can change. Connect takes the Git address of an app in an
Epicenter. Whispering 8.0 ships alone; Connect ships in 8.1.**

```txt
~/Library/Application Support/so.epicenter.whispering/   Tauri's appLocalDataDir
  data/                         the folder: what the contract declares
    recordings/k3x9.md
    recordings/k3x9.local.webm
    .git/                       once connected
  settings, models, window state
```

- **Settings shows the folder** with "Show in Finder", "Copy path", and
  "Change…". The files are Markdown at that path; no export is needed.
- **First run asks one question:** where transcription runs, a local model or
  an API key. Permissions are asked at first use. "Import from Whispering 7"
  appears once when v7.11's folder exists. Nothing mentions Epicenter.
- **Connect takes one string,** the app's Git address, such as
  `http://studio:4747/whispering.git`, the same address `git remote -v`
  prints. "Check" reports, each with one line to fix it: Git is installed,
  the address answers, the app exists, and what will be sent. After that, one
  status line: sent, N waiting, or not filed.
- **The launcher at `/` shows each app's Git address.**
- **On the host,** Connect finds the local Epicenter and offers "Use its
  folder", which sets the folder to `~/Epicenter/apps/whispering/data` and
  connects nothing (ADR-0890).
- **A program outside this repository follows the documented file format**
  until a program there imports the front matter writer, which ADR-0875 then
  publishes.

## Consequences

- No first-run folder sheet, and one rule on macOS, Linux, and phones:
  the platform's local data directory.
- A person using Whispering alone who removes its app data, through an
  uninstaller's "Delete application data" or a cleaner, loses their
  recordings. The README and the folder setting say so.
- What outlives a device is what reached an Epicenter or a backup.
- Whispering 8.0 commits to nothing Connect must undo.

## Considered alternatives

- **`~/Whispering` (ADR-0890).** A second visible place on each device; the
  host's copy is where people and agents read.
- **Connect takes the Epicenter's address and picks the app.** A second
  string for the same thing, and a list the program must ask for.
- **Publish `@epicenter/app` with the first CLI release.** A second copy of
  the runtime's API for a consumer that does not exist yet (ADR-0873).
