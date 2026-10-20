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

Reviewed against this checkout and the current chats on 2026-10-20. Finish the
shared Folder work, prove recovery, then establish browser sync behavior before
refining its internal API. Other product ideas below remain conditional.

| Stage | Outcome | Continuation and finish |
| --- | --- | --- |
| Underway | App roots install their typed context after Folder opens | “Compare editor lifecycle discussions”, `01a15876-f63d-7150-ba6a-75261008224a`. The provider component and setter prop trail are removed in current code; let this chat finish verification and settle the root API. |
| Underway | Honeycrisp shares whole-file save ownership | “Assess migration readiness”, `01a1591c-e525-7a03-9383-f126c140cef0`. Preserve body patches, rich-text editing, undo, and failed-input recovery while deleting its duplicate save loop. Leave the root API to its owner. |
| Underway, independent | Saved views and boards over the same folder and drafts | “Summarize app hosting vision”, `01a1589b-3f09-7b81-a529-44f8a37cd028`. Let that chat complete its existing implementation and acceptance. |
| Underway, independent | Settle native directory ownership | “Summarize Folder API demo”, `01a15760-42b7-76d2-8dc0-86c774ece1f1`. The shared opener is implemented; this chat is investigating attaching the directory to the window. Do not open another bindings-map rewrite. |
| Next | [Prove unfinished input survives failures and closing](#prove-unfinished-input-survives-failures-and-closing) | Recheck the editing changes above before starting; preserve any remaining recovery gap in their shared owner. |
| Before browser app sync | [Preserve local-only files during Git exchange](#preserve-local-only-files-during-git-exchange) and bound transfer costs | “Explain index CB and folder client”, `01a158ac-1ca5-75e2-94c2-4c220bd1eae8`, owns the current read-only design discussion. It is reconsidering publication rules and measuring representation costs; findings are not implementation assignments. |
| After sync behavior settles | [Make browser snapshot capture intent explicit](#make-browser-snapshot-capture-intent-explicit) | Derive the requests from the agreed read and sync behavior; avoid a parallel storage API rewrite. |
| Later, bounded cleanup | [Preserve operation types through CLI history replies](#preserve-operation-types-through-cli-history-replies) | Independent of app migration; preserve output and exit behavior. |

Resolve integration with `braden-w/data-folders` after the active changes settle,
as agreed in the browser chat. Preserve this branch's newer architecture and
intentional deletions; assess useful incoming fixes against current code.

## Folder correctness and transfer

### Prove unfinished input survives failures and closing

- Desired result: Newer typing remains accessible through save failures, note
  switches, representation changes, and window or page teardown.
- Current gap: [FolderContext](packages/svelte/src/folder-context.ts) logs a
  registered owner's rejected `settle()`. Its native close guard blocks, but
  `close()` builds copyable failures only from fulfilled owners' returned
  drafts before closing the handle. A throwing owner contributes no text to
  that report. This is a recovery gap to verify, not evidence that every native
  close loses input.
- Finish: Exercise a throwing file owner alongside successful and failed row
  saves, newer typing during a save, rich-text/source switching, and later
  recovery. Distinguish failed actions with no draft from unfinished text.
  Recheck Honeycrisp's active migration before changing the shared contract.
- Source: Archived chat `01a15623-1fc4-7f32-87f9-42e2ea1b4563` and the active
  migration chat named above.

### Preserve local-only files during Git exchange

- Desired result: Files excluded from publication remain on this device, never
  enter an outgoing snapshot, and survive remote adoption. Saved local content,
  exact uncertain sends, and acknowledged remote content retain distinct roles.
- Grounding: The browser review reproduced a pending commit containing
  `audio/take.wav` despite `local: ["audio/"]`. It used disposable storage and
  sent nothing. Native history has publication rules; the private browser sync
  does not yet enforce the same behavior. The public browser app does not
  invoke that sync trigger yet.
- Continuation: The browser chat is comparing declaration-based rules with
  `.gitignore` semantics. Settle the promise before choosing the representation;
  keep this outcome independent of the rule's spelling. Prove outgoing exclusion,
  incoming preservation, rule changes, and retry after an uncertain push.
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

### Apply repairability to file-authoritative workflows

- Desired result: Permit visible, repairable relationship inconsistencies while
  protecting source and unfinished input. [ADR-0503](docs/adr/0503-file-authoritative-workflows-preserve-information-and-tolerate-repairable-states.md)
  owns the criterion.
- Remaining decision: Honeycrisp's folder deletion still clears member notes'
  `folderId` values in [notes](apps/honeycrisp/src/lib/notes.svelte.ts). Compare
  preserving those references with the existing reassignment. Verify All Notes,
  missing-ID display, reassignment after reopening, and reuse of an ID before
  choosing the deletion behavior and updating its dialog.
- Revisit when: After the current Honeycrisp editing migration. Keep ordinary
  malformed-file repair and draft recovery in their existing owners; this item
  does not authorize a second editing-lifecycle refactor.

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
