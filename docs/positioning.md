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

- Apps whose data is a folder: one Markdown file per row, settings included,
  a `.epicenter.json` in each table's directory for its schema, and Git history
  ([ADR-0534](adr/0534-data-folders-are-the-only-data-model.md)).
- A desktop app that opens to your folders, lists them, edits their rows, and
  opens each in the apps whose shape it fits
  ([ADR-0537](adr/0537-epicenter-opens-to-your-folders-and-home-becomes-settings.md)).
- A folder engine, `@epicenter/folder`, that opens the same folder in a
  browser, in the desktop app, and in a Bun script.

## What Epicenter is not

- Not cloud-first: a folder works on one machine with no account, and syncs
  only when a person syncs it.
- Not a real-time collaboration engine: a sync is an explicit Git transfer,
  and overlapping edits are decided by a person
  ([ADR-0548](adr/0548-a-view-is-a-cache-of-files-with-one-write-path-one-read-path-and-one-channel-of-change.md)).
- Not encrypted end to end: whoever runs the Git server a folder syncs with can
  read it. See the [trust model](trust-model.md).

## Verifiable claims

Every public claim must be provable by inspecting the repository:

| Claim | Proof |
| --- | --- |
| "We ship" | Whispering installs on macOS, Windows, and Linux through normal release channels. |
| "Files you own" | A folder's rows are Markdown files with YAML frontmatter, its settings are rows too, and its history is a Git repository (`packages/folder`). |
| "Any tool can edit them" | The desktop shell reads every change from disk; an edit made outside the app appears in it (`tauri-plugin-epicenter-folder`, ADR-0548). |
| "Syncs over plain Git with a server you choose" | A folder's remote is `remote.origin.url` in its own Git configuration (ADR-0521, ADR-0532). |
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
