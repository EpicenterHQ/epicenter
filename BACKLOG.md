# Backlog

## Conventions

Record wanted outcomes briefly. Recording an idea does not schedule or authorize
implementation. Keep an entry while its outcome is underway or paused; remove it
when complete, preserving any unfinished scope. Tests, READMEs, and decision
records own lasting decisions and completion evidence.

Before starting, check current code, dirty work, and the named continuation.
Several chats share this checkout. A backlog entry preserves an outcome; it does
not create a second implementation assignment.

## Current plan

Architecture entries reviewed against committed source on 2026-10-22; the
other chat continuations retain their recorded assignments. Folder-owned
sources, unconditional local publication, app migrations, Whispering app owner,
and the current Close/Quit policy have landed.
Their source, tests, READMEs and ADRs own the implementation and acceptance
evidence. Do not resume the obsolete createRowEdit/createTextEdit migration or
recreate a page action registry. Commit `bd78bfb52b` replaced guarded edit
conflicts and direct-write merging; Git sync and history retain content merging.

| State | Remaining outcome | Continuation |
| --- | --- | --- |
| Remaining verification | [Preserve newer input when an older save receipt arrives](#preserve-newer-input-when-an-older-save-receipt-arrives) | The earlier reproduction came from “Improve adversary skill conflict tri”, `01a15dd6-e3c3-7d31-8f48-2c38c97fa989`; “Tighten Markdown File Contracts”, `01a15d59-b44b-79d2-8f6d-58de231dc6fe`, holds the model discussion. The owner now acknowledges input by identity, with core regressions. Additional storage-engine and mounted coverage remains the bounded verification task. |
| Implementation under review | One Markdown interpretation and folder-owned sources | [ADR-0665](docs/adr/0665-a-markdown-file-without-frontmatter-has-empty-fields-and-a-body.md) records framing; the [Folder guide](packages/folder/README.md#editors) describes retained sources and unconditional local publication. The guarded-source proposal in ADR-0666 and the buffer interface in ADR-0667 are historical implementation context. No second editor owner is needed. |
| Underway | Messages draft previews and send recovery | “Rethink Epicenter’s content model”, `01a15c9c-a592-7b50-9ded-f8d4b9e0a5d7`, owns the Messages app integration. Keep checks on fictional data and preserve uncertain-send recovery. |
| Underway | Evaluate an unparented application Quit alert | “Review native save-close flow”, `01a15c9a-215d-7222-86b9-5e0f2670d9af`, owns the disposable native experiment and any authorized adoption. Keep startup and other work separate. |
| Remaining investigation | [Bound browser Git transfer costs](#preserve-local-only-files-during-git-exchange) | Preserve the delivered ignore and retry behavior; measure before replacing transport. |
| After transfer behavior settles | [Make browser snapshot capture intent explicit](#make-browser-snapshot-capture-intent-explicit) | Derive the request shape from actual read and sync callers. |
| Bounded future cleanup | [Preserve operation types through CLI history replies](#preserve-operation-types-through-cli-history-replies) | Keep output, validation and exit behavior. |

Resolve integration with `braden-w/data-folders` after active changes settle.
Preserve this branch's newer architecture and intentional deletions; assess
incoming fixes against current source. A backlog edit is not a message to
another chat and does not create an implementation assignment.

## Folder correctness and transfer

### Preserve newer input when an older save receipt arrives

- Desired result: A save acknowledges only the input it submitted. A later
  assignment remains pending even if its value equals an earlier submitted
  value. Failed input and typing during saves remain available.
- Earlier reproduction: Submit title A and delay its completion receipt. An outside
  writer stores B; this handle reads B and explicitly assigns A again. Deliver
  the old receipt. The owner before `bd78bfb52b` cleared the newer assignment
  by comparing values, and another explicit save did nothing.
- Delivered boundary: The owner acknowledges captured input by identity.
  [Editor tests](packages/folder/src/edits.test.ts) cover newer equal input,
  publication/delete ordering, failure/retry, and close. The earlier reproduction
  is historical evidence, not a claim that the replacement still has that bug.
- Remaining verification: Exercise this identity boundary through real storage
  and mounted controls, including newer equal input during publication,
  failure/retry, and close. Existing general storage and mounted tests do not
  establish that exact interleaving. Preserve unconditional local publication
  and the separate Git merge rules while extending coverage.

### Preserve local-only files during Git exchange

- Desired result: Files excluded from publication remain on this device, never
  enter an outgoing snapshot, and survive remote adoption. Saved local content,
  exact uncertain sends, and acknowledged remote content retain distinct roles.
- Delivered behavior: Ordinary .gitignore rules govern publication while
  remote adoption retains local-only files. Current Folder regressions cover
  ignored audio, authored rule changes, pending deletions and uncertain-send
  retries. Keep those guarantees; the former declaration-local-policy
  migration is no longer the next implementation step.
- Transfer cost: Measure a small edit against a large folder and long remote
  ancestry. The current adapter rebuilds temporary Git storage and may expand
  historical file contents. Keep ancestry evidence while avoiding unnecessary
  payload retention; establish peak-memory evidence before replacing transport.

### Make browser snapshot capture intent explicit

- Desired result: Callers state which files, rows, or sync inputs they need
  without implicit meanings of strings, arrays, and object shapes.
- Grounding: [Browser storage](packages/folder/src/browser/storage.ts) still
  accepts omitted scope, path arrays, prefix and row selectors, and `sync`.
  An empty array captures trees without file contents; omitted scope captures
  all files. Preserve a consistent IndexedDB transaction and the required
  checkpoints while simplifying this contract.
- Revisit when: The browser publication and receiving behavior above is settled.
  Source: archived chat `01a15623-1fc4-7f32-87f9-42e2ea1b4563`.

### Preserve operation types through CLI history replies

- Desired result: CLI handling retains the relationship between each history
  operation and its result, preserving output and exit codes.
- Grounding: [runHistory and historyExitCode](packages/folder/src/bun.ts) still
  exchange `HistoryReply<unknown>`. Review this contract with
  [its CLI caller](packages/cli/src/history-commands.ts), rather than replacing
  individual shape checks or weakening untrusted-input validation.
- Revisit when: Next CLI history API pass. Source: archived chat
  `01a15623-1fc4-7f32-87f9-42e2ea1b4563`.

### Prove a cross-device Folder journey

- Desired result: Open existing local files without sign-in, attach a chosen
  remote deliberately, and exchange edits with another device without moving
  or uploading data as a side effect of signing in. Distinguish saved locally,
  committed, and sent outcomes.
- Current basis: [Folder](packages/folder/README.md) opens locally; the
  [CLI](packages/cli/README.md) already implements authentication, repository
  listing, cloning, and native Git exchange. The browser has internal sync
  machinery, but persisted attachment and app scheduling remain unbuilt. The
  former account-folder pairing plan is not the current implementation plan.
- Finish: After the active browser decisions and integration settle, prove one
  designated two-device text-folder journey, including offline edits, concurrent
  changes, failed transfer, restart, and an existing folder gaining a remote.
  Verify the intended account and repository receive the transfer, and that
  redirects or credential helpers cannot send its credential elsewhere.
  Choose discovery and attachment from the current repository model. Do not
  restore account-scoped local storage or old OPFS paths to satisfy this item.
- Scope: Audio capacity and provider limits need separate evidence. No live
  account changes, deployment, or transfer of personal files is authorized here.

## Remaining app acceptance

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
- Historical evidence: `40cf833314` and archived implementation chat
  `01a0fd21-5251-7201-a40b-1aa104733d90`. Recheck current UI before reusing its
  older Home-layout patch; it is not an outstanding implementation requirement.

### Finish native capture interruption acceptance

- Desired result: A physical recording interrupted by window destruction or
  application exit releases the microphone, retains captured desktop audio,
  and permits another recording after reopening.
- Current basis: The [recorder](packages/recorder/README.md) streams desktop
  WAV files through Rust. Its plugin tests cover destroyed-window finalization
  and recovery. The former account-change restart scenario belongs to the
  deleted runtime.
- Remaining acceptance: With a real input device, exercise interruption,
  reacquisition, and recovery of the WAV header. Browser recording remains an
  in-memory capture until stop and has different interruption behavior.

### Complete Whispering's local transcription handoff

- Desired result: Select on-device transcription when available; otherwise
  explain what is missing and open Epicenter's model settings. Keep endpoint
  transcription available as an explicit alternative.
- Grounding: [Local transcription](apps/whispering/src/lib/workspace/local-transcription.ts)
  exposes readiness and sending, but the current Settings form does not offer
  that connection choice. The [Whispering README](apps/whispering/README.md)
  records the limitation.
- Revisit when: Next Whispering connection or first-run pass. Verify model
  selection, unavailable state, and a real transcription through the host.

### Show where Whispering keeps audio and resulting text

- Desired result: A person can locate the recording's audio and saved transcript
  or transformation, identify the endpoint and model used, and understand any
  deliberate handoff of text to another app.
- Grounding: Current recordings and transformations are folder files. The old
  Local/Personal split, automatic cleanup terminology, and Capture promotion
  plan do not describe current behavior.
- Revisit when: Next recording-results or file-navigation pass. Verify existing
  provenance and path displays before adding UI. Any Capture handoff needs an
  explicit destination and product decision; keep audio in its original folder.

## Conditional products and capabilities

### Reconsider Local Mail only as a deliberate product

- Desired result: If Mail returns, provide readable local mail, durable offline
  triage, and explicit write-back to the chosen provider.
- Grounding: Local Mail was deleted in `280bdf4d44`; no current Mail code exists
  to patch. Recover implementation evidence and the
  [transcript review](docs/transcript-reviews.md#mail-preserve-the-product-finish-execution)
  from history before choosing a new implementation.
- Retained acceptance: Reconnect wins over an older credential refresh; pending
  actions get delivery opportunities during downloads; throttling and retry
  waits are cancellable; restart retains progress and pending changes. Establish
  an explicit large-message limit or storage path without advancing past unsaved
  mail. Verify real sign-in, restart, offline triage, and provider-specific Undo
  with designated test messages.
- Optional follow-ups: Named saved views support ordinary triage actions;
  LLM cleanup previews exact messages before recoverable Trash; an Outlook-only
  journey precedes a combined inbox. These are conditional on choosing Mail,
  not separate current implementation assignments.

### Define Zhongwen's saved-word review loop

- Desired result: Save Chinese words, return through review, and retain learning
  progress in an independently maintained app.
- Grounding: Vocab already saves exact phrases and supports generated practice;
  that does not establish a review-history or scheduling product. Settle the
  first retrieval interaction before choosing a scheduler or schema.
- Distribution: If Zhongwen becomes the first external app, decide how a person
  obtains and opens it against today's packaging and licensing. Epicenter
  currently bundles known apps and has no arbitrary-app installer. The former
  prebuilt-release installer and Personal-store model are deleted; do not assume
  they must return or that an MIT dependency closure is available.
- Revisit when: Chinese study becomes the next product milestone.

### Make Whispering's dictation loop clear from speech to delivered text

- Desired result: Start dictation from another app, see capture and processing
  state, and know whether text reached the intended field or remains copyable.
  Failed delivery preserves the transcript.
- Current basis: Whispering records and transcribes in its own window. Its
  current implementation has no global dictation shortcuts, overlay, or automatic
  cursor delivery. This is a future product capability, not an acceptance pass
  over an existing delivery system.
- Revisit when: System-wide dictation is chosen as a product milestone. Define
  start, stop, delivery, and fallback first; make configured shortcuts visible
  where their actions appear. Onboarding, time-saved feedback, and optional
  gamification can follow evidence from that journey.

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

### Add TikTok Direct Post

- Desired result: Explicit approval of one post to a connected creator account
  produces at most one TikTok post.
- Grounding: Historical implementation and review corrections are preserved in
  `51335f22ec` on `codex/tiktok-direct-post`. They are evidence to reassess against
  the current publishing product, not current behavior.
- Revisit when: TikTok publishing becomes a priority and API access is available.

### Re-earn a headless Epicenter runner

- Desired result: Keep a chosen folder available for a concrete unattended
  workflow without requiring an open editor window.
- Current basis: The CLI can operate on directories and exchange Git history;
  it has no resident runner. The deleted `epicenter up` lifecycle is historical
  evidence for shutdown and process management, not an API to restore.
- Revisit when: A homelab, automation, or always-on workflow needs it. Decide
  which operation must stay live before introducing a daemon or watcher.

### Publish a deliberately selected file as a durable URL

- Desired result: An authenticated script or agent can explicitly publish a
  chosen local file and receive a durable URL.
- Current basis: CLI authentication already exists; do not rebuild a machine
  session for this outcome. The former blob-hosting API is deleted, and current
  recordings remain local files.
- Revisit when: A concrete publishing workflow needs this. Choose the storage,
  access, and retention contract before adding an upload command.

### Define user-controlled page types for a knowledge app

- Desired result: A knowledge app lets a page carry prose and user-defined typed
  fields, without forcing every page into a fixed worldview.
- Current basis: Folder already provides schema interpretation and Epicenter
  already reads and edits tables over Markdown. Reuse those capabilities; the
  deleted Wiki and Matter implementations are historical evidence only.
- Revisit when: A concrete knowledge workflow needs behavior beyond Files,
  Tables, and saved views. Decide that product behavior before adding a page
  type system. A tag does not need to become another page.

### Decide collaboration needs from a concrete shared-folder workflow

- Desired result: If collaboration is chosen, define membership, invitations,
  access, and data ownership for the people actually sharing files.
- Current basis: The old Skills app and sync laboratory were removed in
  `280bdf4d44`. Their deferred-purpose review is not a reason to restore them.
- Revisit when: A real shared workflow needs more than ordinary file or Git
  exchange. Keep this separate from local opening and app migration.

### Decide the identity model for a liked-music library

- Desired result: Show a liked recording once across services where appropriate,
  preserve each service link and source of the like, and group recordings under
  a song when useful.
- Grounding: Archived chat `01a0e883-3e17-7c80-baea-1b9944748d6d` distinguishes
  songs, recordings, and platform entries. It establishes neither matching
  coverage nor a commitment to build a music app.
- Revisit when: A music collection or multi-service import is chosen.

## Release and hosted operations

### Ship a trusted Epicenter macOS application

- Desired result: Distribute a Developer ID signed, notarized, and stapled DMG,
  including its bundled Bun sidecar, that passes Gatekeeper.
- Grounding: [Tauri configuration](apps/epicenter/src-tauri/tauri.conf.json)
  still uses ad hoc signing. Verify an actual distributed build before closing
  this item.
- Revisit when: Before distributing outside the development team.

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
- Grounding: Current registrations use `so.epicenter.cli` and `so.epicenter`.
  The old `epicenter-cli` row may survive in deployments that once seeded it;
  [registration](packages/server/src/auth/oauth-registrations.ts) updates known
  clients but does not remove all unknown rows. No deployed inventory was read
  during this backlog review, so existence is unverified.
- Revisit when: Next production registration audit. Inspect exact rows and
  historical redirects before disabling obsolete clients; keep legitimate
  external registrations. This entry does not authorize production changes.

### Reconcile metadata for retired published package versions

- Desired result: Published legacy versions explain their status without
  breaking existing installs or mislabeling packages restored in this repo.
- Grounding: The earlier retirement list included `@epicenter/workspace`,
  `@epicenter/filesystem`, and `@epicenter/cli`. CLI source exists again. Check
  current registry metadata and intended version ranges before proposing any
  deprecation; preserve the license of each previously published version.
- Revisit when: Next package release. Do not unpublish or deprecate a whole
  package name merely because an earlier implementation was deleted.
