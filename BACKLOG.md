# Backlog

Outcomes this repository still owes, and nothing else. A package's
not-yet-built list lives in its README; the owner's personal apps keep theirs
in their own Epicenter.

Recording an outcome does not schedule or authorize it. Remove an entry when
its outcome is done, keeping any unfinished scope. Before starting one, check
current code and dirty work: several chats share this checkout.

## Whispering

### Finish the Whispering rewrite

- Desired result: The rewrite on `claude/whispering-rebuild`
  ([#2774](https://github.com/EpicenterHQ/epicenter/pull/2774)) replaces the
  current app, and its pull request reads as Whispering edited in place.
- Order: internals on TanStack Query (largely done), then restore the user
  interface, then polish. Transformations do not return. Delete
  `apps/whispering-old` last, then open the pull request.
- Must still hold in the new app, each checked by hand: a failed connection or
  key save leaves one recoverable row; unsaved transcript edits survive a
  failed save; an interrupted native recording releases the microphone and
  `recover()` finishes it; on-device transcription explains what is missing;
  a recording shows where its audio and transcript live.
- Before `apps/whispering-old` is deleted, an audit on 2026-11-27 found these
  still point into it or describe the old app:
  - Packages the new app or the build still uses from
    `apps/whispering-old/packages/`: `recorder` and
    `tauri-plugin-epicenter-recorder` (the new app depends on both),
    `transcription` (the on-device engine), and `whispering-files`. Each
    needs a new home; `vite-config` has no users left.
  - Config that names the old folder: the workspace glob and the
    `whispering-old` scripts in `package.json`, the members in `Cargo.toml`,
    the `@source` line in `packages/ui/src/app.css`, and `ROOTS` in
    `scripts/check-boot-purity.ts`.
  - Skill examples that link files the rewrite removes: `typescript`
    (`references/editor-experience.md`, `references/type-organization.md`),
    `error-handling` (`references/error-variants.md`), `svelte` (`SKILL.md`,
    `references/component-ui-patterns.md`), and `tsconfig`.
  - `apps/whispering/README.md` on `main` describes the old app: a folder
    picker, `settings.md`, transformations that "wait for a later release",
    and hosted models that "come back". The rewrite's README replaces it,
    and `docs/vision.md` links its `#the-folder` heading.
- One place for failures: where every user action finishes, the app shows
  the message and records a line in a log file in its own folder (time,
  what was being done, the error's name and message; never transcript text
  or a key), capped in size. A window-level handler records failures that
  shared code hands up with `reportError`. Settings has a button to copy the
  file. Features and screens return errors and call neither `toast` nor a
  logger.
- Then: a command-line transcribe mode, so an app in an Epicenter can use
  Whispering as its transcription engine, as `apps/codex` uses Handy today.
  The shape, settled on 2026-11-27:
  - The installed desktop program has a headless mode with Handy's flags:
    `--transcribe-file <path>`, `--model <id>`, `--json`, and `--list-models`.
    It transcribes with the engine and selected model the app uses, prints
    `{ "text": ... }`, and exits. It records nothing, saves nothing, and
    opens no window.
  - It does more than Handy in two ways. It takes any audio the engine's
    decoder reads (WAV, MP3, AAC in MP4, Opus in WebM or Ogg), where Handy
    takes only 16 kHz mono WAV. It names what went wrong: no speech, a
    missing model, a file it cannot read. A caller needs no ffmpeg step, and
    `apps/codex` can switch with one setting.
  - Transcription is one Rust interface, audio in and text out, with two
    implementations: the bundled transcribe.cpp engine, and a request to an
    OpenAI-compatible server. Settings choose between them. The app calls
    the interface in memory and keeps an on-device model loaded; the command
    line calls it once. Neither calls the other.
  - A caller names the program by its full path. The installer puts nothing
    on `PATH`.
  - The app keeps its files in its own data directory and shows where they
    are. An Epicenter reaches Whispering one way: an action written with
    `defineAction` runs the command line.
  - The browser version has no command line.
  - Refused: a folder picker, which needs a setting, a missing-folder screen,
    and a rule for recordings already made; a background server for an
    Epicenter to call; recording from the command line.
  - Set aside, not refused: a Whispering app to copy into an Epicenter, and
    Whispering sending each finished recording to one.
  - Grounding: on 2026-11-27 the rewrite only calls a transcription server.
    The transcribe.cpp engine and the native recorder are packages under
    `apps/whispering-old/packages/`, and the new app already links the
    recorder from there. Both move out before `apps/whispering-old` is
    deleted.
  - Open: whether the command line reads `dictionary.txt` and the default
    model when no flag names them; whether it may use the server
    implementation or only the on-device one.

### Dictation into other apps

- Desired result: Start dictation from another app, see that it is working,
  and know whether the text reached its field; a failed delivery keeps the
  transcript. Later, a spoken instruction may revise selected text or use
  chosen screen content, always previewed before it acts.
- Revisit when: System-wide dictation becomes a milestone, after the rewrite.

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
