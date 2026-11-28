# Backlog

Outcomes this repository still owes, and nothing else. A package's
not-yet-built list lives in its README; the owner's personal apps keep theirs
in their own Epicenter.

Recording an outcome does not schedule or authorize it. Remove an entry when
its outcome is done, keeping any unfinished scope. Before starting one, check
current code and dirty work: several chats share this checkout.

## Whispering

### Ship Whispering 8

- Desired result: The rewrite
  ([#2774](https://github.com/EpicenterHQ/epicenter/pull/2774)) is released
  as Whispering 8 and a person who installs it stays current. Its identifier
  is `so.epicenter.whispering`, so it is a new app to the system: a
  Whispering 7 install does not update into it, and 8 needs its own update
  feed from its first release.
- Must still hold, each checked by hand: a failed key save leaves one
  recoverable row; unsaved transcript edits survive a failed save; an
  interrupted native recording releases the microphone and is finished when
  the app opens again; a recording shows where its audio and transcript live.
- Owed, each its own pull request:
  - Updates: the app finds, downloads and installs a newer release, with
    signing and a release workflow. Nothing exists yet.
  - A menu-bar icon with Show, Record and Quit, so closing the window is safe
    on every platform. Today a Mac hides the window to the Dock and other
    platforms quit.
  - Windows and Linux: the media pause and paste code for them has never been
    compiled in the rewrite, the pill's window is untried there, and the
    transcribe.cpp runtime libraries that `build.rs` stages are not bundled
    as resources.
  - One place for failures: where every user action finishes, the app shows
    the message and records a line in a log file in its own folder (time,
    what was being done, the error's name and message; never transcript text
    or a key), capped in size. A window-level handler records failures that
    shared code hands up with `reportError`. Settings has a button to copy
    the file. Features and screens return errors and call neither `toast`
    nor a logger.
  - Launch at login through `SMAppService` on a Mac. The login item records
    the program's path today, which breaks when the app moves.

### Text while speaking

- Desired result: Words appear as they are said, in the way Handy does it,
  designed before it is built: where partial text shows, what the dictionary
  and cleanup do with text that arrives in pieces, and what a server that
  does not stream does.
- Likely the same change: the shortcut and hold to talk record through the
  listener hands-free uses, so every take keeps the half second before the
  press and hold to talk works while hands-free listens. Two reviews
  recommended it on 2026-11-27.

### Whispering as a transcription engine

- Built: the desktop program transcribes a file from a terminal
  (`--transcribe-file`, `--model`, `--json`, `--list-models`), with the model
  chosen in the app, any audio the decoder reads, and named failures. An
  Epicenter reaches Whispering this way: an action written with
  `defineAction` runs the command line by its full path.
- Open: whether it applies `dictionary.txt` and cleanup, whose rules are
  TypeScript today; whether it may send the file to the server the app is
  set to. Both wait for a caller that needs them.
- Then: `apps/codex` switches from Handy to it with one setting.
- Refused: a folder picker; a background server for an Epicenter to call;
  recording from the command line.
- Set aside, not refused: a Whispering app to copy into an Epicenter, and
  Whispering sending each finished recording to one.

### Dictation into other apps

- Built in the rewrite: dictation starts from any app, a floating pill shows
  it working, and a paste that cannot land leaves the text on the clipboard
  and says so.
- Owed: paste only when the app that was in front when the take ended is
  still in front. A take that waits its turn can paste into whatever window
  is in front by then.
- Later: a spoken instruction may revise selected text or use chosen screen
  content, always previewed before it acts.

## Operations

### Take down the retired hosted API

- Desired result: Nothing still serves `api.epicenter.so`, and the people who
  used it have their data and any paid balance handled.
- Grounding: The retirement removed the code and the deploy step, which stops republishing but takes nothing down.
  The live Worker, its Postgres database, its Infisical secrets, Autumn
  billing, OAuth client rows, and account data stay as they were. Account
  deletion was never automated.
- Revisit when: Before anything else reuses the domain, or when the owner
  decides how to close paid plans and credit balances. This entry does not
  authorize production changes.

### Bring the public pages in line with the Epicenter

- Desired result: Public pages describe Epicenter as where one
  person's software lives, as `README.md` and `docs/vision.md` now do, and
  no longer promise the retired Folder sync product.
- Grounding: On 2026-11-17, `apps/landing/src/pages/privacy.astro` and
  `terms.astro` still call Epicenter "local-first software". The blog posts
  `apps/landing/src/content/blog/launch.md` and
  `second-brain-infrastructure.md` describe the earlier product. The retired
  account website's plan comparison said "All plans include cloud sync,
  unlimited workspaces". On 2026-11-27, `apps/landing/src/pages/whispering.astro`
  still sells "system-global shortcuts in Epicenter", "AI Processing" with
  custom workflows, and a provider price table; the rewrite drops
  transformations and has one server setting plus the on-device engine. The front-door rewrite
  in `98a9930ac1` left these for a deliberate decision.
- Revisit when: Before the next public announcement or pricing change. Privacy
  and terms wording is a legal statement; change what it promises, not only its
  vocabulary. An old blog post may stay as dated history with a note.

### Finish the logging cleanup

- Desired result: A program has one place that writes its record and nothing
  else logs, as the [logging skill](.agents/skills/logging/SKILL.md) says.
- Grounding, on 2026-11-27: `packages/app` and `packages/ai` follow the rule.
  Whispering has no such place yet: see the rewrite entry. `reportError` in
  Bun reaches `uncaughtException` when a handler is installed and the process
  carries on. With none, Bun finishes the current turn and exits 1, so a
  program that uses shared code must install one; `bun test` fails the test
  that reported. In a webview it prints like any uncaught error.

### Triage the open pull requests against the current code

- Desired result: Each open pull request is merged, rebuilt, or closed with a
  note, and community ideas worth keeping survive the closing.
- Grounding: On 2026-11-17, 68 pull requests were open. A branch review found
  most of them change code that `main` no longer has (the retired Folder product
  and the old Whispering source). Six community Whispering pull requests hold
  ideas worth keeping or rebuilding, though their code is out of date: #2515
  (Silero VAD tuning in settings), #2486 (Linux Super-key shortcuts), #2475
  (working tray icon, menu-bar-only mode), #2495 (quick-release push-to-talk),
  #2453 (audio compression on by default), and #2314 (WebKit hardware
  acceleration off under remote displays). The current Whispering source does
  not mention push-to-talk, VAD, or compression.
- Revisit when: A Whispering pass, or before closing stale pull requests. Close
  nothing on the strength of this entry alone; a community pull request gets a
  comment that says what happened to its idea.
