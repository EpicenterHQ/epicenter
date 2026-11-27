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
- Then: a command-line transcribe mode, so an app in an Epicenter can use
  Whispering as its transcription engine, as `apps/codex` uses Handy today.
  The shape, settled on 2026-11-27:
  - The installed desktop program, run with
    `--transcribe-file <wav> --model <name> --json`, prints `{ "text": ... }`
    and exits. It answers the call `apps/codex` makes to Handy, so switching
    is one setting. It records nothing, saves nothing, and opens no window.
  - One Rust engine wraps transcribe.cpp. The app calls it in memory and
    keeps the model loaded; the command line calls it once. Neither calls the
    other.
  - A caller names the program by its full path. The installer puts nothing
    on `PATH`.
  - The app keeps its files in one folder the person picks. The picker takes
    any folder and never mentions Epicenter; an Epicenter's own docs say to
    choose `~/Epicenter/data/whispering`.
  - The browser version gets neither the command line nor the folder choice.
  - Refused: a background server for an Epicenter to call, a Whispering app
    inside an Epicenter, and recording from the command line.
  - Open: whether the command line reads the folder's dictionary and default
    model when no flag names them; whether the rewrite already has an
    on-device engine; whether a data key can sit at
    `data/whispering/recordings`.

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
  unlimited workspaces". The front-door rewrite
  in `98a9930ac1` left these for a deliberate decision.
- Revisit when: Before the next public announcement or pricing change. Privacy
  and terms wording is a legal statement; change what it promises, not only its
  vocabulary. An old blog post may stay as dated history with a note.

### Finish the logging cleanup

- Desired result: No package builds an error only to log it, as the
  [logging skill](.agents/skills/logging/SKILL.md) requires.
- Grounding: Two sites remain, the same catch-and-log loop in
  `packages/ai/src/open-ai.ts` and `packages/ai/src/local-servers.ts`.

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
