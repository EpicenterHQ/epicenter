# 0858. Where a file lives decides whether it travels, survives, or dies with its program

- **Status:** Accepted (2026-11-09)
- **Date:** 2026-11-09
- **Amended by:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md): for an app in an Epicenter, a secret is a `.local` file, not a Keychain item, and a collection may have a `.local` path, offering no actions. A program's own sign-ins, such as Whispering's account, stay in the Keychain.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (ignored paths are written and never committed), [ADR-0851](0851-an-app-has-one-home-and-an-optional-push-only-backup.md) (the remote is the backup), [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (Whispering's folder), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (`.cache/`), [ADR-0856](0856-binary-files-go-through-git-lfs.md) (binaries through LFS).
- **Unbuilt:** the template's `*.local` and `*.local.*` lines; Whispering's first-run folder sheet, its `<id>.local.<ext>` audio, the "Keep audio on this Mac only" setting, and its sign-ins in the Keychain instead of `credentials.json`.

## Context

A program like Whispering keeps several kinds of state, and nothing said where
each goes. Today its shell keeps `credentials.json`, `account.json`, and
`shortcuts.md` in its Tauri app data directory
(`~/Library/Application Support/so.epicenter.whispering` on macOS), and its
contract places recordings and their audio together under `recordings/`. The
old product's folders in `~/Epicenter` show the cost of not deciding: each
holds a `.epicenter/` of program state beside the person's notes. The template
`.gitignore` is `node_modules/` and `.cache/`, so "this computer only" had no
spelling inside a folder. And a person can want a recording's text on every
computer while its audio stays on the one that recorded it.

## Decision

**A file belongs in one of three places, and inside the folder in one of three
kinds of path, each chosen by one question.**

```txt
Is it a secret?                          yes → the Keychain
Should it die with the program?          yes → the program's data directory
                                         no  → the app's folder in ~/Epicenter
Inside the folder:
Can it be rebuilt?                       yes → .cache/
Would it be right on another computer?   yes → a tracked path
                                         no  → a .local path
```

| Place | Holds | Example |
| --- | --- | --- |
| the app's folder, `~/Epicenter/<app>/` | what outlives the program: the person's data and the preferences that follow them | `recordings/<id>.md`, `settings.md` |
| the program's data directory (Tauri's `app_data_dir`) | what dies with the program on this computer | the remembered folder identity, window state, webview storage, logs, the updater, downloaded models |
| the Keychain, service `epicenter.<app>` | every secret | an API key, an OAuth refresh token |

A secret is never a file, in either directory.

**Inside the folder, the path is the policy.** Whether a file travels is decided
by where it is written, never by a setting the commit step reads. The template
`.gitignore` is exactly:

```txt
node_modules/
.cache/
*.local
*.local.*
```

| A file whose path | Travels | If lost | Meaning |
| --- | --- | --- | --- |
| matches no line | yes, to every clone and to the `origin` host | restored from the remote | the person's data |
| matches `*.local` or `*.local.*` | no, this computer only | gone: it has no backup | precious, kept here on purpose |
| is under `.cache/` | no | rebuilt | deletable at any time |

Tracked means the `origin` host can read it. An app whose data must not reach a
host chooses its `origin`, or keeps those files `.local`.

**A local file is named after its pair, so the two sort together.** `.local`
goes before the extension: `settings.local.md` beside `settings.md`, and
`<id>.local.webm` beside `<id>.md`. A person sees both halves in one listing,
and the name says what differs. Starting to sync a local file is renaming it
without `.local`, which commits it as a new path. Stopping never rewrites
history: files already committed stay in it.

**Whispering keeps its folder at `~/Epicenter/whispering`, created at the first
recording.** Installing creates nothing. Before the first recording is written,
one sheet says "Recordings are saved in ~/Epicenter/whispering." with
"Use this" and "Choose another…"; choosing another folder makes
`~/Epicenter/whispering` a link to it. The home entry is Whispering's pointer.

**A recording's text always travels; its audio travels unless the person keeps
it local.** One setting, "Keep audio on this Mac only", chooses the name of
future audio files and never moves existing ones:

```txt
~/Epicenter/whispering/
├── recordings/
│   ├── <id>.md              the recording's note            tracked
│   ├── <id>.webm            audio, when the setting is off  tracked, through LFS
│   └── <id>.local.webm      audio, when the setting is on   ignored, no backup
├── transcriptions/<id>.md   tracked
├── settings.md              preferences that follow the person
├── settings.local.md        this computer's preferences, such as the microphone
└── .cache/                  waveforms and the recording in progress
```

The setting is off by default. The player reads `<id>.<ext>`, then
`<id>.local.<ext>`; when neither exists it shows "Audio stays on the computer
that recorded it." Which file exists is the whole state: the note carries no
field saying where its audio is.

## Consequences

- Uninstalling a program, or a cleaner that deletes Application Support,
  removes only what the program could recreate. The person's data and its
  history stay in `~/Epicenter`.
- Audio kept local has no backup. Losing the Mac loses it; its notes and
  transcriptions survive on the remote. The setting says so where it is turned
  on.
- A person who keeps all audio local never needs `git-lfs` for Whispering, and
  uses no LFS quota.
- `.local` is reserved: a collection key whose path would contain `.local.` is
  never synced, so a collection's `save` refuses one.
- `~/Epicenter` appears in a person's home the first time they record, even if
  they never install `epicenter`. The sheet names it before it exists.
- Whispering's sign-ins move from `credentials.json` into the Keychain, and its
  program state stays out of the folder; the old product's `.epicenter/`
  directories are not repeated.

## Considered alternatives

- **Whispering's data in its app data directory, linked into `~/Epicenter`
  later.** Uninstallers and cleaners delete that directory with every
  recording; its path depends on the bundle identifier; on Windows it is the
  roaming profile, meant for small settings; and linking it exposes the
  credentials beside the data.
- **`~/Documents/Whispering`.** iCloud's "Desktop & Documents" syncs it by
  default, and iCloud syncing a `.git` directory corrupts repositories.
- **`*.local*` as one pattern.** It matches macOS's `.localized` and
  `en.locale.json`.
- **A `recordings.local/` directory.** It separates a note from its audio, and
  every reader looks in two directories.
- **One `local/` directory mirroring the folder.** One ignore line, but each
  local file sits far from its pair and every path is written twice.
- **Ignoring by extension.** The same type can travel or stay, so type is not
  the policy.
- **A `sync` setting the commit step reads.** A second place deciding what is
  committed, beside `.gitignore`, which already decides it.
- **A per-recording field naming where the audio is.** It can disagree with the
  files; the files cannot.
