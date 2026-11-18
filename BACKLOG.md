# Backlog

## Conventions

Record wanted outcomes briefly. Recording an idea does not schedule or authorize
implementation. Keep an entry while its outcome is underway or paused; remove it
when complete, preserving any unfinished scope. Tests, READMEs, and decision
records own lasting decisions and completion evidence.

Before starting, check current code, dirty work, and the named continuation.
Several chats share this checkout. A backlog entry preserves an outcome; it does
not create a second implementation assignment.

## Whispering acceptance

### Keep AI connection rows and machine keys consistent

- Desired result: Sending, adding, removing, or failing to read one connection
  leaves an understandable and recoverable state on this machine.
- Current basis: The [Whispering README](apps/whispering/README.md) says a
  request is refused, with nothing sent, if its connection was removed. Keys
  live in the site's `connection-keys.json` on the web and in `credentials.json`
  on the desktop.
- Remaining recovery: Keep one attempted connection ID through a failed Add/key
  save, so retry does not create another row. Show a safe keychain failure
  message instead of external store error text. Resolve Whispering's
  transcription and text connections independently when one read fails.
- Scope: Provider responses are forwarded as received, so a provider echoing
  request credentials is a separate trust-contract question, not proof that the
  local key store leaks them.

### Verify Whispering's recordings table and detail pane

- Desired result: Search, sort, selection, bulk actions, playback, and transcript
  editing work together on desktop and narrow screens.
- Current basis: [RecordingList](apps/whispering/src/routes/components/RecordingList.svelte)
  and [RecordingDetail](apps/whispering/src/routes/components/RecordingDetail.svelte)
  implement the table and optional detail pane. Do not rebuild them.
- Remaining acceptance: Use disposable recordings. Verify matching excerpts,
  operations on selected visible rows, playback while editing, retained drafts,
  keyboard focus, and detail navigation at 320 and 390 pixels. Exercise bulk
  transcription with a test endpoint and verify skips, failures, and saved
  results. Automated tests do not establish visual or listening behavior.

### Finish native capture interruption acceptance

- Desired result: A physical recording interrupted by window destruction or
  application exit releases the microphone, retains captured desktop audio,
  and permits another recording after reopening.
- Current basis: The [recorder](packages/recorder/README.md) writes desktop
  audio as Opus in WebM from the first sample, and `recover()` finishes
  recordings a quit or crash cut off.
- Remaining acceptance: With a real input device, exercise interruption,
  reacquisition, and `recover()`. Browser recording remains an in-memory
  capture until stop and has different interruption behavior.

### Complete Whispering's local transcription handoff

- Desired result: Select on-device transcription when available; otherwise
  explain what is missing and open the model settings. Keep endpoint
  transcription available as an explicit alternative.
- Grounding: [SpeechSettings](apps/whispering/src/lib/components/SpeechSettings.svelte)
  offers on-device models under **On this computer**. The web build has no
  local transcription.
- Revisit when: Next Whispering connection or first-run pass. Verify model
  selection, unavailable state, and a real transcription through the host.
- Older cache review: The resolver trusts Hugging Face cache layout rather than
  hashing cached bytes. Preserve that narrowed claim and provide a repair path
  for a damaged existing file. Direct shared-cache cleanup through Hugging
  Face's cache tools rather than suggesting deletion of a folder other
  applications may use.

### Show where Whispering keeps audio and resulting text, in the app

- Desired result: From a recording, a person can open its audio and saved
  transcript or transformation, and see the endpoint and model used, without
  reading the README.
- Grounding: The [Whispering README](apps/whispering/README.md) documents where
  files live, and each transcript records its model and endpoint. The app does
  not show either.
- Revisit when: Next recording-results pass. Any handoff of text to another app
  needs an explicit destination and product decision.

## Conditional products and capabilities

### Define Zhongwen's saved-word review loop

- Desired result: Save Chinese words, return through review, and retain learning
  progress in an independently maintained app.
- Grounding: Vocab, an app in the home, saves exact phrases and supports
  generated practice; that does not establish a review-history or scheduling
  product. Settle the first retrieval interaction before choosing a scheduler or
  schema.
- Distribution: A person gets an app by copying its code into their home with
  `epicenter new` ([ADR-0929](docs/adr/0929-new-copies-an-apps-code-from-a-folder-in-git-or-a-folder-on-github.md)).
- Revisit when: Chinese study becomes the next product milestone.

### Make Whispering's dictation loop clear from speech to delivered text

- Desired result: Start dictation from another app, see capture and processing
  state, and know whether text reached the intended field or remains copyable.
  Failed delivery preserves the transcript.
- Current basis: The desktop app has one global shortcut, `toggleRecording`
  ([Whispering README](apps/whispering/README.md)). It has no overlay and no
  automatic delivery into another app's field.
- Revisit when: System-wide dictation is chosen as a product milestone. Define
  start, stop, delivery, and fallback first. Onboarding and time-saved feedback
  can follow evidence from that journey.

### Let a spoken instruction revise selected text

- Desired result: Select text in another app, speak a change, review the result,
  and leave the original untouched until accepting it. Ordinary dictation keeps
  its predictable behavior.
- Revisit when: Basic dictation and delivery work. Settle whether this action
  belongs in Whispering before extending its current prompt transformations.

### Let a person deliberately use screen content with speech

- Desired result: Choose visible text or a screen region, speak a request, and
  see both the supplied context and intended destination before acting.
- Revisit when: A concrete task needs context that selected text or a saved
  dictionary cannot provide. Text-assisted spelling and image-based questions
  are different needs; choose the one the task establishes.

### Decide what sharing with another person means for a home

- Desired result: If sharing is chosen, define who can see or change which
  records, how they are invited, and whose home owns the data.
- Current basis: A home is one private Git repository per person
  ([ADR-0910](docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md)).
  The Folder sync product that framed earlier collaboration plans is retired
  ([ADR-0899](docs/adr/0899-the-folder-sync-product-is-retired.md)).
- Revisit when: A real case of two people sharing data needs more than one
  person's home.

### Track photographs used in Vault publications

- Desired result: Each publication records the photographs it uses, so the
  person and their agents can find the photos in a publication, the publications
  using a photo, and unused photos within a chosen trip, date range, or topic.
- Grounding: [Model photo identity and lineage from Google Takeout](thread://019f779e-59f7-7bc0-a101-b1b4ee603f54?hostId=local)
  ends with this request. The Vault repository's own ADR-0290 (not this
  repository's) records asset-use tracking as unimplemented. Keep durable use
  references in authored Vault or publication records; the ignored SQLite
  catalog may index them, but cannot be their only home. Settle how Google
  items, Takeout occurrences, selected downloads, and publication derivatives
  relate without assuming a filename, thumbnail, or matching bytes establishes
  one logical photo. Preserve uncertain matches.
- Revisit when: Connecting photo selection to a real Vault page or video.
  [This Google Photos import chat](thread://01a1e0a7-325a-7cb2-97ea-40a645f185f7?hostId=local)
  continues the import into `~/Epicenter`; do not revive superseded command,
  Markdown-catalog, or storage proposals from the source chat automatically.

### Complete or deliberately defer an independent Google Photos backup

- Desired result: Establish what original media is independently preserved,
  then decide whether, where, and how to finish a verified full-library backup.
- Grounding: [Resume Photos Takeout and clean abandoned downloads](thread://019fa077-33f0-7d33-9e47-5c1ead825abc?hostId=local)
  reported in July 2026 that only parts 1 through 6 of a 32-part, approximately 1.54 TB
  export completed on a 1 TB Crucial X8. It reported moving 41 older partial
  downloads to that drive's Trash without emptying it. These are historical
  observations, not the drive's current inventory. [Explain Google Photos Takeout size](thread://019f77dc-273f-78a1-8d7c-71bc0bebf79e?hostId=local)
  supplies export-size context; the Vault repository's ADR-0261 preserves the
  remote-retention proposal, not evidence of a completed backup.
- Revisit when: Choosing to retain originals independently of Google Photos.
  Inspect surviving downloads, integrity, available storage, and Trash before
  deciding the destination or remaining import work. Preserve existing sources;
  deletion or quality reduction is a separate decision. A metadata/thumbnail
  cache does not establish a backup of originals. Continue coordination in
  [this Google Photos import chat](thread://01a1e0a7-325a-7cb2-97ea-40a645f185f7?hostId=local).

### Decide the identity model for a liked-music library

- Desired result: Show a liked recording once across services where appropriate,
  preserve each service link and source of the like, and group recordings under
  a song when useful.
- Grounding: Archived chat `01a0e883-3e17-7c80-baea-1b9944748d6d` distinguishes
  songs, recordings, and platform entries. It establishes neither matching
  coverage nor a commitment to build a music app.
- Revisit when: A music collection or multi-service import is chosen.

## Release and hosted operations

### Establish hosted erasure before external onboarding

- Desired result: Attribute hosted allocations to their account and verify an
  operator procedure that retires access and removes owned application data.
- Grounding: [Auth configuration](packages/server/src/auth/base-config.ts)
  still refuses account deletion before destructive work. Reinventory current
  allocations; the [account notes](apps/api/worker/account/README.md) include
  historical storage owners and do not establish the live deployment's state.
- Revisit when: Before external onboarding. Automated retries and self-service
  deletion require their own product need. Offline copies, backups, logs, and
  provider retention need explicit limits.

### Make Sign in with Apple a supported product path

- Desired result: Offer Apple on supported sign-in and account-linking surfaces.
- Grounding: Server configuration supports Apple, but the
  [UI provider list](apps/api/ui/src/lib/auth/providers.ts) exposes only Google,
  GitHub, and Microsoft.
- Revisit when: Next provider or linking pass; verify the complete sign-in flow.

### Reconcile obsolete OAuth registrations in deployed databases

- Desired result: Old clients and redirects no longer authorize grants, while
  the current CLI and desktop registrations remain functional.
- Grounding: [The registrations](apps/api/worker/oauth-registrations.ts)
  declare the clients, and [registration](packages/server/src/auth/oauth-registrations.ts)
  writes them to the database; it updates known clients but does not remove
  unknown rows. The old `epicenter-cli` row may survive in deployments that once
  seeded it. `so.epicenter` (the deleted desktop app), `so.epicenter.todos`, and
  `so.epicenter.capture` belong to apps no longer in this repository and may
  now be obsolete too. No deployed inventory was read, so existence is
  unverified.
- Revisit when: Next production registration audit. Inspect exact rows and
  historical redirects before disabling obsolete clients; keep legitimate
  external registrations. This entry does not authorize production changes.

### Reconcile metadata for retired published package versions

- Desired result: Published legacy versions explain their status without
  breaking existing installs or mislabeling packages restored in this repo.
- Grounding: The earlier retirement list included `@epicenter/workspace`,
  `@epicenter/filesystem`, and `@epicenter/cli`. `@epicenter/cli` and
  `@epicenter/app` are published again; `@epicenter/folder` is private now, and
  whether it was ever published is unchecked. Check current registry metadata
  and intended version ranges before proposing any deprecation; preserve the
  license of each previously published version.
- Revisit when: Next package release. Do not unpublish or deprecate a whole
  package name merely because an earlier implementation was deleted.

## Repository upkeep

### Bring the public pages in line with the home

- Desired result: Public pages describe Epicenter as the home where one
  person's software lives, as `README.md` and `docs/positioning.md` now do, and
  no longer promise the retired Folder sync product.
- Grounding: On 2026-11-17, `apps/landing/src/pages/privacy.astro` and
  `terms.astro` still call Epicenter "local-first software". The blog posts
  `apps/landing/src/content/blog/launch.md` and
  `second-brain-infrastructure.md` describe the earlier product. The plan
  comparison in `apps/api/ui/src/lib/components/PlanComparison.svelte` says
  "All plans include cloud sync, unlimited workspaces". The front-door rewrite
  in `98a9930ac1` left these for a deliberate decision.
- Revisit when: Before the next public announcement or pricing change. Privacy
  and terms wording is a legal statement; change what it promises, not only its
  vocabulary. An old blog post may stay as dated history with a note.

### Finish the logging cleanup the logging skill describes

- Desired result: No package builds an error only to log it, and the hosted API
  writes one record per request the way `epicenter serve` writes one per action
  run.
- Grounding: The [logging skill](.agents/skills/logging/SKILL.md) forbids a
  `new Error` at a log call site, yet six subscriber loops still do it:
  `packages/ai/src/open-ai.ts`, `packages/ai/src/local-servers.ts`,
  `packages/ai/src/agent/loop.ts`, and in the retired Folder package
  `packages/folder/src/folder.ts` (two) and `note-edit.ts`. The six are the
  same catch-and-log loop copied; one shared helper may replace them. The
  skill names one hosted API request as a unit of work, but no per-request
  record exists.
- Revisit when: The next logging pass. Before the hosted API record, check how
  Cloudflare Workers keep and query logs. The Folder sites go away with that
  package rather than being fixed.

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

## After 0.7.0

### Ship a new Epicenter's starter files as a template

- Desired result: `epicenter init` copies a `template/` folder that
  `@epicenter/cli` ships, instead of writing file contents held in TypeScript
  strings. Doc text in those strings has drifted from the code before.
- Grounding: [`init.ts`](packages/cli/src/init.ts) holds `STARTER_AGENTS`, the
  checkpoint routine and script, `.gitignore`, and `package.json` as literals.
  Keep init's logic: the nested-home refusal, the Git identity check, adopting
  an existing folder, and version pinning. Stop turning on Git LFS whenever
  `git-lfs` is installed (`init.ts:297`).
- Revisit when: After 0.7.0. Decide whether `init` becomes `bun create` together
  with the postponed one-package question.

### Report nested repositories from Git instead of walking folders

- Desired result: The backup report keeps its status (last commit, uncommitted
  files, commits not yet pushed) and finds nested repositories without its own
  folder walk.
- Grounding: `nestedRepositories` in
  [`repository.ts`](packages/cli/src/repository.ts) walks `apps/` for `.git`.
  `git status --porcelain -uall` already reports them, and it skips ignored
  folders, so it also ends a false warning about a `.git` under an app's
  ignored `local/`. The status fields stay: they are the only visible sign that
  checkpointing failed.
- Revisit when: After 0.7.0.

### Revisit the rules for absent switches and lists

- Desired result: Decide whether an absent switch should still read as `false`
  and an absent list as `[]`, or whether code should see what the file holds.
- Grounding: `absentValue` in [`field.ts`](packages/app/src/field.ts) and the
  `x-epicenter-field` marker supply those values. Removing them means
  migrating the home's apps that read lists directly, including Capture's page
  and Mail's `proposals.ts`. The two create paths also disagree: the generated
  `create` action writes `false` and `[]` into the file, while
  `handle.create(id, {})` leaves them out (`packages/app/src/data.actions.test.ts`).
- Revisit when: After 0.7.0.
