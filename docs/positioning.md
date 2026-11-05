# Positioning

Canonical positioning for Epicenter. This doc owns the public claims and the
rules for deriving copy from them. Finished copy belongs to the surface that
ships it: README, landing page, GitHub About, package metadata, or launch plan.

Every claim here describes what the code does today. A decided but unbuilt
feature stays out of public copy until it ships; check the ADR's Unbuilt line.

## The spine

One message, cut to length and audience. No cut contradicts a shorter one, and
every claim from a shorter cut survives in the longer cuts.

One line, for one-line surfaces (GitHub About, social preview, link cards):

> Local-first apps over files you own.

The hero cut, for the root README:

> **Local-first apps over files you own.** An app's data is a folder of
> Markdown and JSON files with Git history beside it, whole on every device you
> use. It syncs over plain Git with a server you choose, and any editor, Git
> tool, or agent can work on the same files.

The public cut, for epicenter.so and other general-audience surfaces:

> Apps come and go. Your files shouldn't. Epicenter apps save everything you
> make as ordinary files in a folder on your computer, so what matters to you
> outlives every app that made it.

On public surfaces the mechanism (Markdown, JSON, Git, local-first) appears
below the fold, after the benefit it guarantees, never as the headline.

## The proof line

Every shipped surface longer than one line carries exactly one proof line,
stated without caveats. Each surface writes its own sentence, and that
sentence carries:

- Whispering, by name
- desktop speech-to-text
- you can install it today
- macOS, Windows, and Linux, somewhere on the surface (platform badges or
  adjacent copy count)

Roadmap language stays out of heroes.

## What Epicenter is

- Apps whose data is a folder: one Markdown file per row, an `AGENTS.md`
  that names the app's published contract, and Git history
  ([ADR-0534](adr/0534-data-folders-are-the-only-data-model.md)).
- A macOS app, Epicenter, that opens to your folders, lists them, sets each
  up to sync, syncs them while it runs, and shares them
  ([ADR-0537](adr/0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md)).
- A folder engine, `@epicenter/folder`, that opens an app's folder on disk in
  its desktop app and in a Bun script, and the signed-in account's
  repository for that app in a browser.

## What Epicenter is not

- Not cloud-first: a desktop app's folder works on one machine with no
  account, and syncs only once a person sets it up to sync.
- Not a real-time collaboration engine: a sync is a round of Git commit,
  fetch, merge, and push. A field both sides changed takes the later write,
  and edits that clash in a note's body stay side by side in a conflict
  block for a person to resolve
  ([`@epicenter/definition`](../packages/definition/README.md#merging-a-note)).
- Not encrypted end to end: whoever runs the Git server a folder syncs with can
  read it. See the [trust model](trust-model.md).

## Verifiable claims

Every public claim must be provable by inspecting the repository:

| Claim | Proof |
| --- | --- |
| "We ship" | Whispering installs on macOS, Windows, and Linux through normal release channels. |
| "Files you own" | A folder's rows are Markdown files with YAML front matter (`packages/folder`), and once a person sets it up to sync, its history is a Git repository that `epicenter sync` commits to (`packages/cli`). |
| "Any tool can edit them" | The desktop shell watches the folder, so an edit made outside the app appears in it (`tauri-plugin-epicenter-folder`); a note an edit leaves outside the contract shows as invalid, with its text, for repair (`packages/folder`). |
| "Syncs over plain Git with a server you choose" | A folder's remote is `origin` in its own Git configuration, which `epicenter connect` or plain `git remote add` sets to any Git URL (`packages/cli`, ADR-0532). |
| "Bring your own model" | AI features accept user-provided API keys. |

## Vocabulary

Use the word a person already has on public surfaces: folder, file, app, sync.
Keep `declaration`, `shape`, `lens`, and `engine` in developer docs.

Do not use hype words: `AI-native`, `agentic`, `next-gen`, `revolutionary`,
`redefine`, `game changer`, `Web3`, `metaverse`. Do not describe Epicenter's
data as CRDT-backed, conflict-free, or synced through a relay: none of those is
true of data folders.

## Package copy

Each package's npm description and keywords live in its `package.json`; that
file is the owner. A description leads with what the package does, not what
category it is in.
