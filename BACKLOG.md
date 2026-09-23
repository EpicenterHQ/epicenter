# Backlog

## Conventions

Record wanted outcomes briefly and keep related items together when useful.
Use an outcome heading with a desired result; add grounding or a revisit
condition only when it helps someone resume the work. A backlog item can be a
change, investigation, or decision. Recording an idea does not schedule or
authorize implementation.

Keep entries while work is underway or paused. Remove an entry on completion,
preserving any unfinished scope. Remove its execution-order row too, if it has
one. Record lasting decisions and completion evidence in the owning tests,
README, or decision record.

## Execution order after the transcript review

This is the entry point for the surviving transcript work. Detailed evidence
stays in the [review](docs/transcript-reviews.md#eight-export-review-2026-09-20)
and existing plans. The older backlog below remains conditional work, not an
instruction to execute every item in file order.

| Order | Session-sized outcome | Finish or boundary |
| --- | --- | --- |
| 1 | [Prevent Mail refresh from overwriting a reconnect](#prevent-mail-refresh-from-overwriting-a-reconnect) | Regression for a paused refresh crossing reconnect; new credentials and access remain authoritative. |
| 2 | [Finish bounded, cancellable Mail sync](#finish-bounded-cancellable-local-mail-synchronization) | Shared pacing/cooldown, delivery between pages, cancellable requests/waits, durable resume. Preserve the existing storage edits. |
| 3 | [Complete Mail acceptance and remaining edge cases](#complete-mail-acceptance-and-triage-edge-cases) | Review the large-message limit separately; prove desktop restart, offline triage, and delivery with designated test data. |
| 4 | [Let signed-in Local open without Personal](#let-signed-in-local-open-without-bootstrapping-personal) | Browser reproduction and a coherent readiness contract that preserves account identity. |
| Independent | [Repair Vocab candidate extraction](#preserve-verbatim-vocab-candidates) | Legitimate punctuation survives; candidates are validated against their source. |
| Independent | [Finish the bounded test/API cleanup](#finish-the-bounded-test-and-api-cleanup) | Retire obsolete contracts together with their tests; preserve actual lifecycle and data-isolation evidence. Coordinate any StoreBacking changes with step 4. |
| Hardware-dependent | [Finish native capture acceptance](#finish-native-capture-interruption-acceptance) | Actual microphone interruption, release, and reacquisition. |
| Product judgment | [Zhongwen](#define-zhongwens-saved-word-review-loop-and-repository-placement) and [deferred capability choices](#resolve-deferred-capability-purpose-only-when-needed) | Settle the intended product before implementing or deleting capabilities. |

Use one session per outcome. Recheck current source and dirty work before
starting: a prior session may already have completed it.

## Complete Mail acceptance and triage edge cases

- Desired result: Desktop sign-in and Gmail consent lead to readable local mail;
  a complete restart retains credentials and cache; offline triage reaches
  Gmail after reconnecting. Undo preserves the state preceding a real action.
- Grounding: The [Mail evidence notes](apps/local-mail/evidence/README.md)
  separate synthetic checks from the remaining live journey. The later
  [product-review extraction](docs/transcript-reviews.md#extracted-from-codex-session-01a0ba84)
  flags Undo after trashing an already-trashed message: verify the current path,
  then prevent a no-op from offering a destructive inverse. This later finding
  was not reproduced by the eight-export review.
- Revisit when: After the sync changes. Handle the
  [individual-message limit](#resolve-local-mails-oversized-individual-message-limit)
  as its own supported-behavior decision. Select a test message and permitted
  label change before any live write-back; synthetic evidence alone does not
  complete acceptance.

## Finish the bounded test and API cleanup

- Desired result: Remove obsolete production contracts and misleading tests
  while preserving real data isolation, retirement, rollback, and disposal.
- Grounding: The [current corrections](docs/transcript-reviews.md#testapi-audit-what-remains-actionable)
  supersede the dated audit's bootstrap and auth-restoration advice. Candidates
  include static-token tooling, the returned SQL drain phase, initialization
  and passkey prototypes, artificial Account-replacement cases, and source
  spelling checks. Recording disposal assertions need repair. Replicated
  StoreBacking must require invalidation before its legacy case can go.
- Revisit when: A focused cleanup session can recheck callers and preserve the
  stronger replacement evidence. Whispering's explicit-owner work is already
  implemented; do not repeat it. The Worker `pg-protocol` alias needs a verified
  removal condition, not deletion merely because it is a workaround.

## Preserve verbatim Vocab candidates

- Desired result: Suggested saved spans preserve legitimate punctuation and
  match the source passage before the person chooses to save them.
- Grounding: The current parser reproduced `Yes: absolutely` becoming `Yes`,
  `wait - what` becoming `wait`, and `say:` disappearing. Its tests currently
  reward guessing that punctuation introduces a gloss. See the
  [review](docs/transcript-reviews.md#testapi-audit-what-remains-actionable).
- Revisit when: Next Vocab correctness pass. Change parsing, its source-aware
  caller, and regression coverage together; existing saved entries need no
  inferred migration. This is separate from designing Zhongwen's review loop.

## Finish native capture interruption acceptance

- Desired result: Physical recording interrupted by account-change restart
  releases the microphone and staging resources; a reopened app can record
  again while previously saved audio survives.
- Grounding: The [runtime lifetime plan](specs/20260919T090341-runtime-lifetime-collapse.md)
  retains this gate. Previous attempts failed before acquisition because macOS
  exposed no input device. Synthetic capture and restart evidence are recorded
  there but do not prove physical capture interruption.
- Revisit when: A working input device is available. Finish the maintained
  probe and acceptance evidence, then retire the spent spec.

## Resolve deferred capability purpose only when needed

- Desired result: Give an explicit product owner to any capability we choose
  to develop or retire: the unconsumed working-copy engine, Skills/chat surfaces,
  and future team collections.
- Grounding: The [review](docs/transcript-reviews.md#product-choices-and-acceptance-to-preserve)
  preserves these open choices. Tests/benchmarks alone do not establish a
  working-copy product, but they also do not authorize its deletion. Removing
  server-wide Shared did not implement team membership or invitations.
- Revisit when: A concrete user workflow needs one of these capabilities.
  These are deferred decisions, not prerequisites for Mail or Local readiness.

## Finish bounded, cancellable Local Mail synchronization

- Desired result: Each Gmail account paces requests and shares cooldowns;
  reconciliation gives pending changes a delivery opportunity between download
  pages. Cancellation reaches network requests and retry waits. Reopening
  retains pending changes and download progress.
- Grounding: The [2026-09-20 transcript review](docs/transcript-reviews.md#mail-preserve-the-product-finish-execution)
  verifies that full pulls still monopolize a pass and requests retry
  independently. The user retained formatted mail, local reads, and durable
  write-back. Bounded concurrency remains a measurement choice.
- Revisit when: Next Local Mail implementation pass. Verify coordinated
  throttling, archive delivery during download, cancellation, and reopen, then
  finish the designated live Gmail journey.

## Prevent Mail refresh from overwriting a reconnect

- Desired result: A refresh begun before reconnect cannot replace the newly
  connected credential or continue using stale cached access afterward.
- Grounding: A synthetic probe on 2026-09-20 paused the production token
  manager's refresh, wrote a reconnect credential, then released the response.
  The older rotated credential overwrote the reconnect. `withAccount` tracks
  work for removal but does not serialize these credential writes. See the
  [source-grounded review](docs/transcript-reviews.md#mail-preserve-the-product-finish-execution).
- Revisit when: Next Mail credential or synchronization change. Cover the
  reconnect/refresh interleaving and removal while work is admitted.

## Resolve Local Mail's oversized individual-message limit

- Desired result: A large individual message has an explicit supported storage
  path or a deliberate product limit without silently weakening SQLite batch
  atomicity or advancing a checkpoint past unsaved mail.
- Grounding: The uncommitted page-chunking repair handles large pages but
  rejects any one serialized statement above 4 MiB. See
  [mailbox.ts](apps/local-mail/src/mailbox.ts) and the
  [review](docs/transcript-reviews.md#mail-preserve-the-product-finish-execution).
- Revisit when: Completing large-mailbox acceptance or encountering a refused
  individual message. Page chunking alone does not finish this work.

## Let signed-in Local open without bootstrapping Personal

- Desired result: Local use keeps its captured account identity and account
  capabilities while an uncached, offline Personal store is unavailable.
- Grounding: On 2026-09-20 the real `openApp` with a memory runtime acquired
  Device successfully, failed Personal, and rejected the whole App. Signed-out
  opening succeeded. [The opener](packages/app/src/open.ts) waits for both.
- Revisit when: Next App readiness change. First reproduce the signed-in Local
  browser journey; do not work around it by dropping the Account and selecting
  someone else's storage namespace.

## Define Zhongwen's saved-word review loop and repository placement

- Desired result: A broader Chinese study app where someone saves words,
  returns to them through review, and retains progress.
- Grounding: The later product conversation explicitly requested saved words
  and review. The earlier “Zhongwen should be personal GitHub” correction remains
  unresolved. Vocab implements saved entries and generated practice, but that
  does not establish a review-history/scheduling product. The
  [transcript review](docs/transcript-reviews.md#product-choices-and-acceptance-to-preserve)
  preserves both directions.
- Revisit when: Chinese study work becomes the next product milestone. Settle
  repository ownership and the first retrieval interaction before choosing a
  scheduler, changing the schema, or adding Vocab to desktop builds.

## Establish hosted erasure before external onboarding

- Desired result: Attribute every hosted allocation to its account and locally
  verify an operator-run procedure that retires access and removes owned data.
- Grounding: Account deletion currently refuses before destructive work. Empty
  API namespaces were observed on 2026-09-08, but complete allocation ownership
  and an operator deletion procedure remain unbuilt. See
  [ADR-0360](docs/adr/0360-defer-automated-hosted-account-deletion.md).
- Revisit when: Preparing to onboard external users. Automated retries and a
  self-service endpoint stay deferred until the product needs them or operator
  deletion becomes recurring work. Self-hosted reset is outside this scope.

## Make Sign in with Apple a supported product path

- Desired result: Expose and support Sign in with Apple wherever Epicenter
  presents its supported account sign-in and linking providers.
- Grounding: The server already contains optional Apple provider configuration,
  but the current product UI has no corresponding entry point.
- Revisit when: Epicenter next changes authentication providers or account
  linking.

## Add human-reviewed LLM cleanup to Local Mail

- Desired result: Let an LLM propose precise groups of low-value Gmail messages,
  require review of the exact messages, and move only the approved batch to
  recoverable Gmail Trash.
- Grounding: Local Mail already treats Gmail as the source of truth and requires
  human-meaningful state to round-trip through Gmail.
- Revisit when: Local Mail next expands its triage or agent-assisted workflows.

## Add Outlook as a standalone Local Mail provider

- Desired result: Support one Outlook account and an Outlook-only inbox through
  Microsoft Graph before introducing a combined Gmail and Outlook inbox.
- Grounding: Keep provider identity explicit and provider storage and actions
  separate so a combined inbox remains possible without forcing either provider
  into the other's model.
- Revisit when: Local Mail next expands beyond Gmail.

## Add TikTok Direct Post

- Desired result: Let a signed-in Epicenter user connect TikTok creator
  accounts as publishing destinations and make one explicit post consent create
  at most one TikTok post.
- Grounding: The unmerged implementation and its review corrections are
  preserved at
  [commit 51335f22ec](https://github.com/EpicenterHQ/epicenter/commit/51335f22ec188c8fb1d4903d3d40ef2cd936cf0f)
  on `codex/tiktok-direct-post`; treat it as implementation evidence to port
  onto future `main`, not as current product behavior.
- Revisit when: TikTok publishing becomes a product priority and Epicenter is
  ready to support TikTok's API access and compliance obligations.

## Complete Whispering's local transcription handoff

- Desired result: When local transcription is unavailable, explain the
  on-device path, open Epicenter Home to choose or download a model, offer cloud
  transcription as the secondary path, and show the normal recorder once ready.
- Grounding: Epicenter Home already owns local model administration under
  [ADR-0180](docs/adr/0180-epicenter-has-one-host-owned-active-local-transcription-model.md);
  Whispering already receives derived readiness and a focused Home navigation
  action under
  [ADR-0181](docs/adr/0181-every-app-receives-one-portable-epicenter-capability-handle.md).
- Revisit when: Whispering's first-run or unavailable-transcription surface is
  next changed.

## Make Whispering's dictation loop clear from speech to delivered text

- Desired result: A person can start dictation from another app, see whether
  Whispering is listening and processing, and tell when text reached the intended
  field or stayed available for copying. A failed delivery does not lose the
  transcript.
- Grounding: [FluidVoice](https://github.com/altic-dev/FluidVoice) describes a
  live preview and direct insertion; [FreeFlow](https://github.com/zachlatta/freeflow)
  emphasizes its hold-to-talk and toggle flow. Compare the whole journey in
  Whispering before choosing an overlay or shortcut change. Whispering already
  has global shortcuts, a recording overlay, and cursor delivery with a
  clipboard fallback.
- Revisit when: Whispering's recording overlay, shortcuts, or text delivery is
  next designed as a user workflow.

## Let a spoken instruction revise selected text

- Desired result: A person selects text in another app, speaks a one-off change
  such as "make this shorter," reviews the result, and can leave the original
  untouched. Ordinary dictation remains predictable when no edit was requested.
- Grounding: [FluidVoice Write Mode](https://github.com/altic-dev/FluidVoice)
  and [FreeFlow Edit Mode](https://github.com/zachlatta/freeflow) describe this
  interaction. Whispering's Recipes already reshape a selection with a saved
  instruction; this item is about speaking the instruction for that selection.
  The draft [voice-cursor exploration](apps/whispering/specs/20260628T003033-voice-cursor-intent-in-context.md)
  contains earlier research, not a settled implementation plan.
- Revisit when: The basic dictation and delivery journey is sound enough to
  judge a second spoken action.

## Let a person deliberately use screen content with speech

- Desired result: A person chooses visible content, such as a captured screen
  region, and speaks a request about it. Whispering shows what was captured and
  where the resulting text will go before acting on it.
- Grounding: [VoiceInk](https://github.com/Beingpax/VoiceInk) describes adapting
  to screen content, and [FreeFlow](https://github.com/zachlatta/freeflow)
  describes nearby app context for correcting names. These are different uses:
  text context may help spell dictated words, while an image can support a
  request about visual content. Compare them against a concrete user task before
  choosing screenshot capture, text extraction, or both. Whispering has no
  general screen-context capture path today.
- Revisit when: A concrete dictation or "speak about this screen" journey needs
  context that the person's saved Dictionary and selected text cannot provide.

## Show where Whispering keeps audio and transcripts after dictation

- Desired result: After speaking, a person can find the saved audio and text,
  see whether they are in Local or Personal, and understand whether a chosen
  transcription or Polish provider received them.
- Grounding: Whispering saves capture in Local, supports an explicit copy to
  Personal, and sends audio or text to selected providers when those steps need
  inference. The [app README](apps/whispering/README.md) describes these data
  boundaries; the interface should make the relevant outcome clear in the
  recording journey.
- Revisit when: Whispering's recording results, history, or Personal save flow
  is next changed.

## Explore Wispr Flow for Whispering onboarding and gamification

- Desired result: Improve Whispering's onboarding and explore gamification
  that shows how many hours a person has saved by dictating.
- Grounding: Review Wispr Flow for inspiration for both onboarding and
  dictation progress feedback.
- Revisit when: Whispering's onboarding or usage statistics are next changed.

## Show saved shortcuts in Whispering button tooltips

- Desired result: Hovering over a button reveals its saved keyboard shortcuts
  in a tooltip.
- Grounding: Make configured shortcuts discoverable where their actions live.
- Revisit when: Whispering's buttons or shortcut discoverability are next changed.

## Ship a trusted Epicenter macOS application

- Desired result: Publish an Epicenter DMG whose application and bundled Bun
  sidecar are Developer ID signed, notarized, stapled, and accepted by
  Gatekeeper.
- Grounding:
  [ADR-0118](docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md)
  says Epicenter ships as one signed Tauri application, while
  `apps/epicenter/src-tauri/tauri.conf.json` still sets `"signingIdentity": "-"`.
- Revisit when: Before the first macOS build is distributed outside the
  development team.

## Re-earn a headless Epicenter runner

- Desired result: If a person needs Epicenter data to stay live on a machine
  with no open window (a homelab box, a build agent, an always-on anchor),
  offer one runner that opens a replica, joins sync, and stays alive, without
  reintroducing a mount, a lease, or a folder-shaped root.
- Grounding: `@epicenter/cli` did this as `epicenter up`, with `down`,
  `status`, and `logs` managing the process through pid metadata and OS
  signals, plus a resident folder watcher that kept a project directory and the
  replica in step. It was deleted in
  [commit 946064c1](https://github.com/EpicenterHQ/epicenter/commit/946064c128)
  because every verb read `@epicenter/workspace`, whose mount and daemon model
  ADR-0166 replaced. Treat that implementation as evidence of the process
  lifecycle problems already solved (lease claiming, pid liveness, log
  rotation, signal handling, debounced filesystem events), not as code to
  restore.
- Revisit when: A real always-on deployment needs data resident without a
  window, or the anchor role in ADR-0068 gets built.

## Re-earn a machine session and a file-for-URL command

- Desired result: Let a headless or scripted context authenticate to Epicenter
  and exchange a large local file for a durable URL, without shipping a whole
  CLI to do it.
- Grounding: `epicenter auth` held a machine session and `epicenter blobs`
  traded a file for an opaque-id S3 URL. The commands went with the CLI in
  [commit 946064c1](https://github.com/EpicenterHQ/epicenter/commit/946064c128);
  the auth machinery under them followed, because nothing but a terminal ever
  called it. What that machinery provided, as history rather than a
  compatibility commitment:
  - Terminal OAuth login. `loginWithOob` ran one out-of-band authorization-code
    + PKCE exchange against the same `/auth/oauth2/token` endpoint the browser
    uses. A dedicated `epicenter-cli` public client redirected to an
    Epicenter-owned `/cli-callback` page that rendered a one-time code for the
    user to paste back into the terminal.
  - Persisted machine sessions. One `PersistedAuth` cell per API target at
    `<dataDir>/auth/<host>.json`, mode `0o600`, refusing to load a file whose
    permissions were wider. `createMachineAuthClient` booted a daemon from that
    cell with a launcher that errored rather than prompting, and `status`
    reported `'unverified'` offline so a cached identity still printed.
  - A headless credential fork. `resolveMachineAuthClient` chose between a
    static self-host bearer (`EPICENTER_TOKEN`, or `EPICENTER_TOKEN_FILE` to
    keep the secret out of the process environment) and the persisted OAuth
    cell, so one entry point served both deployment kinds.
  The blob half is also superseded in shape:
  [ADR-0173](docs/adr/0173-each-row-owns-at-most-one-write-once-immutable-blob.md)
  makes a blob a row-owned write-once slot addressed by row, not an opaque id,
  so any replacement addresses a row rather than minting a BlobId.
  Authentication is now owned entirely by the apps, and there is no headless
  login workflow. Any future headless tool should be designed around a concrete
  workflow and re-derive its credential story from that, treating the above as
  inspiration rather than a target to restore.
- Revisit when: A scripted or agent workflow needs to authenticate or publish
  bytes from outside an app window.

## Re-earn typed markdown pages with user-defined types

- Desired result: A knowledge base whose pages carry a worldview-neutral core
  plus user-defined, schema-bearing types, so a page can be both prose and a
  typed record.
- Grounding: `apps/wiki` proved this as a headless vertical slice: an ECS-style
  page and tag model, a lens that classified stored rows as match, missing, or
  excess against a declared schema, a markdown codec, and a hand-written SQLite
  projection. It never had a UI and never ran as an application, and was deleted
  in
  [commit b32125ed](https://github.com/EpicenterHQ/epicenter/commit/b32125ed0a).
  The lens classification idea is the durable part and already informs Matter's
  handling of absent versus null frontmatter. The settled rejection is worth
  keeping too: a tag is not a page.
- Revisit when: Matter or another surface needs user-defined types over
  markdown, rather than one fixed frontmatter schema.

## Re-earn a file-and-folder view over Epicenter data

- Desired result: Let an application present collaborative data as familiar
  files and directories, with `mkdir`, `writeFile`, `mv`, `rm`, and `stat`,
  instead of raw rows.
- Grounding: `@epicenter/filesystem` did this over root-Yjs workspace data:
  file metadata in a table, each file's body in its own document, plus a path
  index and a name-collision policy. It reached zero callers and was deleted in
  [commit 97cf845f](https://github.com/EpicenterHQ/epicenter/commit/97cf845f20).
  The path index and naming rules are the non-obvious parts worth re-reading;
  the Yjs coupling is not.
- Revisit when: An application genuinely needs a hierarchical file abstraction
  that the row and document model cannot express directly.

## Revoke the `epicenter-cli` OAuth client row in each deployed database

- Desired result: No deployment still advertises a registered OAuth client for
  the deleted CLI.
- Grounding: The [removed OAuth seed](https://github.com/EpicenterHQ/epicenter/blob/f59fc1e19f/apps/api/scripts/seed-oauth-clients.ts) only upserts the clients
  it knows about; it never deletes. The `epicenter-cli` row seeded before that
  client was removed from `buildTrustedOAuthClients` therefore survives in every
  database that was seeded, still carrying its `/cli-callback` redirect URI. It
  no longer skips consent (it left `trustedOAuthClientIds`) and its redirect
  target now 404s, but it remains valid client metadata at `/authorize` and
  `/token`. The fix is one `DELETE FROM oauth_client WHERE client_id =
  'epicenter-cli'` per deployed database, or setting `disabled = true` to keep
  the row for audit. Deliberately not executed here: this is a production
  database mutation, not a code change.
  The direct-session implementation removes these registration surfaces for
  fresh deployments; it has not changed any deployed database.
- Revisit when: The next production deploy of `apps/api`, or sooner if an audit
  of registered OAuth clients is run.

## Deprecate the npm packages this repository no longer builds

- Desired result: Someone who installs `@epicenter/workspace`,
  `@epicenter/filesystem`, or `@epicenter/cli` learns the direction changed,
  without breaking any existing install.
- Grounding: All three remain published (`0.3.0`, `0.3.0`, and `0.1.0`) and
  keep resolving, but their source left the tree in commits `97cf845f`,
  `946064c1`, and `b9327963`. `npm deprecate <pkg>@"<=0.3.0" "<message>"` is
  reversible with an empty string and never blocks publishing a later version
  under the same name. Do not unpublish: that permanently burns the version
  number.
- Revisit when: Before the next npm release from this repository.
