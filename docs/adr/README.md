# Architecture Decision Records

An ADR captures one durable decision: the forces that made it necessary, what we
decided, and what that costs. ADRs are the authoritative record of *why* the
system is shaped the way it is. Specs explore options; an ADR records the one
outcome we committed to.

This is the layer agents and humans should trust for decisions. If a spec in
`specs/`, a row in `docs/spec-history.md`, or an old comment disagrees with an
accepted ADR, the ADR wins.

## Rules

- **One decision per record.** If you are documenting several decisions, write
  several ADRs.
- **Immutable once accepted.** Do not edit a decision out of an accepted ADR. To
  change direction, write a new ADR, set its `Supersedes` to the old one, and set
  the old one's `Superseded by` to the new one. The chain is the history.
- **Concise and outcome-focused.** An ADR is not a spec. State the decision so a
  reader can act on it without reading the exploration. Link the spec for the
  deep evidence if it still exists; otherwise cite the git ref.
- **Status is one of:** `Proposed`, `Accepted`, `Superseded`.
- **Decisions are born from specs but do not live there.** When a design pass
  settles something durable, harvest it into an ADR and let the spec be deleted.
- **`Proposed` is a transient state.** Record a decision as `Proposed` when it
  crystallizes during design; flip it to `Accepted` when the work lands. A
  `Proposed` ADR that no in-tree spec references means its spec was deleted (the
  work landed): flip it, or supersede it if abandoned. `bun
  scripts/check-doc-hygiene.ts` flags orphaned and stale `Proposed` ADRs.

## Numbering

`NNNN-kebab-decision-as-sentence.md`, zero-padded, monotonically increasing. The
title is the decision stated as a declarative sentence, so the filename alone
reads as the conclusion.

**The number is allocated at merge time, not author time.** It is owned by the
merge, not the branch. Two branches that each grab "the next number" while
branched will collide (this is why parallel work has produced duplicate numbers
before). So a branch may carry a *provisional* number; the person merging
reconciles it to the true next-free integer, accounting for other open ADR PRs,
before it lands. Whoever merges first keeps the number; a later branch that
picked the same one renumbers. The `ADR-NNNN` citation form stays stable once
merged; only the pre-merge placeholder is negotiable.

## Template

```markdown
# NNNN. <decision stated as one declarative sentence>

- **Status:** Proposed | Accepted | Superseded
- **Date:** YYYY-MM-DD
- **Supersedes:** [ADR-MMMM](MMMM-*.md) (or omit)
- **Superseded by:** [ADR-PPPP](PPPP-*.md) (added only when this is retired)

## Context

The forces in play: what was true, what pressure forced a decision. No survey of
alternatives yet, just why a decision was needed. Two to five sentences.

## Decision

The single thing we decided, in active voice, present tense. A reader should be
able to act on this paragraph alone.

## Consequences

What becomes true, easier, harder, or deleted as a result. Name the trade-off
honestly, including what this forecloses.

## Considered alternatives  (optional)

Each option and the one reason it lost. Terse. This is not the spec.
```

## Index

| ADR | Decision | Status |
|-----|----------|--------|
| [0001](0001-classified-scan-read-surface.md) | One classified `scan()`, no valid-only default read | Accepted (bucket list amended by 0003) |
| [0002](0002-four-visible-read-states.md) | Stored entries reconcile to four visible read states | Superseded by 0003 |
| [0003](0003-three-read-states-after-encryption-removal.md) | Stored entries reconcile to three visible read states | Accepted |
| [0004](0004-trust-the-relay-reject-zero-knowledge.md) | Trust the relay; reject zero-knowledge | Accepted |
| [0005](0005-child-docs-are-bound-through-the-workspace.md) | Child docs are bound through the workspace, not the component | Superseded by 0126 |
| [0006](0006-schema-evolution-keeps-the-version-tuple-and-refuses-repair-apis.md) | Schema evolution keeps the version tuple and refuses repair APIs | Accepted |
| [0007](0007-local-shortcuts-sync-global-shortcuts-stay-per-device.md) | Local shortcuts sync, global shortcuts stay per-device | Accepted |
| [0008](0008-rdev-backs-the-desktop-global-trigger.md) | rdev backs the desktop global trigger | Superseded by 0117 |
| [0009](0009-the-cli-dispatches-through-a-mandatory-daemon.md) | The CLI dispatches through a mandatory daemon; automation lives in library scripts | Accepted |
| [0010](0010-whispering-exports-recordings-as-a-zip-continuous-markdown-is-the-mounts-job.md) | Whispering exports recordings as a zip; continuous Markdown is the mount's job | Accepted |
| [0011](0011-rust-owns-the-macos-dictation-capability.md) | Rust owns the macOS dictation capability; the frontend is a view over it | Accepted |
| [0012](0012-transcription-settings-are-read-at-use-not-mirrored-into-rust.md) | Transcription settings are read at use; Rust's model cache owns mechanism, not config | Accepted |
| [0013](0013-file-import-is-a-surface-not-a-recording-mode.md) | File import is a surface, not a recording mode | Accepted |
| [0014](0014-view-transitions-morph-a-re-expressed-glyph-not-its-container.md) | View transitions morph a re-expressed glyph, not its container | Accepted |
| [0015](0015-the-brand-mark-has-one-canonical-source-every-other-form-is-generated.md) | The brand mark has one canonical source; every other form is generated | Proposed |
| [0016](0016-prewarm-the-cold-model-load-and-refuse-the-rest-of-the-latency-menu.md) | Prewarm the cold model load and refuse the rest of the latency menu | Accepted |
| [0017](0017-pause-system-media-playback-while-recording.md) | Pause system media playback while recording through one cross-platform controller | Accepted (VAD timing revised by 0027; default reaffirmed by 0045) |
| [0018](0018-macos-resume-is-gated-on-a-coreaudio-output-read.md) | macOS resume is gated on a CoreAudio output read, not a MediaRemote read shim | Accepted (no-op consequence corrected by 0045) |
| [0019](0019-global-shortcuts-have-a-permission-free-floor-and-accessibility-is-an-opt-in-tier.md) | Global shortcuts have a permission-free floor; Accessibility is an opt-in tier | Superseded by 0117 |
| [0020](0020-macos-drives-its-keyboard-tap-with-an-owned-cgeventtap.md) | macOS drives its keyboard tap with an owned CGEventTap, not the rdev fork | Accepted |
| [0021](0021-actions-are-the-only-surface-that-crosses-a-process-boundary.md) | Actions are the only surface that crosses a process boundary | Accepted |
| [0022](0022-rust-owns-the-models-folder-the-webview-owns-the-catalog.md) | Rust owns the models folder, the webview owns the catalog | Accepted |
| [0023](0023-whispering-separates-its-identity-mark-from-lucide-controls.md) | Whispering separates its identity mark from Lucide controls | Accepted |
| [0024](0024-an-always-on-worker-runs-app-semantics-beside-the-app-blind-anchor.md) | An always-on worker runs app semantics beside the app-blind anchor | Superseded by 0043 |
| [0025](0025-agent-conversations-are-durable-child-docs-driven-by-an-observing-worker.md) | Agent conversations are durable child docs driven by an observing worker | Superseded by 0031 |
| [0026](0026-matter-vault-sqlite-is-a-projection-never-a-verdict-source.md) | The Matter vault's SQLite mirror is a read-only projection, never a verdict source | Accepted |
| [0027](0027-playback-pause-tracks-the-speaking-window.md) | Playback pause tracks the speaking window; VAD pauses per utterance | Accepted |
| [0028](0028-both-shortcut-tiers-share-one-physical-keybinding-model.md) | Both shortcut tiers share one physical KeyBinding model | Accepted |
| [0029](0029-matter-json-marks-a-table.md) | A matter.json marks a table; matter is a declared store, not a discovered lens | Accepted |
| [0030](0030-agents-are-immutable-capability-bundles.md) | Agents are immutable capability bundles; arbitrary code runs only on a trusted box | Accepted |
| [0031](0031-collaboration-is-addressed-single-writer-regions-in-a-child-doc.md) | Collaboration is addressed single-writer regions in a child doc | Accepted (supersedes 0025) |
| [0032](0032-a-folder-is-a-table-or-a-container-of-tables-never-both.md) | A folder is a table or a container of tables, never both (owns reference resolution) | Accepted |
| [0033](0033-a-conversation-has-one-transport-and-two-triggers.md) | A conversation is a synced doc answered only by in-process peers; the cloud is a metered inference stream | Accepted |
| [0034](0034-the-cloud-doc-generation-queue-is-withdrawn.md) | The cloud doc-generation queue is withdrawn | Superseded by 0033 |
| [0035](0035-durable-storage-is-one-per-person-coordination-box.md) | Durable storage is one per-person coordination box: an app-blind anchor and store | Accepted |
| [0036](0036-answer-bodies-are-native-parts-arrays-streamed-into-y-text.md) | An answer body is a native parts array; its text streams into Y.Text | Superseded by 0047 |
| [0037](0037-adapter-construction-is-a-shared-leaf-package-keyed-on-the-model-catalog.md) | Adapter construction is a shared leaf package keyed on the model catalog | Superseded by 0050 |
| [0038](0038-a-daemon-answers-through-the-first-inference-backend-it-can-satisfy.md) | A daemon answers through the first inference backend it can satisfy: byok, else opted-in metered, else host without answering | Superseded by 0049 |
| [0039](0039-dictation-feedback-is-a-projection-of-one-lifecycle-state.md) | Dictation feedback is a projection of one lifecycle state, not an event log | Accepted |
| [0040](0040-a-cursor-write-that-cannot-paste-falls-back-to-the-clipboard-decided-from-the-grant.md) | A cursor write that cannot paste falls back to the clipboard, decided from the grant | Accepted |
| [0041](0041-every-answerer-is-a-worker-the-browser-never-answers.md) | Every answerer is a worker; the browser never answers | Superseded by 0043 |
| [0042](0042-the-agent-loop-is-the-workers-over-the-doc-as-the-message-array.md) | The agent loop is the worker's, over the doc as the message array | Superseded by 0047 |
| [0043](0043-an-agent-answers-where-its-capability-lives.md) | An agent answers where its capability lives (supersedes 0041 every-answerer) | Superseded by 0047 |
| [0044](0044-tool-approval-is-a-per-conversation-policy.md) | Tool approval is a per-conversation policy, resolved per call (auto / ask / deny) | Accepted (design; approval mechanism revised by 0047) |
| [0045](0045-playback-pause-is-opt-in-because-resume-can-start-unrelated-media.md) | Playback pause ships opt-in because macOS resume can start unrelated media | Accepted |
| [0046](0046-a-capability-free-agent-persists-finished-messages-not-live-doc-streams.md) | A capability-free agent persists finished messages, not live doc streams (scopes 0036) | Superseded by 0047 |
| [0047](0047-the-agent-loop-runs-in-the-client-and-tools-are-dispatched-actions.md) | The agent loop runs in the client; tools are dispatched actions, and the daemon provides data, not inference | Accepted (design; core deleted as consumers migrate) |
| [0048](0048-a-conversations-loop-is-chosen-by-whether-its-transcript-syncs.md) | A conversation's loop is chosen by whether its transcript syncs across peers | Superseded by 0051 |
| [0049](0049-inference-is-its-own-box-the-daemon-never-infers.md) | Inference is its own box; the daemon never infers; the client loop talks to a swappable inference server | Accepted |
| [0050](0050-the-inference-contract-is-openai-compatible.md) | The inference contract is OpenAI-compatible Chat Completions; Epicenter's backend is one swappable gateway | Accepted |
| [0051](0051-one-agent-loop-its-store-seam-chooses-persistence.md) | There is one agent loop; its store seam chooses persistence, so tab-manager needs no second loop | Accepted (supersedes 0048) |
| [0052](0052-shortcut-reach-is-the-minimum-of-command-key-and-platform-ceilings.md) | Shortcut reach is the minimum of command, key, and platform ceilings, never a user toggle | Proposed |
| [0053](0053-the-epicenter-bearer-is-an-audience-scoped-credential.md) | The Epicenter bearer is an audience-scoped credential; auth.fetch attaches it only to its origin | Accepted |
| [0054](0054-an-inference-backend-is-the-metered-gateway-or-a-custom-server.md) | An inference backend is either the metered Epicenter gateway or a custom OpenAI-compatible server | Accepted |
| [0055](0055-conversation-storage-is-one-canonical-table-every-surface-syncs.md) | Conversation storage is one canonical table in @epicenter/chat; every chat surface syncs | Accepted |
| [0056](0056-local-inference-is-a-delegated-engine-behind-the-openai-compatible-seam.md) | Local inference is a delegated engine behind the OpenAI-compatible seam; the runtime is a swappable default | Accepted |
| [0057](0057-assistant-markdown-renders-as-a-shared-component-tree-not-a-sanitized-html-string.md) | Assistant markdown renders as a shared component tree, not a sanitized HTML string | Accepted |
| [0058](0058-push-to-talk-owns-the-recording-it-starts-keyed-by-its-id-not-a-lifecycle-layer.md) | Push-to-talk owns the recording it starts, keyed by the recording's id, not a general lifecycle layer | Accepted |
| [0059](0059-an-inference-connection-is-a-capability-orthogonal-device-endpoint.md) | An inference connection is a capability-orthogonal device endpoint; the model is per-conversation (amends 0054) | Accepted (auth axis amended by 0060) |
| [0060](0060-an-inference-connection-is-a-base-url-and-an-optional-bearer-key.md) | An inference connection is a base URL and an optional bearer key; everything non-static is an injected transport (amends 0059) | Accepted |
| [0061](0061-local-books-reads-facts-from-the-mirror-reports-live-and-writes-through-one-approved-verb.md) | Local Books serves row-level facts from the mirror, computed reports live, and writes back through one approved verb | Accepted |
| [0062](0062-local-books-stores-oauth-tokens-in-a-single-0600-file.md) | Local Books stores OAuth tokens in a single 0600 file | Accepted |
| [0063](0063-the-local-books-mirror-is-a-multi-writer-cache-made-safe-by-one-monotonic-write-door.md) | The Local Books mirror is a multi-writer cache made safe by one monotonic write door, not single-writer discipline | Accepted |
| [0064](0064-the-local-books-mirror-keeps-one-realm-cdc-cursor-table-existence-is-the-per-entity-init-latch.md) | The Local Books mirror keeps one realm CDC cursor; table existence is the per-entity init latch | Accepted |
| [0065](0065-matter-is-a-standalone-disk-as-truth-tool-its-sqlite-is-a-read-only-query-surface.md) | Matter is a standalone disk-as-truth tool; its SQLite mirror is a first-class read-only query surface under `epicenter matter` | Accepted |
| [0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) | Runtime portability is per-concern injection, not a runtime object | Accepted |
| [0067](0067-auth-owns-the-session-endpoint-the-data-client-is-owner-scoped.md) | Auth owns the `/api/session` endpoint; the data client is owner-scoped and receives `ownerId` at construction | Accepted (amended by 0092) |
| [0068](0068-privacy-is-a-deployment-not-a-product-feature.md) | Privacy is a deployment, not a product feature; the hosted app carries zero privacy-configuration surface | Accepted |
| [0069](0069-epicenter-is-one-runnable-star-plus-services-called-by-url-and-token.md) | Epicenter is one runnable program (the star) plus a la carte services addressed by base URL and token | Accepted |
| [0070](0070-self-host-adds-no-new-ownership-or-auth-mode.md) | Self-host adds no new ownership or auth mode: single-user is a preset, and only the credential source varies | Superseded by [0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) |
| [0071](0071-oauth-is-hosted-only-a-custom-instance-requires-a-token.md) | OAuth is hosted-only; a custom instance requires a token | Accepted |
| [0072](0072-local-books-ships-as-a-standalone-cli-the-daemon-surface-is-deferred.md) | Local Books ships as a standalone CLI; the ADR-0047 daemon surface is deferred behind a verb-core seam | Accepted |
| [0073](0073-tools-speak-mcp-natively-epicenter-owns-only-the-transport-mcp-lacks.md) | Tools speak MCP natively; Epicenter owns only the transport MCP lacks | Accepted (historical relay-floor channel layer deleted by ADR-0079/0086) |
| [0074](0074-the-secret-vault-is-an-owner-scoped-synced-store-encrypted-under-a-server-derived-keyring.md) | The secret vault is an owner-scoped synced store encrypted under a server-derived keyring, not a passphrase vault | Accepted |
| [0075](0075-self-host-is-a-single-partition-instance-behind-one-operator-supplied-bearer.md) | Self-host is a single-partition instance behind one operator-supplied bearer; multi-tenancy is Cloud-only | Accepted (amended by 0092) |
| [0076](0076-the-relational-auth-substrate-is-a-cloud-only-layer-the-instance-composes-neither.md) | The relational-auth substrate (Better Auth + Postgres) is a Cloud-only layer; the instance composes neither | Accepted |
| [0077](0077-parsed-row-memoization-belongs-to-the-table-the-svelte-adapter-is-a-stateless-view.md) | Parsed-row memoization belongs to the table; the Svelte adapter is a stateless view | Accepted |
| [0078](0078-inference-is-a-url-addressed-connection-the-relay-floor-carries-only-tools.md) | Inference is a URL-addressed connection reached through a direct endpoint or gateway | Accepted (relay-floor tool carrier superseded by ADR-0079/0086) |
| [0079](0079-cross-device-is-two-planes-epicenter-syncs-the-crdt-the-box-is-reached-directly.md) | Cross-device is two planes: Epicenter syncs the CRDT, the box is reached directly as a URL-addressed connection | Accepted (capability-layer deletion landed 2026-07-02) |
| [0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) | The super app is a desktop host; cross-device is remote access to the session, not a per-app capability plane | Accepted (the desktop-host decision is settled; a hosted session broker for turnkey mobile remote is the open product question) |
| [0081](0081-per-upstream-oauth-concurrency-decides-mirror-topology.md) | Per-upstream OAuth concurrency decides whether a materialized mirror is box-owned (Local Books) or device-local (Gmail), not a property of "cloud-upstream apps" as a category | Proposed |
| [0082](0082-local-mail-mirror-is-push-free-polling-collapsing-hosted-vs-self-host-to-one-oauth-client-id.md) | Local Mail's mirror is push-free CDC polling; hosted vs self-host collapses to one OAuth Client ID | Proposed |
| [0083](0083-apps-email-is-refused-local-mail-is-the-only-gmail-client.md) | `apps/email` is refused; Local Mail is the only Gmail client | Accepted |
| [0084](0084-super-chat-shell-is-a-bun-hosted-local-server-not-a-bundled-spa.md) | Super Chat's shell is a Bun-hosted local server, not a bundled SPA | Accepted |
| [0085](0085-a-box-is-a-role-an-addressable-endpoint-plays-not-a-node-type.md) | A box is a role an addressable endpoint plays, not a distinct node type | Accepted |
| [0086](0086-no-live-consumer-for-network-reachable-capability-reach-opensidian-is-superseded-not-migrated.md) | There is no live consumer for network-reachable capability reach; opensidian's cross-device tools are superseded by the super app, not migrated | Accepted |
| [0087](0087-honeycrisp-is-the-maintained-notes-product-from-one-isomorphic-workspace-surface.md) | Honeycrisp is the maintained notes product from one isomorphic workspace surface | Accepted |
| [0088](0088-sign-in-is-an-enhancement-never-a-door.md) | Sign-in is an enhancement, never a door | Accepted |
| [0089](0089-the-blob-store-is-a-presigned-s3-kernel-and-the-bucket-is-its-only-index.md) | The blob store is a presigned-S3 kernel and the bucket is its only index | Accepted (key prefix amended by 0092) |
| [0090](0090-the-blob-layer-stays-plaintext-confidentiality-belongs-to-the-encrypting-consumer.md) | The blob layer stays plaintext; confidentiality belongs to the encrypting consumer | Accepted |
| [0091](0091-blobs-trade-a-file-for-a-durable-content-addressed-url-documents-are-the-only-manifest.md) | Blobs trade a file for a durable content-addressed URL; documents are the only manifest | Accepted (URL shape amended by 0092) |
| [0092](0092-identity-is-the-partition.md) | Identity is the partition | Accepted |
| [0093](0093-kv-metadata-belongs-to-the-workspace-kv-namespace.md) | KV metadata belongs to the workspace kv namespace | Accepted |
| [0094](0094-the-connection-is-the-boot-decision-one-connect-call.md) | The connection is the boot decision: one connect call | Accepted |
| [0095](0095-websocket-room-auth-uses-route-owned-subprotocol-bearers.md) | WebSocket room auth uses route-owned subprotocol bearers | Accepted |
| [0096](0096-local-workspace-persistence-is-environment-injected.md) | Local workspace persistence is environment-injected | Accepted |
| [0097](0097-super-chat-tool-modules-receive-a-host-api.md) | Super Chat tool modules receive a host API | Superseded by 0111 |
| [0098](0098-local-mail-state-round-trips-through-gmail.md) | Every Local Mail concept a human acts on round-trips through Gmail API state | Accepted |
| [0099](0099-replace-transformations-with-a-dictionary-polish-and-a-portable-recipe-library.md) | Replace Transformations with a Dictionary, an always-on Polish, and a portable Recipe library | Accepted |
| [0100](0100-ai-credits-are-product-units-and-the-charge-shape-follows-when-cost-is-known.md) | AI credits are product-priced units; the charge shape follows whether cost is known before the call | Accepted (STT overspend remedy refined by 0103) |
| [0101](0101-native-typed-row-projection-views-are-earned-serially-board-is-first.md) | Native typed-row projection views are earned serially; board is first | Accepted |
| [0102](0102-vocab-stores-verbatim-entries-under-a-human-owned-note-and-refuses-glosses-srs-and-provenance.md) | Vocab stores verbatim entries under a human-owned note and refuses glosses, SRS, and provenance | Accepted |
| [0103](0103-stt-overspend-is-guarded-in-trigger-order-never-by-media-preflight.md) | STT overspend is bounded by cheap guards in trigger order, never by media preflight or a reservation lock | Accepted |
| [0104](0104-hosted-models-are-a-build-time-seed-not-discovered-the-runtime-overlay-is-deferred.md) | Hosted models are a build-time seed catalog, not a discovered one; a runtime overlay is a named deferral | Accepted |
| [0105](0105-vocab-is-a-multilingual-tutor-and-readings-are-a-client-side-derived-view.md) | Vocab is a multilingual tutor and readings are a client-side derived view | Accepted |
| [0106](0106-a-child-doc-body-owns-one-layout-the-polymorphic-timeline-is-refused-until-a-product-earns-it.md) | A child-doc body owns one layout; the polymorphic timeline is refused until a product earns it | Accepted |
| [0107](0107-a-child-doc-text-body-is-a-plain-y-text-the-timeline-array-is-deleted.md) | A child-doc text body is a plain `Y.Text`; the timeline array is deleted | Accepted |
| [0108](0108-provider-credentials-are-selected-by-target-environment-encoded-in-the-secret-name.md) | Third-party provider credentials are selected by the app's target provider-environment, encoded in the secret name and resolved by one injected helper | Accepted |
| [0109](0109-hosted-tauri-auth-keeps-app-owned-keyring-edges-until-three-real-callers-earn-sharing.md) | Hosted Tauri auth keeps app-owned keyring edges until three real callers earn sharing | Accepted |
| [0110](0110-edit-write-timing-follows-the-value-owner-there-is-no-debounce-tier.md) | Edit write timing follows the value owner; there is no debounce tier | Accepted |
| [0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md) | Super Chat v1 exposes built-in Epicenter apps and defers extension surfaces | Accepted |
| [0112](0112-the-cli-watcher-is-not-a-callable-action-server.md) | The CLI watcher is not a callable action server | Superseded by 0144 |
| [0113](0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md) | Super Chat session commands are host-owned; transports only frame them | Accepted |
| [0114](0114-hosted-auth-surfaces-are-plain-tool-logins-not-marketing-pages.md) | Hosted auth surfaces are plain tool logins, not marketing pages | Accepted |
| [0115](0115-super-chat-remote-attach-rides-an-endpoint-addressed-trusted-relay.md) | Super Chat remote attach rides an endpoint-addressed trusted AttachRelay; one consumer, not the deleted route-addressed relay floor | Accepted |
| [0116](0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md) | Local Mail is desktop-first: one Bun engine, no background mail service, the open app owns the sync loop | Accepted |
| [0117](0117-global-shortcut-input-is-plugin-chords-only-and-the-macos-tap-is-just-the-paste-grant-watcher.md) | Global shortcut input is plugin chords only, and the macOS tap is just the paste grant watcher | Accepted |
| [0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) | Epicenter is one trusted Bun-hosted SPA origin | Accepted |
| [0119](0119-complete-metadata-replicas-sync-through-schema-blind-server-ordered-mutations.md) | Complete metadata replicas sync through schema-blind server-ordered mutations | Accepted |
| [0120](0120-persisted-fields-are-atomic-cells-and-collaborative-bodies-are-yjs-documents.md) | Persisted fields are atomic cells and collaborative bodies are Yjs documents | Accepted |
| [0121](0121-background-sync-is-automatic-and-database-boundary-merges-are-reviewable.md) | Background sync is automatic and database-boundary merges are reviewable | Accepted |
| [0122](0122-logical-snapshots-are-the-portable-record-database-format-sqlite-files-are-runtime-state.md) | Logical snapshots are the portable records database format; SQLite files are runtime state | Superseded by 0139 |
| [0123](0123-bounded-metadata-uses-record-authority-merge-sensitive-state-uses-lazy-child-documents.md) | Bounded metadata uses record authority; merge-sensitive state uses lazy child documents | Accepted |
| [0124](0124-workspace-kv-keeps-one-logical-identity-outside-the-record-database.md) | Workspace KV keeps one logical identity outside the records database | Accepted |
| [0125](0125-record-schemas-are-immutable-evolution-creates-a-successor-database.md) | Records schemas are immutable; evolution creates a successor database | Superseded by 0130 |
| [0126](0126-child-documents-use-format-capabilities-and-evolve-outside-records-databases.md) | Child documents use format capabilities and evolve outside records databases | Accepted (touch policy amended by 0128) |
| [0127](0127-chat-streams-live-turns-in-client-state-and-stores-finished-messages-as-records.md) | Chat streams live turns in client state and stores finished messages as records | Accepted |
| [0128](0128-tables-do-not-declare-document-edit-touch-policy-without-a-runtime-owner.md) | Tables do not declare document-edit touch policy without a runtime owner | Accepted |
| [0129](0129-matter-is-markdown-authoritative-application-records-follow-developer-owned-schemas.md) | Matter is Markdown-authoritative; application records follow developer-owned schemas | Accepted |
| [0130](0130-records-replacement-starts-a-new-epoch-without-an-online-succession-protocol.md) | Records replacement starts a new epoch without an online succession protocol | Superseded by 0134 |
| [0131](0131-every-durable-records-materialization-carries-its-canonical-descriptor.md) | Every durable records materialization carries its canonical descriptor | Accepted |
| [0132](0132-an-obsolete-replica-exports-one-read-only-recovery-checkpoint.md) | An obsolete replica exports one read-only recovery checkpoint | Accepted |
| [0133](0133-ordinary-record-sync-requests-carry-only-the-records-epoch.md) | Ordinary record sync requests carry only the records epoch | Accepted |
| [0134](0134-application-data-generations-own-immutable-workspace-namespaces.md) | Application data generations own immutable workspace namespaces | Superseded by 0136 |
| [0135](0135-new-builds-ask-before-initializing-a-new-data-generation.md) | New builds ask before initializing a new data generation | Accepted (terminology amended by 0136) |
| [0136](0136-applications-declare-immutable-data-versions.md) | Applications declare immutable data versions | Superseded by 0137 |
| [0137](0137-applications-declare-one-live-workspace-per-contract-version.md) | Applications declare one live workspace per contract version | Accepted |
| [0138](0138-tables-declare-cells-documents-and-blobs-in-one-field-map.md) | Tables declare cells, documents, and blobs in one field map | Accepted |
| [0139](0139-portable-workspaces-are-schema-directed-folders-applied-as-forward-mutations.md) | Portable workspaces are schema-directed folders applied as forward mutations | Accepted |
| [0140](0140-portable-ownership-has-no-generic-whole-workspace-import.md) | Portable ownership has no generic whole-workspace import | Accepted |
| [0141](0141-workspace-authority-is-selected-once-and-owns-one-local-database.md) | Workspace authority is selected once and owns one local database | Accepted |
| [0142](0142-workspace-apps-receive-one-connection-while-storage-planes-keep-their-own-protocols.md) | Workspace apps receive one connection while storage planes keep their own protocols | Accepted |
| [0143](0143-document-synchronization-addresses-rooms-not-installations.md) | Document synchronization addresses rooms, not installations | Accepted |
| [0144](0144-open-applications-own-local-execution.md) | Open applications own local execution | Accepted |
| [0145](0145-external-systems-of-record-keep-local-mirrors-outside-epicenter-sync.md) | External systems of record keep local mirrors outside Epicenter sync | Accepted |
| [0146](0146-tab-manager-is-a-synchronized-web-capture-inbox.md) | Tab Manager is a synchronized web-capture inbox | Accepted |

When you add an ADR, add its row here.
