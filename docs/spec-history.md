# Spec History (design timeline)

> **Historical index, not current truth.** Every spec that has ever existed on a
> ref this clone can see, by date, generated from git history so the timeline
> survives any deletion. Scope is every `specs/` directory repo-wide.
>
> - For **current decisions and why**, read `docs/adr/`.
> - For **how package-owned systems work now**, read the package README and code.
> - For **shared vocabulary**, read `docs/CONTEXT.md`.
> - To **read a removed spec's body**: `git log --all --full-history -- "<path>"` then `git show <sha>:<path>`.
>
> A row records that a design was explored on that date. It does not mean the
> design is live. There is no status column on purpose: a spec's self-declared
> status is unreliable, so currentness is owned by `docs/adr/`. "State" is the
> only fact shown: whether the spec is still in the working tree.
>
> **Regenerate (deterministic per ref set, lossless):** `bun scripts/generate-spec-history.ts`. The totals track the refs this clone can see; `--all` is deliberate so the timeline recovers specs that only lived on unmerged or deleted branches.

**1428 specs ever** (524 still in tree, 904 removed).


## 2026

| Date | Spec | State | Path |
|------|------|-------|------|
| 2026-09-07 | direct-session-auth.handoff | removed | specs/20260907T214002-direct-session-auth.handoff.md |
| 2026-09-07 | direct-session-auth | removed | specs/20260907T214002-direct-session-auth.md |
| 2026-09-05 | keyed-session-boot | in tree | specs/20260905T005141-keyed-session-boot.md |
| 2026-09-05 | account-exit-and-local-removal.execute | removed | specs/20260905T210735-account-exit-and-local-removal.execute.md |
| 2026-09-05 | account-exit-and-local-removal | removed | specs/20260905T210735-account-exit-and-local-removal.md |
| 2026-08-28 | the-switch | in tree | specs/20260828T230000-the-switch.md |
| 2026-08-26 | host-discovery-connect-device | in tree | apps/epicenter/specs/host-discovery-connect-device.md |
| 2026-08-26 | inference-credit-billing | removed | specs/20260826T120000-inference-credit-billing.md |
| 2026-08-26 | instance-stops-doing-inference | removed | specs/20260826T190000-instance-stops-doing-inference.md |
| 2026-08-14 | hosted-store-address-book | in tree | specs/20260814T170000-hosted-store-address-book.md |
| 2026-08-14 | honeycrisp-lifecycle-model.handoff | removed | specs/20260814T190000-honeycrisp-lifecycle-model.handoff.md |
| 2026-08-10 | ark-lens-and-markdown-checkout | in tree | specs/20260810T000000-ark-lens-and-markdown-checkout.md |
| 2026-08-08 | honeycrisp-two-device-run | in tree | specs/20260808T080000-honeycrisp-two-device-run.md |
| 2026-08-08 | honeycrisp-two-device-run | removed | specs/20260808T070000-honeycrisp-two-device-run.md |
| 2026-08-08 | honeycrisp-syncs-across-two-devices | removed | specs/20260808T060000-honeycrisp-syncs-across-two-devices.md |
| 2026-08-08 | honeycrisp-is-the-first-app-on-the-new-store | removed | specs/20260808T020000-honeycrisp-is-the-first-app-on-the-new-store.md |
| 2026-08-07 | HANDOFF-honeycrisp-onto-the-new-store | removed | specs/HANDOFF-honeycrisp-onto-the-new-store.md |
| 2026-08-07 | the-authority-holds-bytes | removed | specs/20260807T210000-the-authority-holds-bytes.md |
| 2026-08-07 | yjs-store-and-lens | removed | specs/20260807T090000-yjs-store-and-lens.md |
| 2026-08-05 | an-installed-app-holds-nothing | in tree | specs/20260805T140000-an-installed-app-holds-nothing.md |
| 2026-08-05 | replicated-cell-store-memo | removed | specs/20260805T190000-replicated-cell-store-memo.md |
| 2026-08-05 | an-installed-app-owns-a-namespace | removed | specs/20260805T193000-an-installed-app-owns-a-namespace.md |
| 2026-08-04 | markdown-projection | removed | specs/20260804T230000-markdown-projection.md |
| 2026-08-04 | working-copy-tiers | removed | specs/20260804T203000-working-copy-tiers.md |
| 2026-08-02 | app-data-root-and-partitions | in tree | specs/20260802T120000-app-data-root-and-partitions.md |
| 2026-08-02 | row-document-doc-status-reconciliation | removed | specs/20260802T101500-row-document-doc-status-reconciliation.md |
| 2026-08-01 | local-mail-intent-and-reconciler-clean-break | removed | specs/20260801T210000-local-mail-intent-and-reconciler-clean-break.md |
| 2026-08-01 | local-mail-pending-overlays | removed | specs/20260801T164500-local-mail-pending-overlays.md |
| 2026-08-01 | local-mail-convergent-request-plane | removed | specs/20260801T173435-local-mail-convergent-request-plane.md |
| 2026-08-01 | vocab-chinese-companion-clean-break | removed | specs/20260801T005746-vocab-chinese-companion-clean-break.md |
| 2026-07-31 | vocab-chinese-conversation-companion | removed | specs/20260731T234500-vocab-chinese-conversation-companion.md |
| 2026-07-20 | epicenter-data-clean-break | in tree | specs/20260720T002337-epicenter-data-clean-break.md |
| 2026-07-20 | epicenter-data-clean-break.handoff | removed | specs/20260720T002337-epicenter-data-clean-break.handoff.md |
| 2026-07-19 | app-owned-workspace-lenses-clean-break | in tree | specs/20260719T180000-app-owned-workspace-lenses-clean-break.md |
| 2026-07-19 | one-app-catalog-clean-break | removed | specs/20260719T180000-one-app-catalog-clean-break.md |
| 2026-07-19 | one-epicenter-clean-break | removed | specs/20260719T222716-one-epicenter-clean-break.md |
| 2026-07-19 | owner-scoped-workspace-stores | removed | specs/20260719T003311-owner-scoped-workspace-stores.md |
| 2026-07-17 | workspace-root-cleanup | in tree | specs/20260717T120000-workspace-root-cleanup.md |
| 2026-07-17 | two-plane-row-document-runtime | in tree | specs/20260717T212450-two-plane-row-document-runtime.md |
| 2026-07-17 | hosted-storage-policy | removed | specs/20260717T004239-hosted-storage-policy.md |
| 2026-07-16 | portable-workspace-tree-greenfield-dialectic | removed | specs/20260716T112345-portable-workspace-tree-greenfield-dialectic.md |
| 2026-07-16 | workspace-tables-kv-row-documents | removed | specs/20260716T161934-workspace-tables-kv-row-documents.md |
| 2026-07-16 | confirmed-state-compacted-row-intents | removed | specs/20260716T204040-confirmed-state-compacted-row-intents.md |
| 2026-07-16 | workspace-tables-kv-row-bodies | removed | specs/20260716T161934-workspace-tables-kv-row-bodies.md |
| 2026-07-16 | fold-never-refuse-sync-architecture | removed | specs/20260716T173049-fold-never-refuse-sync-architecture.md |
| 2026-07-14 | synchronized-data-open-runtime-clean-break | removed | specs/20260714T162816-synchronized-data-open-runtime-clean-break.md |
| 2026-07-14 | sqlite-workspace-app-adoption | removed | specs/20260714T131232-sqlite-workspace-app-adoption.md |
| 2026-07-14 | workspace-contract-clean-break | removed | specs/20260714T110841-workspace-contract-clean-break.md |
| 2026-07-13 | immutable-application-data-generations | removed | specs/20260713T211805-immutable-application-data-generations.md |
| 2026-07-13 | agent-skill-surface-consolidation | removed | specs/20260713T195355-agent-skill-surface-consolidation.md |
| 2026-07-11 | server-authoritative-sqlite-sync.handoff | removed | specs/20260711T103822-server-authoritative-sqlite-sync.handoff.md |
| 2026-07-11 | server-authoritative-sqlite-sync | removed | specs/20260711T103822-server-authoritative-sqlite-sync.md |
| 2026-07-10 | epicenter-v8-desktop-release-transition | in tree | specs/20260710T115550-epicenter-v8-desktop-release-transition.md |
| 2026-07-10 | whispering-epicenter-capability-collapse | removed | specs/20260710T230000-whispering-epicenter-capability-collapse.md |
| 2026-07-09 | epicenter-desktop-host-production-integration | removed | specs/20260709T230000-epicenter-desktop-host-production-integration.md |
| 2026-07-09 | rdev-tier1-keyboard-runtime-decision | removed | apps/whispering/specs/20260709T010000-rdev-tier1-keyboard-runtime-decision.md |
| 2026-07-09 | provider-app-and-empty-launch | removed | apps/local-mail/specs/20260709-provider-app-and-empty-launch.md |
| 2026-07-08 | host-discovery-connect-device | removed | apps/super-chat/specs/host-discovery-connect-device.md |
| 2026-07-07 | super-chat-attach-relay-proof | removed | specs/20260707T200000-super-chat-attach-relay-proof.md |
| 2026-07-06 | cli-watcher-ipc-collapse | in tree | specs/20260706T183000-cli-watcher-ipc-collapse.md |
| 2026-07-06 | cross-device-coordination-vision | in tree | specs/20260706T220000-cross-device-coordination-vision.md |
| 2026-07-06 | encrypted-job-envelope-strategy | in tree | specs/20260706T233000-encrypted-job-envelope-strategy.md |
| 2026-07-06 | super-chat-direct-command-forms | in tree | specs/super-chat-direct-command-forms.md |
| 2026-07-06 | skill-clean-breaks-agent-handoff | removed | specs/20260706T125841-skill-clean-breaks-agent-handoff.md |
| 2026-07-03 | transcription-selector-post-gguf-reconciliation | removed | apps/whispering/specs/20260703T170000-transcription-selector-post-gguf-reconciliation.md |
| 2026-07-02 | local-models-huggingface-transcribe-cpp | removed | apps/whispering/specs/20260702T120000-local-models-huggingface-transcribe-cpp.md |
| 2026-07-02 | local-mail-phase-3-write-through | removed | specs/20260702T211500-local-mail-phase-3-write-through.md |
| 2026-07-02 | daemon-role-after-relay-channel-deletion | removed | specs/20260702T233000-daemon-role-after-relay-channel-deletion.md |
| 2026-07-02 | identity-is-the-partition | removed | specs/20260702T000000-identity-is-the-partition.md |
| 2026-07-02 | relay-channel-layer-deletion | removed | specs/20260702T210000-relay-channel-layer-deletion.md |
| 2026-07-02 | ungated-durable-local-open | removed | specs/20260702T014940-ungated-durable-local-open.md |
| 2026-07-02 | one-preset-shape-and-derived-migration-guids | removed | specs/20260702T001604-one-preset-shape-and-derived-migration-guids.md |
| 2026-07-01 | honeycrisp-desktop-notes | in tree | specs/20260701T141841-honeycrisp-desktop-notes.md |
| 2026-07-01 | local-mail-up-bun-served-shell | removed | specs/20260701T141500-local-mail-up-bun-served-shell.md |
| 2026-07-01 | super-chat-canonicalization-handoff | removed | specs/20260701T235243-super-chat-canonicalization-handoff.md |
| 2026-07-01 | local-mail-phase-2-engine | removed | specs/20260701T140000-local-mail-phase-2-engine.md |
| 2026-07-01 | api-keyring-and-vault-wiring | removed | specs/20260701T150000-api-keyring-and-vault-wiring.md |
| 2026-07-01 | progressive-sign-in-collapse | removed | specs/20260701T151347-progressive-sign-in-collapse.md |
| 2026-07-01 | progressive-sign-in-collapse.prompt | removed | specs/20260701T151347-progressive-sign-in-collapse.prompt.md |
| 2026-07-01 | blobs-are-a-url-machine | removed | specs/20260701T150659-blobs-are-a-url-machine.md |
| 2026-07-01 | whispering-cloud-sync-remainder | removed | apps/whispering/specs/20260701T120000-whispering-cloud-sync-remainder.md |
| 2026-06-30 | cross-device-topology-seam-2-the-rule | in tree | specs/20260630T173000-cross-device-topology-seam-2-the-rule.md |
| 2026-06-30 | super-app-desktop-host-build-plan | removed | specs/20260630T190000-super-app-desktop-host-build-plan.md |
| 2026-06-30 | local-mail-tauri-cdc-mirror.handoff | removed | specs/20260630T150000-local-mail-tauri-cdc-mirror.handoff.md |
| 2026-06-30 | local-mail-tauri-cdc-mirror | removed | specs/20260630T150000-local-mail-tauri-cdc-mirror.md |
| 2026-06-30 | capability-plane-greenfield-buildout | removed | specs/20260630T120000-capability-plane-greenfield-buildout.md |
| 2026-06-28 | voice-cursor-intent-in-context | in tree | apps/whispering/specs/20260628T003033-voice-cursor-intent-in-context.md |
| 2026-06-27 | matter-editable-views | in tree | docs/specs/20260627T231500-matter-editable-views.md |
| 2026-06-27 | vocab-terms-layer | removed | specs/20260627T221709-vocab-terms-layer.md |
| 2026-06-27 | extract-recorder-vad-package | removed | specs/20260627T005829-extract-recorder-vad-package.md |
| 2026-06-27 | vocab-words-layer | removed | specs/20260627T221709-vocab-words-layer.md |
| 2026-06-27 | credential-identity-and-shared-secrets-facade | removed | specs/20260627T230812-credential-identity-and-shared-secrets-facade.md |
| 2026-06-27 | whispering-optional-unified-auth | removed | specs/20260627T221642-whispering-optional-unified-auth.md |
| 2026-06-27 | per-person-account-doc-device-layer | removed | specs/20260627T233000-per-person-account-doc-device-layer.md |
| 2026-06-27 | super-chat-device-gateway-collapse | removed | specs/20260627T200000-super-chat-device-gateway-collapse.md |
| 2026-06-27 | super-chat-cross-device-iroh | removed | specs/20260627T120000-super-chat-cross-device-iroh.md |
| 2026-06-26 | local-books-mcp-and-super-chat.handoff | removed | specs/20260626T194408-local-books-mcp-and-super-chat.handoff.md |
| 2026-06-26 | local-books-mcp-and-super-chat | removed | specs/20260626T194408-local-books-mcp-and-super-chat.md |
| 2026-06-25 | cli-and-headless-credential-seam-for-self-host | in tree | specs/20260625T132139-cli-and-headless-credential-seam-for-self-host.md |
| 2026-06-25 | capability-decomposition-star-service-library | removed | specs/20260625T224402-capability-decomposition-star-service-library.md |
| 2026-06-25 | capability-decomposition.handoff | removed | specs/20260625T224402-capability-decomposition.handoff.md |
| 2026-06-25 | self-host-first-boot-bearer-credential-source | removed | specs/20260625T115427-self-host-first-boot-bearer-credential-source.md |
| 2026-06-25 | bun-adapter-startbunserver-and-authenticate-rename | removed | specs/20260625T111606-bun-adapter-startbunserver-and-authenticate-rename.md |
| 2026-06-25 | matter-sqlite-launch | removed | specs/20260625T143000-matter-sqlite-launch.md |
| 2026-06-24 | privacy-is-a-deployment-self-host-and-relay-anchor-gradations | in tree | specs/20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md |
| 2026-06-24 | inference-endpoint-primitive | removed | specs/20260624T003125-inference-endpoint-primitive.md |
| 2026-06-23 | one-server-runtime-port-vs-per-owner-instance | in tree | specs/20260623T234500-one-server-runtime-port-vs-per-owner-instance.md |
| 2026-06-23 | content-addressed-blob-store | removed | specs/20260623T220000-content-addressed-blob-store.md |
| 2026-06-23 | inference-connections-and-presets | removed | specs/20260623T120000-inference-connections-and-presets.md |
| 2026-06-22 | chat-settle-render-and-romanizer | removed | specs/20260622T205500-chat-settle-render-and-romanizer.md |
| 2026-06-22 | push-to-talk-recording-lifecycle | removed | apps/whispering/specs/20260622T214212-push-to-talk-recording-lifecycle.md |
| 2026-06-21 | local-books-cli-sync-engine | in tree | specs/20260621T100000-local-books-cli-sync-engine.md |
| 2026-06-21 | inference-server-openai-compatible-collapse | removed | specs/20260621T180000-inference-server-openai-compatible-collapse.md |
| 2026-06-20 | transcription-model-selector-collapse | removed | apps/whispering/specs/20260620T173000-transcription-model-selector-collapse.md |
| 2026-06-20 | local-books-agent-over-sql | removed | specs/20260620T180000-local-books-agent-over-sql.md |
| 2026-06-20 | vocab-answerer-collapse | removed | specs/20260620T000000-vocab-answerer-collapse.md |
| 2026-06-20 | daemon-inference-backend-priority-chain | removed | specs/20260620T050257-daemon-inference-backend-priority-chain.md |
| 2026-06-19 | collapse-inference-onto-tanstack-adapters | removed | specs/20260619T210000-collapse-inference-onto-tanstack-adapters.md |
| 2026-06-19 | matter-json-marks-a-table | removed | apps/matter/specs/20260619T100000-matter-json-marks-a-table.md |
| 2026-06-18 | chat-transcript-parts-body | removed | specs/20260618T100631-chat-transcript-parts-body.md |
| 2026-06-18 | cloud-kickoff-to-queue-generation | removed | specs/20260618T160358-cloud-kickoff-to-queue-generation.md |
| 2026-06-18 | dictation-feedback-projection | removed | apps/whispering/specs/20260618T120000-dictation-feedback-projection.md |
| 2026-06-18 | playback-pause-speaking-window | removed | apps/whispering/specs/20260618T113342-playback-pause-speaking-window.md |
| 2026-06-18 | one-conversation-core-loop-and-doc-sink | removed | specs/20260618T113407-one-conversation-core-loop-and-doc-sink.md |
| 2026-06-18 | keyboard-tap-foundation-research | removed | apps/whispering/specs/20260618T000000-keyboard-tap-foundation-research.md |
| 2026-06-17 | v2-coding-worker-sandbox-and-harness | in tree | specs/20260617T235900-v2-coding-worker-sandbox-and-harness.md |
| 2026-06-17 | brand-asset-pipeline | removed | specs/20260617T100000-brand-asset-pipeline.md |
| 2026-06-17 | zhongwen-daemon-and-v0-exit | removed | specs/20260617T224538-zhongwen-daemon-and-v0-exit.md |
| 2026-06-17 | desktop-audio-pipeline-greenfield | removed | apps/whispering/specs/20260617T170000-desktop-audio-pipeline-greenfield.md |
| 2026-06-17 | table-vault-classification | removed | apps/matter/specs/20260617T152631-table-vault-classification.md |
| 2026-06-17 | v2-coding-actor-sandbox-and-harness | removed | specs/20260617T235900-v2-coding-actor-sandbox-and-harness.md |
| 2026-06-16 | cloudless-home-anchor-direction | in tree | specs/20260616T185740-cloudless-home-anchor-direction.md |
| 2026-06-16 | always-on-workers-over-synced-docs | in tree | specs/20260616T225034-always-on-workers-over-synced-docs.md |
| 2026-06-16 | workers-buildout.tracker | in tree | specs/20260616T225034-workers-buildout.tracker.md |
| 2026-06-16 | pause-playback-while-recording | removed | apps/whispering/specs/20260616T180000-pause-playback-while-recording.md |
| 2026-06-16 | always-on-actors-over-synced-docs | removed | specs/20260616T225034-always-on-actors-over-synced-docs.md |
| 2026-06-16 | actors-buildout.tracker | removed | specs/20260616T225034-actors-buildout.tracker.md |
| 2026-06-16 | cleanup-and-portable-formats-greenfield | removed | specs/20260616T230000-cleanup-and-portable-formats-greenfield.md |
| 2026-06-16 | cleanup-and-portable-formats-greenfield | removed | apps/whispering/specs/20260616T230000-cleanup-and-portable-formats-greenfield.md |
| 2026-06-16 | cli-action-invocation-design-pass | removed | specs/20260616T120641-cli-action-invocation-design-pass.md |
| 2026-06-16 | rust-owns-models-folder | removed | apps/whispering/specs/20260616T170000-rust-owns-models-folder.md |
| 2026-06-16 | vault-as-relational-unit | removed | apps/matter/specs/20260616T075253-vault-as-relational-unit.md |
| 2026-06-15 | trusted-relay-and-collaborative-fields | in tree | specs/20260615T120000-trusted-relay-and-collaborative-fields.md |
| 2026-06-15 | row-childdocs-greenfield-redesign | removed | specs/20260615T210000-row-childdocs-greenfield-redesign.md |
| 2026-06-14 | local-model-disk-identity | in tree | apps/whispering/specs/local-model-disk-identity.md |
| 2026-06-14 | model-lifecycle-lazy-collapse | in tree | apps/whispering/specs/model-lifecycle-lazy-collapse.md |
| 2026-06-14 | app-folder-as-root-and-jsrepo-blocks | in tree | specs/20260614T120000-app-folder-as-root-and-jsrepo-blocks.md |
| 2026-06-14 | zero-knowledge-relay-and-collaborative-fields | in tree | specs/20260614T160000-zero-knowledge-relay-and-collaborative-fields.md |
| 2026-06-14 | landing-ecosystem-realignment | removed | specs/20260614T180000-landing-ecosystem-realignment.md |
| 2026-06-14 | vocab-pronunciation-stt-tts-research | removed | specs/20260614T022000-vocab-pronunciation-stt-tts-research.md |
| 2026-06-14 | vocab-two-boats-conversation-and-dictionary | removed | specs/20260614T022000-vocab-two-boats-conversation-and-dictionary.md |
| 2026-06-13 | epicenter-todos-first-slice | in tree | specs/20260613T224526-epicenter-todos-first-slice.md |
| 2026-06-13 | whispering-local-model-download-rust | in tree | specs/20260613T234711-whispering-local-model-download-rust.md |
| 2026-06-13 | whispering-desktop-rdev-trigger-backend | removed | apps/whispering/specs/20260613T094454-whispering-desktop-rdev-trigger-backend.md |
| 2026-06-13 | vocab-acquisition-through-use | removed | specs/20260613T211000-vocab-acquisition-through-use.md |
| 2026-06-13 | auth-optional-daemon-startup | removed | specs/20260613T113938-auth-optional-daemon-startup.md |
| 2026-06-13 | vault-of-apps-and-jsrepo-distribution | removed | specs/20260613T210000-vault-of-apps-and-jsrepo-distribution.md |
| 2026-06-13 | action-first-daemon-runtime | removed | specs/20260613T100235-action-first-daemon-runtime.md |
| 2026-06-13 | projection-read-only-hardening | removed | specs/20260613T030000-projection-read-only-hardening.md |
| 2026-06-12 | landing-page-public-realignment | in tree | specs/20260612T063520-landing-page-public-realignment.md |
| 2026-06-12 | whispering-custom-backend-profiles | in tree | specs/20260612T091000-whispering-custom-backend-profiles.md |
| 2026-06-12 | whispering-pipelines-workspace-boundary | in tree | specs/20260612T110000-whispering-pipelines-workspace-boundary.md |
| 2026-06-12 | local-model-recommended-defaults-rebuild | in tree | specs/20260612T164300-local-model-recommended-defaults-rebuild.md |
| 2026-06-12 | zhongwen-conversation-deletion-refusal | in tree | specs/zhongwen-conversation-deletion-refusal.md |
| 2026-06-12 | workspace-schema-conformance.handoff | removed | specs/20260612T182447-workspace-schema-conformance.handoff.md |
| 2026-06-12 | workspace-schema-conformance | removed | specs/20260612T182447-workspace-schema-conformance.md |
| 2026-06-12 | table-read-surface.handoff | removed | specs/20260612T193000-table-read-surface.handoff.md |
| 2026-06-12 | epicenter-namespace-root-layout | removed | specs/20260612T000201-epicenter-namespace-root-layout.md |
| 2026-06-12 | table-read-surface | removed | specs/20260612T193000-table-read-surface.md |
| 2026-06-12 | zhongwen-chat-doc-as-wire | removed | specs/20260612T182359-zhongwen-chat-doc-as-wire.md |
| 2026-06-12 | whispering-transformation-engine-collapse | removed | specs/20260612T210000-whispering-transformation-engine-collapse.md |
| 2026-06-12 | whispering-providers-clean-break | removed | specs/20260612T090000-whispering-providers-clean-break.md |
| 2026-06-12 | whispering-endpoint-config-consolidation | removed | specs/20260612T081337-whispering-endpoint-config-consolidation.md |
| 2026-06-10 | cli-daemon-collapse-waves | in tree | specs/20260610T193000-cli-daemon-collapse-waves.md |
| 2026-06-10 | matter-optional-fields | in tree | specs/20260610T193727-matter-optional-fields.md |
| 2026-06-10 | root-readme-public-front-door | removed | specs/20260610T173324-root-readme-public-front-door.md |
| 2026-06-10 | matter-zennotes-folder-protocol | removed | specs/20260610T174336-matter-zennotes-folder-protocol.md |
| 2026-06-10 | matter-check-output | removed | specs/20260610T185441-matter-check-output.md |
| 2026-06-10 | matter-cli-namespace-decision | removed | specs/20260610T185221-matter-cli-namespace-decision.md |
| 2026-06-07 | matter-note-identity-and-linking | removed | specs/20260607T150000-matter-note-identity-and-linking.md |
| 2026-06-06 | matter-grid-keyboard-navigation | in tree | specs/20260606T104553-matter-grid-keyboard-navigation.md |
| 2026-06-06 | ui-shadcn-cn-style-migration-vega | in tree | specs/20260606T160000-ui-shadcn-cn-style-migration-vega.md |
| 2026-06-06 | matter-multi-vault-routing | removed | specs/20260606T163601-matter-multi-vault-routing.md |
| 2026-06-06 | email-client-architecture | removed | specs/20260606T114052-email-client-architecture.md |
| 2026-06-06 | collapse-column-into-field | removed | specs/20260606T120000-collapse-column-into-field.md |
| 2026-06-05 | sqlite-projection-primitives | in tree | specs/20260605T214500-sqlite-projection-primitives.md |
| 2026-06-05 | matter-live-projection-lifecycle | removed | specs/20260605T145734-matter-live-projection-lifecycle.md |
| 2026-06-05 | field-vocabulary-convergence | removed | apps/matter/specs/20260605T071500-field-vocabulary-convergence.md |
| 2026-06-04 | typed-markdown-grid-editor | in tree | specs/20260604T120000-typed-markdown-grid-editor.md |
| 2026-06-04 | matter-field-palette-and-conformance | in tree | specs/20260604T223000-matter-field-palette-and-conformance.md |
| 2026-06-03 | capture-to-post-minimal-content-pipeline | in tree | specs/20260603T010000-capture-to-post-minimal-content-pipeline.md |
| 2026-06-03 | second-brain-publishing-contract | in tree | specs/20260603T120000-second-brain-publishing-contract.md |
| 2026-06-03 | agents-read-projection-write-actions | removed | specs/20260603T164627-agents-read-projection-write-actions.md |
| 2026-06-03 | wiki-pages-and-tags | removed | specs/20260603T180000-wiki-pages-and-tags.md |
| 2026-06-02 | wiki-core-collections-traits-and-curation | in tree | specs/20260602T120000-wiki-core-collections-traits-and-curation.md |
| 2026-06-02 | composable-apps-islands-hosts-and-capabilities | in tree | specs/20260602T233000-composable-apps-islands-hosts-and-capabilities.md |
| 2026-06-02 | the-ark-anti-slop-doctrine | in tree | specs/20260602T235900-the-ark-anti-slop-doctrine.md |
| 2026-06-02 | cloud-sync-and-account | removed | apps/whispering/specs/20260602T140000-cloud-sync-and-account.md |
| 2026-06-02 | markdown-body-import-bidirectional | removed | specs/20260602T120000-markdown-body-import-bidirectional.md |
| 2026-06-02 | vault-read-only-projection-agent-mutation | removed | specs/20260602T200000-vault-read-only-projection-agent-mutation.md |
| 2026-06-01 | creative-os-stack-naming-and-drop-serialization | in tree | specs/20260601T120000-creative-os-stack-naming-and-drop-serialization.md |
| 2026-06-01 | epicenter-apply-markdown-reconcile | in tree | specs/20260601T120000-epicenter-apply-markdown-reconcile.md |
| 2026-06-01 | markdown-sync-greenfield | in tree | specs/20260601T160000-markdown-sync-greenfield.md |
| 2026-06-01 | personal-and-shared-wiki-rename | removed | specs/20260601T130000-personal-and-shared-wiki-rename.md |
| 2026-06-01 | portable-spa-same-origin-apps | removed | specs/20260601T121456-portable-spa-same-origin-apps.md |
| 2026-05-31 | prelaunch-reset-runbook | in tree | specs/20260531T205543-prelaunch-reset-runbook.md |
| 2026-05-30 | transcription-provider-registry | in tree | apps/whispering/specs/20260530T183000-transcription-provider-registry.md |
| 2026-05-30 | ai-workflows-consolidated-design | in tree | specs/20260530T100000-ai-workflows-consolidated-design.md |
| 2026-05-30 | uniform-per-doc-providers | in tree | specs/20260530T160000-uniform-per-doc-providers.md |
| 2026-05-30 | mit-identity-package-clean-break | removed | specs/20260530T170000-mit-identity-package-clean-break.md |
| 2026-05-30 | ai-workflows-reactive-vs-bulk-only | removed | specs/20260530T113000-ai-workflows-reactive-vs-bulk-only.md |
| 2026-05-30 | daemon-manifest-and-mount-materializers | removed | specs/20260530T120000-daemon-manifest-and-mount-materializers.md |
| 2026-05-30 | schema-declared-body-docs | removed | specs/20260530T180000-schema-declared-body-docs.md |
| 2026-05-30 | body-docs-clean-break | removed | specs/20260530T220000-body-docs-clean-break.md |
| 2026-05-30 | bodies-as-generic-doc-opener | removed | specs/20260530T230000-bodies-as-generic-doc-opener.md |
| 2026-05-30 | sound-cue-customization | removed | apps/whispering/specs/20260530T150000-sound-cue-customization.md |
| 2026-05-29 | ai-workflows-ux-grill-and-clean-break | in tree | specs/20260529T163000-ai-workflows-ux-grill-and-clean-break.md |
| 2026-05-29 | ai-workflows-triggers-portability-durable-execution | in tree | specs/20260529T190000-ai-workflows-triggers-portability-durable-execution.md |
| 2026-05-29 | recording-input-paths-clean-break | removed | apps/whispering/specs/20260529T000000-recording-input-paths-clean-break.md |
| 2026-05-29 | ai-workflows-bounded-programs | removed | specs/20260529T120000-ai-workflows-bounded-programs.md |
| 2026-05-29 | project-mount-local-resource-api | removed | specs/20260529T220000-project-mount-local-resource-api.md |
| 2026-05-29 | platform-dependency-injection-subpath-imports | removed | specs/20260529T230000-platform-dependency-injection-subpath-imports.md |
| 2026-05-28 | repo-history-cleanup-rehearsal | in tree | specs/20260528T000000-repo-history-cleanup-rehearsal.md |
| 2026-05-28 | config-force-mount-array | in tree | specs/20260528T121508-config-force-mount-array.md |
| 2026-05-28 | runtime-port-and-public-origin | in tree | specs/20260528T130000-runtime-port-and-public-origin.md |
| 2026-05-28 | auth-opaque-client-boundary | in tree | specs/20260528T211151-auth-opaque-client-boundary.md |
| 2026-05-28 | clean-reset-and-workspace-schema-collapse | in tree | specs/20260528T222820-clean-reset-and-workspace-schema-collapse.md |
| 2026-05-28 | jwks-signing-key-greenfield | in tree | specs/jwks-signing-key-greenfield.md |
| 2026-05-28 | omega-deployment-profiles | removed | specs/20260528T054721-omega-deployment-profiles.md |
| 2026-05-28 | deployment-collapse | removed | specs/20260528T145510-deployment-collapse.md |
| 2026-05-28 | autumn-billing-boundary-cleanup | removed | specs/20260528T132334-autumn-billing-boundary-cleanup.md |
| 2026-05-28 | desktop-agent-action-plans | removed | specs/20260528T221622-desktop-agent-action-plans.md |
| 2026-05-28 | platform-owned-recording | removed | apps/whispering/specs/20260528T000000-platform-owned-recording.md |
| 2026-05-28 | whispering-sound-cue-customization | removed | specs/20260528T074048-whispering-sound-cue-customization.md |
| 2026-05-27 | report-spine-prompts | in tree | apps/whispering/specs/20260527T001351-report-spine-prompts.md |
| 2026-05-27 | cloud-transcription-collapse | in tree | apps/whispering/specs/20260527T002843-cloud-transcription-collapse.md |
| 2026-05-27 | transcription-providers-from-first-principles | in tree | apps/whispering/specs/20260527T003910-transcription-providers-from-first-principles.md |
| 2026-05-27 | project-folders-and-control-plane-vision | in tree | specs/20260527T120000-project-folders-and-control-plane-vision.md |
| 2026-05-27 | auth-oauth-launcher-ownership-collapse | in tree | specs/20260527T193835-auth-oauth-launcher-ownership-collapse.md |
| 2026-05-27 | whispering-markdown-export-greenfield-grill | in tree | specs/20260527T210000-whispering-markdown-export-greenfield-grill.md |
| 2026-05-27 | report-spine-round2 | removed | apps/whispering/specs/20260527T001351-report-spine-round2.md |
| 2026-05-27 | report-spine | removed | apps/whispering/specs/20260527T001351-report-spine.md |
| 2026-05-27 | rust-transcription-service | removed | specs/20260527T120000-rust-transcription-service.md |
| 2026-05-27 | whispering-markdown-materializer-greenfield | removed | specs/20260527T180000-whispering-markdown-materializer-greenfield.md |
| 2026-05-27 | mount-level-git-autosave | removed | specs/20260527T235147-mount-level-git-autosave.md |
| 2026-05-27 | transcription-provider-architecture | removed | apps/whispering/specs/20260527T005608-transcription-provider-architecture.md |
| 2026-05-27 | transcription-raw-http | removed | apps/whispering/specs/20260527T012000-transcription-raw-http.md |
| 2026-05-26 | REPORT | in tree | apps/whispering/specs/2026-05-26-recorder-shape-investigation/REPORT.md |
| 2026-05-26 | replace-ffmpeg-with-symphonia-libopus | in tree | apps/whispering/specs/20260526T000000-replace-ffmpeg-with-symphonia-libopus.md |
| 2026-05-26 | feature-folder-reorganization | in tree | apps/whispering/specs/20260526T005233-feature-folder-reorganization.md |
| 2026-05-26 | tauri-specta-on-artifact-id-base | in tree | specs/20260526T220000-tauri-specta-on-artifact-id-base.md |
| 2026-05-26 | canonical-recorder | removed | apps/whispering/specs/20260526T150401-canonical-recorder.md |
| 2026-05-26 | build-time-platform-di | removed | apps/whispering/specs/20260526T010258-build-time-platform-di.md |
| 2026-05-26 | collapse-tauri-only-services-into-namespace | removed | specs/20260526T000140-collapse-tauri-only-services-into-namespace.md |
| 2026-05-26 | rust-transcription-service-boundary | removed | specs/20260526T034000-rust-transcription-service-boundary.md |
| 2026-05-25 | manual-recorder-state-refactor | in tree | docs/specs/20260525T220000-manual-recorder-state-refactor.md |
| 2026-05-25 | creative-os-composition-map | in tree | specs/20260525T130000-creative-os-composition-map.md |
| 2026-05-25 | materializer-tables-as-record | in tree | specs/20260525T134351-materializer-tables-as-record.md |
| 2026-05-25 | zoned-natural-language-date-input | in tree | specs/20260525T194400-zoned-natural-language-date-input.md |
| 2026-05-25 | workspace-primitive-bundle | in tree | specs/20260525T220511-workspace-primitive-bundle.md |
| 2026-05-25 | library-managed-row-version | removed | packages/workspace/specs/20260525T061910-library-managed-row-version.md |
| 2026-05-25 | sqlite-fts-primitive-split | removed | specs/20260525T212249-sqlite-fts-primitive-split.md |
| 2026-05-25 | row-versioning-in-envelope | removed | packages/workspace/specs/20260525T061910-row-versioning-in-envelope.md |
| 2026-05-24 | asset-visibility-and-client-sdk | in tree | specs/20260524T021140-asset-visibility-and-client-sdk.md |
| 2026-05-24 | centralize-route-paths | in tree | specs/20260524T153612-centralize-route-paths.md |
| 2026-05-24 | centralize-c-json-error-responses | removed | specs/20260524T100110-centralize-c-json-error-responses.md |
| 2026-05-23 | greenfield-workspace-encryption-boundary | in tree | specs/20260523T000000-greenfield-workspace-encryption-boundary.md |
| 2026-05-23 | collapse-owner-partition-honest-ids | removed | specs/20260523T160000-collapse-owner-partition-honest-ids.md |
| 2026-05-22 | revert-cloud-workspace-sync-layer | in tree | specs/20260522T160000-revert-cloud-workspace-sync-layer.md |
| 2026-05-22 | modernize-monorepo-tsconfig | in tree | specs/20260522T190000-modernize-monorepo-tsconfig.md |
| 2026-05-22 | cloud-workspace-ownership-model | in tree | specs/20260522T200000-cloud-workspace-ownership-model.md |
| 2026-05-22 | api-runtime-portability | in tree | specs/20260522T220000-api-runtime-portability.md |
| 2026-05-22 | cloud-asset-access-model | in tree | specs/20260522T240000-cloud-asset-access-model.md |
| 2026-05-22 | greenfield-pass | in tree | specs/goals/greenfield-pass.md |
| 2026-05-22 | server-package-split | removed | specs/20260522T230000-server-package-split.md |
| 2026-05-22 | collapse-http-dispatch-onto-the-socket | removed | specs/20260522T180000-collapse-http-dispatch-onto-the-socket.md |
| 2026-05-22 | top-level-epicenter-path-cleanup | removed | specs/20260522T203209-top-level-epicenter-path-cleanup.md |
| 2026-05-22 | workspace-project-layout | removed | specs/20260522T220000-workspace-project-layout.md |
| 2026-05-22 | cloud-asset-encryption-model | removed | specs/20260522T230000-cloud-asset-encryption-model.md |
| 2026-05-21 | auth-identity-and-workspace-access-discussion | in tree | specs/20260521T093824-auth-identity-and-workspace-access-discussion.md |
| 2026-05-21 | server-owned-presence | in tree | specs/20260521T121500-server-owned-presence.md |
| 2026-05-21 | cloud-sync-direction-decision | removed | specs/20260521T120000-cloud-sync-direction-decision.md |
| 2026-05-21 | server-default-workspace-route | removed | specs/20260521T160000-server-default-workspace-route.md |
| 2026-05-21 | presence-full-list-collapse | removed | specs/20260521T180000-presence-full-list-collapse.md |
| 2026-05-21 | cloud-workspace-app-sync-factory | removed | specs/20260521T103857-cloud-workspace-app-sync-factory.md |
| 2026-05-20 | workspace-portability-design-brief | in tree | specs/20260520T130000-workspace-portability-design-brief.md |
| 2026-05-20 | cloud-workspaces-and-organizations-clean-break | in tree | specs/20260520T170000-cloud-workspaces-and-organizations-clean-break.md |
| 2026-05-20 | workspace-capsule-clean-break | removed | specs/20260520T001032-workspace-capsule-clean-break.md |
| 2026-05-20 | epicenter-sync-engine-host-composition | removed | specs/20260520T114537-epicenter-sync-engine-host-composition.md |
| 2026-05-20 | code-composed-daemon-route-map | removed | specs/20260520T120000-code-composed-daemon-route-map.md |
| 2026-05-20 | cloud-workspace-app-instance-clean-break | removed | specs/20260520T190000-cloud-workspace-app-instance-clean-break.md |
| 2026-05-20 | collapse-oauth-resource-scope | removed | specs/20260520T221026-collapse-oauth-resource-scope.md |
| 2026-05-19 | shared-result-test-helpers | in tree | specs/20260519T080853-shared-result-test-helpers.md |
| 2026-05-19 | epicenter-project-as-first-class | in tree | specs/20260519T150000-epicenter-project-as-first-class.md |
| 2026-05-19 | workspace-noun-clean-break | in tree | specs/20260519T155705-workspace-noun-clean-break.md |
| 2026-05-19 | 01-workspace-apps-audit.prompt | in tree | specs/20260519T161500-config-route-collapse-pass/01-workspace-apps-audit.prompt.md |
| 2026-05-19 | 02-client-cli-audit.prompt | in tree | specs/20260519T161500-config-route-collapse-pass/02-client-cli-audit.prompt.md |
| 2026-05-19 | 03-docs-api-surface-audit.prompt | in tree | specs/20260519T161500-config-route-collapse-pass/03-docs-api-surface-audit.prompt.md |
| 2026-05-19 | 04-implementation.prompt | in tree | specs/20260519T161500-config-route-collapse-pass/04-implementation.prompt.md |
| 2026-05-19 | client-cli | in tree | specs/20260519T161500-config-route-collapse-pass/reports/client-cli.md |
| 2026-05-19 | docs-api-surface | in tree | specs/20260519T161500-config-route-collapse-pass/reports/docs-api-surface.md |
| 2026-05-19 | implementation | in tree | specs/20260519T161500-config-route-collapse-pass/reports/implementation.md |
| 2026-05-19 | workspace-apps | in tree | specs/20260519T161500-config-route-collapse-pass/reports/workspace-apps.md |
| 2026-05-19 | realm-boundary-clean-break | in tree | specs/20260519T231845-realm-boundary-clean-break.md |
| 2026-05-19 | api-session-clean-break | removed | specs/20260519T085954-api-session-clean-break.md |
| 2026-05-19 | epicenter-project-root-single-marker | removed | specs/20260519T113632-epicenter-project-root-single-marker.md |
| 2026-05-19 | subject-principal-surface | removed | specs/20260519T160000-subject-principal-surface.md |
| 2026-05-18 | theark-marp-shortform-content-engine | in tree | specs/20260518T160639-theark-marp-shortform-content-engine.md |
| 2026-05-18 | live-device-dispatch | removed | specs/20260518T000000-live-device-dispatch.md |
| 2026-05-18 | skill-discovery-reference-decomposition | removed | specs/20260518T233702-skill-discovery-reference-decomposition.md |
| 2026-05-17 | old-worktree-triage | in tree | specs/20260517T000000-old-worktree-triage.md |
| 2026-05-17 | portal-and-auth-collapse | removed | specs/20260517T230000-portal-and-auth-collapse.md |
| 2026-05-17 | cli-api-base-url-configuration | removed | specs/20260517T212330-cli-api-base-url-configuration.md |
| 2026-05-16 | session-owned-subject-owner-boundary | in tree | specs/20260516T120000-session-owned-subject-owner-boundary.md |
| 2026-05-16 | hosted-apps-with-optional-daemon-extensions | in tree | specs/20260516T130000-hosted-apps-with-optional-daemon-extensions.md |
| 2026-05-16 | folder-routed-daemon-extensions | removed | specs/20260516T180000-folder-routed-daemon-extensions.md |
| 2026-05-15 | latest-spec-orchestration-guide | in tree | specs/20260515T000000-latest-spec-orchestration-guide.md |
| 2026-05-15 | auth-canonical-path-audit | in tree | specs/20260515T010000-auth-canonical-path-audit.md |
| 2026-05-15 | auth-post-oob-collapse-audit | in tree | specs/20260515T010000-auth-post-oob-collapse-audit.md |
| 2026-05-15 | daemon-run-ownership-map | removed | specs/20260515T120000-daemon-run-ownership-map.md |
| 2026-05-15 | daemon-run-clean-break | removed | specs/20260515T140000-daemon-run-clean-break.md |
| 2026-05-15 | logger-vision | removed | specs/20260515T081145-logger-vision.md |
| 2026-05-15 | folder-routed-daemon-workspaces-clean-break | removed | specs/20260515T160000-folder-routed-daemon-workspaces-clean-break.md |
| 2026-05-15 | subject-owner-boundary | removed | specs/20260515T172411-subject-owner-boundary.md |
| 2026-05-14 | source-app-manifest-bridge-slice | in tree | specs/20260514T013918-source-app-manifest-bridge-slice.md |
| 2026-05-14 | id-token-bearing-encryption-keys | in tree | specs/20260514T154500-id-token-bearing-encryption-keys.md |
| 2026-05-14 | execute-id-token-and-oob-cli | in tree | specs/20260514T160000-execute-id-token-and-oob-cli.md |
| 2026-05-14 | script-surfaces-resolution | in tree | specs/20260514T160000-script-surfaces-resolution.md |
| 2026-05-14 | self-host-first-class | in tree | specs/20260514T220000-self-host-first-class.md |
| 2026-05-14 | actions-docs-rewrite-tier2 | removed | specs/20260514T000000-actions-docs-rewrite-tier2.md |
| 2026-05-14 | collapse-oauth-client-into-auth | removed | specs/20260514T071306-collapse-oauth-client-into-auth.md |
| 2026-05-14 | tokens-only-auth-extract-identity-to-workspace | removed | specs/20260514T091255-tokens-only-auth-extract-identity-to-workspace.md |
| 2026-05-14 | machine-auth-oob-clean-break | removed | specs/20260514T120000-machine-auth-oob-clean-break.md |
| 2026-05-14 | single-daemon-multi-workspace | removed | specs/20260514T170000-single-daemon-multi-workspace.md |
| 2026-05-14 | api-me-three-field-token-bundle | removed | specs/20260514T200000-api-me-three-field-token-bundle.md |
| 2026-05-14 | execute-oob-cli-phases-3-4 | removed | specs/20260514T210000-execute-oob-cli-phases-3-4.md |
| 2026-05-14 | profile-as-application-data | removed | specs/20260514T210000-profile-as-application-data.md |
| 2026-05-13 | tauri-specta-bindings | in tree | specs/20260513T105808-tauri-specta-bindings.md |
| 2026-05-13 | explicit-app-constructor-layers | in tree | specs/20260513T180000-explicit-app-constructor-layers.md |
| 2026-05-13 | schema-on-npm-runtime-on-jsrepo | in tree | specs/20260513T190000-schema-on-npm-runtime-on-jsrepo.md |
| 2026-05-13 | open-workspace-clean-break | removed | specs/20260513T083755-open-workspace-clean-break.md |
| 2026-05-13 | workspace-surface-clean-break-vision | removed | specs/20260513T200000-workspace-surface-clean-break-vision.md |
| 2026-05-13 | document-sync-and-identity-collapse | removed | specs/20260513T220000-document-sync-and-identity-collapse.md |
| 2026-05-13 | collaboration-runtime-protocol-plane | removed | specs/20260513T113208-collaboration-runtime-protocol-plane.md |
| 2026-05-13 | action-runtime-one-envelope | removed | specs/20260513T120000-action-runtime-one-envelope.md |
| 2026-05-13 | actions-path-first-clean-break | removed | specs/20260513T210000-actions-path-first-clean-break.md |
| 2026-05-13 | collaboration-identity-roster-clean-break | removed | specs/20260513T210000-collaboration-identity-roster-clean-break.md |
| 2026-05-13 | actions-snake-case-only-no-dots | removed | specs/20260513T231157-actions-snake-case-only-no-dots.md |
| 2026-05-13 | session-encryption-keys-collapse | removed | specs/20260513T233700-session-encryption-keys-collapse.md |
| 2026-05-13 | define-actions-typed-key-validation | removed | specs/20260513T233714-define-actions-typed-key-validation.md |
| 2026-05-13 | rpc-on-yjs-state | removed | specs/20260513T235000-rpc-on-yjs-state.md |
| 2026-05-12 | app-side-oauth-migration | in tree | specs/20260512T100428-app-side-oauth-migration.md |
| 2026-05-12 | post-oauth-audit-remediation | in tree | specs/20260512T111335-post-oauth-audit-remediation.md |
| 2026-05-12 | auth-token-capability-boundary.clean-break-eval.prompt | in tree | specs/20260512T114350-auth-token-capability-boundary.clean-break-eval.prompt.md |
| 2026-05-12 | auth-token-capability-boundary | in tree | specs/20260512T114350-auth-token-capability-boundary.md |
| 2026-05-12 | post-oauth-invariant-patch.handoff.prompt | in tree | specs/20260512T133954-post-oauth-invariant-patch.handoff.prompt.md |
| 2026-05-12 | auth-spec-stack-clean-break-map | in tree | specs/20260512T134603-auth-spec-stack-clean-break-map.md |
| 2026-05-12 | epicenter-deployment-product-contract | in tree | specs/20260512T135159-epicenter-deployment-product-contract.md |
| 2026-05-12 | cloud-modules-and-networks | in tree | specs/20260512T150000-cloud-modules-and-networks.md |
| 2026-05-12 | fuji-signed-in-route-boundary.grill.prompt | in tree | specs/20260512T153000-fuji-signed-in-route-boundary.grill.prompt.md |
| 2026-05-12 | fuji-signed-in-route-boundary | in tree | specs/20260512T153000-fuji-signed-in-route-boundary.md |
| 2026-05-12 | async-storage-and-build-unification | in tree | specs/20260512T161042-async-storage-and-build-unification.md |
| 2026-05-12 | session-two-axis-cohesive-reshape.handoff.prompt | in tree | specs/20260512T220000-session-two-axis-cohesive-reshape.handoff.prompt.md |
| 2026-05-12 | source-installed-app-runtime-vision | in tree | specs/20260512T234944-source-installed-app-runtime-vision.md |
| 2026-05-12 | session-two-axis-cohesive-reshape | removed | specs/20260512T220000-session-two-axis-cohesive-reshape.md |
| 2026-05-12 | cli-daemon-command-clean-break | removed | specs/20260512T222257-cli-daemon-command-clean-break.md |
| 2026-05-12 | generic-yjs-sync-rooms-and-checkpoints | removed | specs/20260512T230000-generic-yjs-sync-rooms-and-checkpoints.md |
| 2026-05-11 | item-tagging-schema | in tree | specs/20260511T111700-item-tagging-schema.md |
| 2026-05-11 | remote-storage-control-plane | in tree | specs/20260511T115110-remote-storage-control-plane.md |
| 2026-05-11 | final-oauth-auth-architecture | in tree | specs/20260511T150000-final-oauth-auth-architecture.md |
| 2026-05-11 | dev-script-conventions | removed | specs/20260511T000000-dev-script-conventions.md |
| 2026-05-11 | auth-credential-families-minimal-production | removed | specs/20260511T090000-auth-credential-families-minimal-production.md |
| 2026-05-11 | auth-hosted-sign-in-clean-break | removed | specs/20260511T092357-auth-hosted-sign-in-clean-break.md |
| 2026-05-11 | auth-oauth-everywhere-clean-break | removed | specs/20260511T105846-auth-oauth-everywhere-clean-break.md |
| 2026-05-11 | auth-core-state-collapse | removed | specs/20260511T140228-auth-core-state-collapse.md |
| 2026-05-11 | accounts-origin-auth-server-clean-break | removed | specs/20260511T141800-accounts-origin-auth-server-clean-break.md |
| 2026-05-10 | auth-contracts-arktype-morphs | in tree | specs/20260510T230000-auth-contracts-arktype-morphs.md |
| 2026-05-10 | platform-google-sign-in | removed | specs/20260510T120000-platform-google-sign-in.md |
| 2026-05-10 | ui-native-package-imports | removed | specs/20260510T070722-ui-native-package-imports.md |
| 2026-05-08 | cloudflare-baseline | removed | specs/20260508T-cloudflare-baseline.md |
| 2026-05-08 | ui-import-boundary-clean-break | removed | specs/20260508T000000-ui-import-boundary-clean-break.md |
| 2026-05-07 | opensidian-tab-manager-create-session | in tree | specs/20260507T054727-opensidian-tab-manager-create-session.md |
| 2026-05-07 | honeycrisp-state-namespace-clean-break | removed | specs/20260507T013000-honeycrisp-state-namespace-clean-break.md |
| 2026-05-07 | drop-context-module-helper | removed | specs/20260507T080000-drop-context-module-helper.md |
| 2026-05-07 | workspace-app-layout-skill-realign | removed | specs/20260507T080909-workspace-app-layout-skill-realign.md |
| 2026-05-07 | bearer-auth-session-storage-adapter | removed | specs/20260507T150000-bearer-auth-session-storage-adapter.md |
| 2026-05-07 | bearer-client-omit-internal-cookies | removed | specs/20260507T151049-bearer-client-omit-internal-cookies.md |
| 2026-05-07 | honeycrisp-platform-auth-modes | removed | specs/20260507T151100-honeycrisp-platform-auth-modes.md |
| 2026-05-07 | workspace-gate-forget-device-recovery | removed | specs/20260507T161218-workspace-gate-forget-device-recovery.md |
| 2026-05-07 | lazy-signed-in-session-reader | removed | specs/20260507T080000-lazy-signed-in-session-reader.md |
| 2026-05-06 | signed-in-owns-the-workspace | in tree | specs/20260506T010807-signed-in-owns-the-workspace.md |
| 2026-05-06 | encryption-keys-clean-break.execute | in tree | specs/20260506T183459-encryption-keys-clean-break.execute.md |
| 2026-05-06 | from-table-readonly-view-redesign | removed | specs/20260506T123741-from-table-readonly-view-redesign.md |
| 2026-05-06 | session-state-replaces-signed-in-component | removed | specs/20260506T013348-session-state-replaces-signed-in-component.md |
| 2026-05-06 | expose-attachments-not-aliases | removed | specs/20260506T020000-expose-attachments-not-aliases.md |
| 2026-05-06 | lazy-identity-reads-from-auth | removed | specs/20260506T143000-lazy-identity-reads-from-auth.md |
| 2026-05-06 | encryption-keys-clean-break | removed | specs/20260506T183459-encryption-keys-clean-break.md |
| 2026-05-05 | auth-state-machine-and-gated-identity-context | in tree | specs/20260505T080000-auth-state-machine-and-gated-identity-context.md |
| 2026-05-05 | attach-encrypted-indexeddb | removed | specs/20260505T004755-attach-encrypted-indexeddb.md |
| 2026-05-05 | collapse-owner-scoping-onto-coordinator | removed | specs/20260505T020000-collapse-owner-scoping-onto-coordinator.md |
| 2026-05-05 | collapse-syncauth-to-transport-function | removed | specs/20260505T021500-collapse-syncauth-to-transport-function.md |
| 2026-05-05 | browser-workspace-route-loaders | removed | specs/20260505T030000-browser-workspace-route-loaders.md |
| 2026-05-05 | move-websocket-construction-into-sync | removed | specs/20260505T031500-move-websocket-construction-into-sync.md |
| 2026-05-05 | primitive-cleanup-post-collapse | removed | specs/20260505T035000-primitive-cleanup-post-collapse.md |
| 2026-05-05 | route-loader-singleton-auth-collapse | removed | specs/20260505T040000-route-loader-singleton-auth-collapse.md |
| 2026-05-05 | zhongwen-context-and-listener-collapse | removed | specs/20260505T060000-zhongwen-context-and-listener-collapse.md |
| 2026-05-05 | auth-state-machine-cleanup-and-provider-migration | removed | specs/20260505T100000-auth-state-machine-cleanup-and-provider-migration.md |
| 2026-05-05 | signed-in-context-scope | removed | specs/20260505T180000-signed-in-context-scope.md |
| 2026-05-05 | signed-in-component-colocation | removed | specs/20260505T200000-signed-in-component-colocation.md |
| 2026-05-04 | machine-auth-adopt-better-auth-device-client | in tree | specs/20260504T040000-machine-auth-adopt-better-auth-device-client.md |
| 2026-05-04 | sign-out-preserves-local-data | in tree | specs/20260504T233223-sign-out-preserves-local-data.md |
| 2026-05-04 | better-auth-1.6.9-upgrade | removed | specs/20260504T210000-better-auth-1.6.9-upgrade.md |
| 2026-05-04 | drop-authclient-redirect-sign-in | removed | specs/20260504T010000-drop-authclient-redirect-sign-in.md |
| 2026-05-04 | workspace-identity-reset-deterministic-teardown | removed | specs/20260504T020000-workspace-identity-reset-deterministic-teardown.md |
| 2026-05-04 | machine-auth-collapse-to-free-functions | removed | specs/20260504T030000-machine-auth-collapse-to-free-functions.md |
| 2026-05-04 | sign-out-preserve-encrypted-local-data | removed | specs/20260504T163252-sign-out-preserve-encrypted-local-data.md |
| 2026-05-04 | attach-sync-auth-namespace | removed | specs/20260504T185711-attach-sync-auth-namespace.md |
| 2026-05-04 | lazy-disposers-bundle-owns-wipe | removed | specs/20260504T220000-lazy-disposers-bundle-owns-wipe.md |
| 2026-05-04 | attach-whendisposed-honest-barriers | removed | specs/20260504T230000-attach-whendisposed-honest-barriers.md |
| 2026-05-04 | attach-sync-trim-to-supervisor-superseded | removed | specs/20260504T231540-attach-sync-trim-to-supervisor-superseded.md |
| 2026-05-04 | drop-redirect-sign-in-gis-migration | removed | specs/20260504T010000-drop-redirect-sign-in-gis-migration.md |
| 2026-05-04 | attach-sync-trim-to-supervisor | removed | specs/20260504T231540-attach-sync-trim-to-supervisor.md |
| 2026-05-04 | auth-workspace-drop-sync-control | removed | specs/20260504T000000-auth-workspace-drop-sync-control.md |
| 2026-05-03 | auth-client-sync-clean-break | removed | specs/20260503T002441-auth-client-sync-clean-break.md |
| 2026-05-03 | encryption-keyring-clean-break | removed | specs/20260503T004836-encryption-keyring-clean-break.md |
| 2026-05-03 | auth-credential-source-of-truth | removed | specs/20260503T010845-auth-credential-source-of-truth.md |
| 2026-05-03 | local-auth-session-clean-break | removed | specs/20260503T012932-local-auth-session-clean-break.md |
| 2026-05-03 | auth-session-storage-boot-cache | removed | specs/20260503T124735-auth-session-storage-boot-cache.md |
| 2026-05-03 | auth-snapshot-three-state-clean-break | removed | specs/20260503T180000-auth-snapshot-three-state-clean-break.md |
| 2026-05-03 | auth-cookie-bearer-two-products-clean-break | removed | specs/20260503T213238-auth-cookie-bearer-two-products-clean-break.md |
| 2026-05-03 | hoist-async-init-out-of-create-auth | removed | specs/20260503T220000-hoist-async-init-out-of-create-auth.md |
| 2026-05-03 | auth-unified-client-two-factories | removed | specs/20260503T230000-auth-unified-client-two-factories.md |
| 2026-05-02 | browser-document-family-identity-and-sync-topology | in tree | specs/20260502T011321-browser-document-family-identity-and-sync-topology.md |
| 2026-05-02 | browser-document-contract-clean-break | in tree | specs/20260502T022408-browser-document-contract-clean-break.md |
| 2026-05-02 | sync-token-source-and-document-family-boundary | removed | specs/20260502T232158-sync-token-source-and-document-family-boundary.md |
| 2026-05-02 | sync-token-source-and-disposable-child-docs | removed | specs/20260502T233446-sync-token-source-and-disposable-child-docs.md |
| 2026-05-01 | auth-snapshot-api | in tree | specs/20260501T013208-auth-snapshot-api.md |
| 2026-05-01 | node-auth-clean-break-api | in tree | specs/20260501T145303-node-auth-clean-break-api.md |
| 2026-05-01 | auth-workspace-lifecycle-inversion | in tree | specs/20260501T221831-auth-workspace-lifecycle-inversion.md |
| 2026-05-01 | machine-auth-credential-cache | removed | specs/20260501T005500-machine-auth-credential-cache.md |
| 2026-05-01 | daemon-startup-boundary-and-route-definition-cleanup | removed | specs/20260501T114356-daemon-startup-boundary-and-route-definition-cleanup.md |
| 2026-05-01 | daemon-peer-runtime-contract | removed | specs/20260501T120000-daemon-peer-runtime-contract.md |
| 2026-05-01 | workspace-auth-lifecycle-api-clean-break | removed | specs/20260501T145113-workspace-auth-lifecycle-api-clean-break.md |
| 2026-05-01 | peer-addressed-remote-client-api | removed | specs/20260501T150015-peer-addressed-remote-client-api.md |
| 2026-05-01 | daemon-route-map-config | removed | specs/20260501T160000-daemon-route-map-config.md |
| 2026-05-01 | auth-workspace-scope-clean-break | removed | specs/20260501T160436-auth-workspace-scope-clean-break.md |
| 2026-05-01 | awareness-source-of-truth | removed | specs/20260501T180000-awareness-source-of-truth.md |
| 2026-04-30 | split-attach-sync-into-transport-presence-rpc | in tree | specs/20260430T103959-split-attach-sync-into-transport-presence-rpc.md |
| 2026-04-30 | peer-presence-rename-and-sync-split | in tree | specs/20260430T114949-peer-presence-rename-and-sync-split.md |
| 2026-04-30 | attach-sync-supervisor-evolution | removed | packages/workspace/specs/20260430T104326-attach-sync-supervisor-evolution.md |
| 2026-04-30 | whole-workspace-action-discovery | removed | specs/20260430-whole-workspace-action-discovery.md |
| 2026-04-30 | cli-naming-decision | removed | specs/20260430T120000-cli-naming-decision.md |
| 2026-04-30 | daemon-transport-supervisor-integration-plan | removed | specs/20260430T133000-daemon-transport-supervisor-integration-plan.md |
| 2026-04-30 | explicit-daemon-host-config | removed | specs/20260430T150000-explicit-daemon-host-config.md |
| 2026-04-30 | readonly-table-primitives-and-script-surfaces | removed | specs/20260430T170000-readonly-table-primitives-and-script-surfaces.md |
| 2026-04-30 | daemon-host-definitions | removed | specs/20260430T190000-daemon-host-definitions.md |
| 2026-04-29 | column-dsl-and-define-table | removed | packages/workspace/specs/20260429T000000-column-dsl-and-define-table.md |
| 2026-04-29 | workspace-as-daemon-transport | removed | specs/20260429T004302-workspace-as-daemon-transport.md |
| 2026-04-29 | remote-workspace-is-the-action-tree | removed | specs/20260429T120000-remote-workspace-is-the-action-tree.md |
| 2026-04-29 | sync-as-peer-transport | removed | specs/20260429T230000-sync-as-peer-transport.md |
| 2026-04-29 | daemon-as-materializer-worker | removed | specs/20260429T235500-daemon-as-materializer-worker.md |
| 2026-04-28 | licensing-strategy | removed | specs/20260428T120000-licensing-strategy.md |
| 2026-04-28 | cli-mandatory-daemon-collapse | removed | specs/20260428T140000-cli-mandatory-daemon-collapse.md |
| 2026-04-28 | list-collapse-to-local-primitive | removed | specs/20260428T183933-list-collapse-to-local-primitive.md |
| 2026-04-28 | script-first-cli-collapse | removed | specs/20260428T-script-first-cli-collapse.md |
| 2026-04-27 | workspace-sync-failed-phase | in tree | specs/20260427T120000-workspace-sync-failed-phase.md |
| 2026-04-27 | execute-cli-up-long-lived-peer | removed | specs/20260427T000000-execute-cli-up-long-lived-peer.md |
| 2026-04-27 | supervisor-redesign | removed | specs/20260427T010000-supervisor-redesign.md |
| 2026-04-27 | supervisor-redesign-step-1-abortsignal | removed | specs/20260427T020000-supervisor-redesign-step-1-abortsignal.md |
| 2026-04-26 | execution-prompt-device-actions-and-remote-dispatch | in tree | specs/20260426T000000-execution-prompt-device-actions-and-remote-dispatch.md |
| 2026-04-26 | fold-awareness-into-sync | in tree | specs/20260426T130000-fold-awareness-into-sync.md |
| 2026-04-26 | cli-actions-unification | in tree | specs/20260426T190000-cli-actions-unification.md |
| 2026-04-26 | cli-up-long-lived-peer | in tree | specs/20260426T235000-cli-up-long-lived-peer.md |
| 2026-04-26 | system-describe-wire-trim | removed | specs/20260426T220000-system-describe-wire-trim.md |
| 2026-04-26 | drop-manifest-from-awareness | removed | specs/20260426T230000-drop-manifest-from-awareness.md |
| 2026-04-26 | cli-host-long-lived-peer | removed | specs/20260426T235000-cli-host-long-lived-peer.md |
| 2026-04-26 | attach-peers-collapse | removed | specs/20260426T120000-attach-peers-collapse.md |
| 2026-04-25 | orchestration-tracker | in tree | specs/20260425T180002-orchestration-tracker.md |
| 2026-04-25 | result-handling-conventions | in tree | specs/20260425T230000-result-handling-conventions.md |
| 2026-04-25 | device-actions-via-awareness | removed | specs/20260425T000000-device-actions-via-awareness.md |
| 2026-04-25 | actions-passthrough-adr | removed | specs/20260425T200000-actions-passthrough-adr.md |
| 2026-04-25 | remote-action-dispatch | removed | specs/20260425T210000-remote-action-dispatch.md |
| 2026-04-25 | app-workspace-folder-env-split | removed | specs/20260425T225350-app-workspace-folder-env-split.md |
| 2026-04-25 | execution-prompt-phase-1 | removed | specs/20260425T120000-execution-prompt-phase-1.md |
| 2026-04-25 | pr-body-document-primitive | removed | specs/20260425T180000-pr-body-document-primitive.md |
| 2026-04-25 | execution-prompt-phase-2-teardown | removed | specs/20260425T180001-execution-prompt-phase-2-teardown.md |
| 2026-04-24 | drop-document-factory-attach-everything | removed | specs/20260424T180000-drop-document-factory-attach-everything.md |
| 2026-04-24 | self-gating-attachments | removed | specs/20260424T000000-self-gating-attachments.md |
| 2026-04-23 | head-doc-epoch-strategy | in tree | specs/20260423T070000-head-doc-epoch-strategy.md |
| 2026-04-23 | transcription-provider-error-taxonomy | in tree | specs/20260423T180000-transcription-provider-error-taxonomy.md |
| 2026-04-23 | cli-json-only-input | removed | specs/20260423T010000-cli-json-only-input.md |
| 2026-04-23 | unify-dot-path-format | removed | specs/20260423T010000-unify-dot-path-format.md |
| 2026-04-23 | auth-core-package | removed | specs/20260423T064414-auth-core-package.md |
| 2026-04-23 | cli-remote-peer-rpc | removed | specs/20260423T174126-cli-remote-peer-rpc.md |
| 2026-04-23 | local-passthrough-remote-result | removed | specs/20260423T020000-local-passthrough-remote-result.md |
| 2026-04-23 | connection-state-machine | removed | specs/20260423T105712-connection-state-machine.md |
| 2026-04-23 | wire-auth-to-sync | removed | specs/20260423T080400-wire-auth-to-sync.md |
| 2026-04-23 | rich-text-row-doc-factory | removed | specs/20260423T080401-rich-text-row-doc-factory.md |
| 2026-04-22 | attach-materializer-redesign | in tree | specs/20260422T042454-attach-materializer-redesign.md |
| 2026-04-22 | encrypted-kv-helper-collapse | in tree | specs/20260422T142044-encrypted-kv-helper-collapse.md |
| 2026-04-22 | markdown-materializer-rebuild | in tree | specs/20260422T175408-markdown-materializer-rebuild.md |
| 2026-04-22 | markdown-serialize-split | in tree | specs/20260422T175408-markdown-serialize-split.md |
| 2026-04-22 | encryption-policy-split | in tree | specs/20260422T181617-encryption-policy-split.md |
| 2026-04-22 | apply-session-unification | removed | specs/20260422T000000-apply-session-unification.md |
| 2026-04-22 | define-document-invert-readiness | removed | specs/20260422T000000-define-document-invert-readiness.md |
| 2026-04-22 | rename-define-document | removed | specs/20260422T000100-rename-define-document.md |
| 2026-04-22 | workspace-logger | removed | specs/20260422T222216-workspace-logger.md |
| 2026-04-22 | unified-action-invocation | removed | specs/20260422T234500-unified-action-invocation.md |
| 2026-04-22 | markdown-materializer-reindex | removed | specs/20260422T175408-markdown-materializer-reindex.md |
| 2026-04-21 | cli-scripting-first-redesign | in tree | specs/20260421T155436-cli-scripting-first-redesign.md |
| 2026-04-21 | inline-content-doc-factories | removed | specs/20260421T000000-inline-content-doc-factories.md |
| 2026-04-21 | collapse-defineworkspace-into-definedocument | removed | specs/20260421T010000-collapse-defineworkspace-into-definedocument.md |
| 2026-04-21 | encryption-primitive-refactor | removed | specs/20260421T140000-encryption-primitive-refactor.md |
| 2026-04-21 | collapse-document-and-workspace-primitives | removed | specs/20260421T170000-collapse-document-and-workspace-primitives.md |
| 2026-04-21 | merge-document-into-workspace | removed | specs/20260421T170000-merge-document-into-workspace.md |
| 2026-04-20 | document-open-handle-disposable | in tree | specs/20260420T162601-document-open-handle-disposable.md |
| 2026-04-20 | y-websocket-teardown-fix | in tree | specs/20260420T230000-y-websocket-teardown-fix.md |
| 2026-04-20 | workspace-as-definedocument | in tree | specs/20260420T230200-workspace-as-definedocument.md |
| 2026-04-20 | consumer-migration-to-defineworkspace | in tree | specs/20260420T234500-consumer-migration-to-defineworkspace.md |
| 2026-04-20 | definedocument-primitive | removed | specs/20260420T152026-definedocument-primitive.md |
| 2026-04-20 | collapse-document-framework | removed | specs/20260420T230100-collapse-document-framework.md |
| 2026-04-20 | documents-under-tables-namespace | removed | specs/20260420T120000-documents-under-tables-namespace.md |
| 2026-04-20 | simplify-definedocument-primitive | removed | specs/20260420T220000-simplify-definedocument-primitive.md |
| 2026-04-20 | attach-sqlite-content-docs | removed | specs/20260420T230218-attach-sqlite-content-docs.md |
| 2026-04-19 | document-primitive-redesign | removed | specs/20260419T150000-document-primitive-redesign.md |
| 2026-04-18 | withdocument-content-strategy | in tree | specs/20260418T120000-withdocument-content-strategy.md |
| 2026-04-17 | local-first-sqlite-sync-articles | in tree | specs/20260417T140000-local-first-sqlite-sync-articles.md |
| 2026-04-17 | document-handle-facade | in tree | specs/20260417T180000-document-handle-facade.md |
| 2026-04-17 | dbservice-to-blobstore | removed | specs/20260417T180000-dbservice-to-blobstore.md |
| 2026-04-15 | standardize-persistence-location | in tree | specs/20260415T120000-standardize-persistence-location.md |
| 2026-04-15 | extension-action-introspection-handoff | in tree | specs/20260415T130224-extension-action-introspection-handoff.md |
| 2026-04-15 | extension-action-introspection-impl | in tree | specs/20260415T130224-extension-action-introspection-impl.md |
| 2026-04-15 | extension-action-introspection | in tree | specs/20260415T130224-extension-action-introspection.md |
| 2026-04-15 | recording-schema-cleanup | in tree | specs/20260415T150000-recording-schema-cleanup.md |
| 2026-04-15 | recording-materializer | in tree | specs/20260415T160000-recording-materializer.md |
| 2026-04-15 | recording-data-architecture | in tree | specs/20260415T170000-recording-data-architecture.md |
| 2026-04-15 | recording-rust-materializer | in tree | specs/20260415T180000-recording-rust-materializer.md |
| 2026-04-15 | recording-phase-prompts | in tree | specs/20260415T190000-recording-phase-prompts.md |
| 2026-04-15 | recording-remaining-phases | in tree | specs/20260415T190000-recording-remaining-phases.md |
| 2026-04-14 | url-search-params-migration | in tree | specs/20260414T104052-url-search-params-migration.md |
| 2026-04-14 | connect-workspace | removed | specs/20260414T023253-connect-workspace.md |
| 2026-04-14 | safe-sign-out-flow | removed | specs/20260414T143000-safe-sign-out-flow.md |
| 2026-04-13 | server-authoritative-apps-wager-social.handoff | in tree | specs/20260413T120000-server-authoritative-apps-wager-social.handoff.md |
| 2026-04-13 | server-authoritative-apps-wager-social | in tree | specs/20260413T120000-server-authoritative-apps-wager-social.md |
| 2026-04-13 | fuji-stress-test | in tree | specs/20260413T225625-fuji-stress-test.md |
| 2026-04-12 | fuji-entry-rating | in tree | docs/specs/20260412T152655-fuji-entry-rating.md |
| 2026-04-12 | markdown-materializer-document-support | in tree | specs/20260412T124500-markdown-materializer-document-support.md |
| 2026-04-12 | breddit | in tree | specs/20260412T151815-breddit.md |
| 2026-04-12 | workspace-performance-and-dead-code-cleanup | in tree | specs/20260412T151815-workspace-performance-and-dead-code-cleanup.md |
| 2026-04-12 | fuji-bulk-add-modal | in tree | specs/20260412T200000-fuji-bulk-add-modal.md |
| 2026-04-12 | restore-sqlite-persistence-and-materializer | removed | specs/20260412T175015-restore-sqlite-persistence-and-materializer.md |
| 2026-04-09 | redact-handoff-prompt | in tree | specs/20260409T120000-redact-handoff-prompt.md |
| 2026-04-08 | natural-language-date-input | removed | docs/specs/20260408T140000 natural-language-date-input.md |
| 2026-04-08 | epicenter-uri-scheme | removed | specs/20260408T120000-epicenter-uri-scheme.md |
| 2026-04-08 | fuji-ui-polish | removed | specs/20260408T160000-fuji-ui-polish.md |
| 2026-04-07 | launch-readiness | in tree | specs/20260407T120000-launch-readiness.md |
| 2026-04-07 | structured-ai-chat-errors | in tree | specs/20260407T165605-structured-ai-chat-errors.md |
| 2026-04-07 | opensidian-toolbar-redesign | in tree | specs/20260407T180000-opensidian-toolbar-redesign.md |
| 2026-04-06 | r2-blob-storage-handoff | in tree | specs/20260406T180000-r2-blob-storage-handoff.md |
| 2026-04-06 | r2-execution-plan | in tree | specs/20260406T200000-r2-execution-plan.md |
| 2026-04-06 | opensidian-internal-links-handoff | removed | docs/specs/20260406T150000 opensidian-internal-links-handoff.md |
| 2026-04-06 | opensidian-ai-integration | removed | specs/20260406T120000-opensidian-ai-integration.md |
| 2026-04-06 | tiptap-to-prosemirror-migration | removed | specs/20260406T163000 tiptap-to-prosemirror-migration.md |
| 2026-04-06 | r2-blob-storage | removed | specs/20260406T180000-r2-blob-storage.md |
| 2026-04-06 | sqlite-mirror-extension | removed | specs/20260406T180000-sqlite-mirror-extension.md |
| 2026-04-06 | asset-storage-billing | removed | specs/20260406T190000-asset-storage-billing.md |
| 2026-04-06 | opensidian-command-palette-search | removed | specs/20260406T200000-opensidian-command-palette-search.md |
| 2026-04-05 | epicenter-size-command.handoff | in tree | specs/20260405T101228-epicenter-size-command.handoff.md |
| 2026-04-05 | opensidian-epicenter-config | in tree | specs/20260405T120000 opensidian-epicenter-config.md |
| 2026-04-05 | billing-dashboard-redesign | in tree | specs/20260405T160000-billing-dashboard-redesign.md |
| 2026-04-05 | tab-search-modes.prompt | in tree | specs/20260405T180000 tab-search-modes.prompt.md |
| 2026-04-05 | epicenter-size-command | removed | specs/20260405T101228-epicenter-size-command.md |
| 2026-04-05 | tab-search-modes | removed | specs/20260405T180000 tab-search-modes.md |
| 2026-04-04 | markdown-materializer-extension | removed | specs/20260404T120000-markdown-materializer-extension.md |
| 2026-04-03 | unify-awareness-with-sync-transport | in tree | specs/20260403T161046-unify-awareness-with-sync-transport.md |
| 2026-04-03 | async-storage-state-api | in tree | specs/20260403T180000-async-storage-state-api.md |
| 2026-04-03 | collapse-sync-client-into-workspace | in tree | specs/20260403T180000-collapse-sync-client-into-workspace.md |
| 2026-04-03 | workspace-encryption-simplification | removed | specs/20260403T120000-workspace-encryption-simplification.md |
| 2026-04-02 | extract-encryption-runtime | in tree | specs/20260402T120000-extract-encryption-runtime.md |
| 2026-04-02 | workspace-rpc | in tree | specs/20260402T120000-workspace-rpc.md |
| 2026-04-02 | simplify-encryption-state-machine | removed | specs/20260402T163000-simplify-encryption-state-machine.md |
| 2026-04-02 | typed-user-key-store | removed | specs/20260402T170000-typed-user-key-store.md |
| 2026-04-02 | remove-compaction-unify-extensions | removed | specs/20260402T180000-remove-compaction-unify-extensions.md |
| 2026-04-01 | auth-token-change-sync-reconnect | in tree | docs/specs/20260401T211540 auth-token-change-sync-reconnect.md |
| 2026-04-01 | self-managed-encryption-password | in tree | specs/20260401T160000-self-managed-encryption-password.md |
| 2026-04-01 | blue-green-epoch-swap | removed | specs/20260401T140000-blue-green-epoch-swap.md |
| 2026-03-31 | cli-simplification.handoff | in tree | specs/20260331T120000-cli-simplification.handoff.md |
| 2026-03-31 | skills-editor-domain-migration | removed | specs/20260331T120000-skills-editor-domain-migration.md |
| 2026-03-31 | cli-simplification-handoff | removed | specs/20260331T120000-cli-simplification-handoff.md |
| 2026-03-30 | portable-skills-architecture | in tree | specs/20260330T120000-portable-skills-architecture.md |
| 2026-03-30 | portable-skills.handoff | in tree | specs/20260330T120000-portable-skills.handoff.md |
| 2026-03-30 | simplify-cli-config-clients-only | in tree | specs/20260330T160000-simplify-cli-config-clients-only.md |
| 2026-03-30 | device-auth-default-and-auth-pages-polish | in tree | specs/20260330T231656-device-auth-default-and-auth-pages-polish.md |
| 2026-03-30 | non-terminal-withactions | removed | specs/20260330T140000-non-terminal-withactions.md |
| 2026-03-30 | cli-auth-client-rename | removed | specs/20260330T233127-cli-auth-client-rename.md |
| 2026-03-30 | portable-skills-handoff | removed | specs/20260330T120000-portable-skills-handoff.md |
| 2026-03-29 | collapse-auth-transport-and-session | in tree | docs/specs/20260329T002221 collapse-auth-transport-and-session.md |
| 2026-03-29 | subscribe-based-auth | removed | specs/20260329T012324-subscribe-based-auth.md |
| 2026-03-28 | auth-transport-stabilization | in tree | specs/20260328T001602-auth-transport-stabilization.md |
| 2026-03-28 | decouple-key-from-session | in tree | specs/20260328T140000-decouple-key-from-session.md |
| 2026-03-27 | unified-encrypted-workspace-auth | removed | specs/20260327T005656-unified-encrypted-workspace-auth.md |
| 2026-03-27 | auth-session-store-redesign | removed | specs/20260327T213000-auth-session-store-redesign.md |
| 2026-03-27 | workspace-first-boot-and-auth | removed | specs/20260327T230000-workspace-first-boot-and-auth.md |
| 2026-03-26 | opinionated-workspace-auth-api | removed | specs/20260326T084710-opinionated-workspace-auth-api.md |
| 2026-03-26 | sync-workspace-hkdf | removed | specs/20260326T085906-sync-workspace-hkdf.md |
| 2026-03-26 | auth-workspace-encryption-boundary | removed | specs/20260326T120000-auth-workspace-encryption-boundary.md |
| 2026-03-25 | sync-auto-reconnect-on-token-change | in tree | specs/20260325T080000-sync-auto-reconnect-on-token-change.md |
| 2026-03-25 | workspace-auth-layering | removed | specs/20260325T222454-workspace-auth-layering.md |
| 2026-03-25 | auth-surface-simplification | removed | specs/20260325T230903-auth-surface-simplification.md |
| 2026-03-23 | shared-auth-factory-for-tab-manager | in tree | specs/20260323T225149-shared-auth-factory-for-tab-manager.md |
| 2026-03-21 | epicenter-api-consumer-guide | in tree | specs/20260321T051523-epicenter-api-consumer-guide.md |
| 2026-03-21 | fix-stuck-tool-approval | in tree | specs/20260321T082150-fix-stuck-tool-approval.md |
| 2026-03-21 | upgrade-prompt | in tree | specs/20260321T100000-upgrade-prompt.md |
| 2026-03-20 | autumn-phase2-3-billing | in tree | specs/20260320T100000-autumn-phase2-3-billing.md |
| 2026-03-20 | readme-refresh | in tree | specs/20260320T120000-readme-refresh.md |
| 2026-03-20 | shared-auth-factory | in tree | specs/20260320T120000-shared-auth-factory.md |
| 2026-03-20 | persisted-state-redesign | in tree | specs/20260320T142920-persisted-state-redesign.md |
| 2026-03-20 | device-token-follow-up-and-pr-stack | in tree | specs/20260320T221430-device-token-follow-up-and-pr-stack.md |
| 2026-03-20 | spec-freshness-audit | removed | specs/20260320T120000-spec-freshness-audit.md |
| 2026-03-19 | pr-1507-quality-and-cla-followup | in tree | specs/20260319T100044-pr-1507-quality-and-cla-followup.md |
| 2026-03-19 | autumn-billing-ui | in tree | specs/20260319T105618-autumn-billing-ui.md |
| 2026-03-19 | skill-authoring-model | in tree | specs/20260319T120000-skill-authoring-model.md |
| 2026-03-19 | autumn-billing-overview | in tree | specs/20260319T140000-autumn-billing-overview.md |
| 2026-03-19 | autumn-phase1-ai-chat-gating | in tree | specs/20260319T140001-autumn-phase1-ai-chat-gating.md |
| 2026-03-19 | autumn-phase2-billing-routes | in tree | specs/20260319T140002-autumn-phase2-billing-routes.md |
| 2026-03-19 | autumn-phase3-billing-ui | in tree | specs/20260319T140003-autumn-phase3-billing-ui.md |
| 2026-03-19 | autumn-phase4-storage-billing | in tree | specs/20260319T140004-autumn-phase4-storage-billing.md |
| 2026-03-19 | rewrite-how-to-monetize | removed | specs/20260319T002657-rewrite-how-to-monetize.md |
| 2026-03-19 | licensing-restructure | removed | specs/20260319T180117-licensing-restructure.md |
| 2026-03-19 | browser-state-chrome-authority | removed | specs/20260319T120000-browser-state-chrome-authority.md |
| 2026-03-19 | opensidian-terminal-panel | removed | specs/20260319T160000-opensidian-terminal-panel.md |
| 2026-03-19 | browser-state-chrome-authority-v2 | removed | specs/20260319T170000-browser-state-chrome-authority-v2.md |
| 2026-03-18 | workspace-lifecycle-cleanup | in tree | specs/20260318T055905-workspace-lifecycle-cleanup.md |
| 2026-03-18 | auth-pages-fixes | in tree | specs/20260318T101545-auth-pages-fixes.md |
| 2026-03-18 | autumn-ai-billing | in tree | specs/20260318T120000-autumn-ai-billing.md |
| 2026-03-18 | opensidian-consolidation | in tree | specs/20260318T123049-opensidian-consolidation.md |
| 2026-03-18 | opensidian-workspace-split | in tree | specs/20260318T142427-opensidian-workspace-split.md |
| 2026-03-18 | tool-approval-architecture | in tree | specs/20260318T155243-tool-approval-architecture.md |
| 2026-03-18 | auth-pages-polish | in tree | specs/20260318T165500-auth-pages-polish.md |
| 2026-03-18 | use-key-manager-in-auth | in tree | specs/20260318T174000-use-key-manager-in-auth.md |
| 2026-03-18 | workspace-owns-encryption-lifecycle | in tree | specs/20260318T182000-workspace-owns-encryption-lifecycle.md |
| 2026-03-18 | rename-svelte-package-and-add-fromKv | in tree | specs/20260318T234754-rename-svelte-package-and-add-fromKv.md |
| 2026-03-18 | honeycrisp-refactor | removed | specs/20260318T123322-honeycrisp-refactor.md |
| 2026-03-18 | honeycrisp-code-smells | removed | specs/20260318T141054-honeycrisp-code-smells.md |
| 2026-03-18 | fix-workspace-reset-lifecycle | removed | specs/20260318T170000-fix-workspace-reset-lifecycle.md |
| 2026-03-18 | encryption-hooks-onactivate | removed | specs/20260318T201533-encryption-hooks-onactivate.md |
| 2026-03-17 | eliminate-locked-mode | in tree | specs/20260317T120000-eliminate-locked-mode.md |
| 2026-03-17 | runner-cli-merge | in tree | specs/20260317T120000-runner-cli-merge.md |
| 2026-03-17 | type-tighten-observe-ids | in tree | specs/20260317T120000-type-tighten-observe-ids.md |
| 2026-03-17 | rename-encryption-state-to-is-encrypted | in tree | specs/20260317T130000-rename-encryption-state-to-is-encrypted.md |
| 2026-03-17 | remove-store-isEncrypted | in tree | specs/20260317T224512-remove-store-isEncrypted.md |
| 2026-03-17 | hono-jsx-auth-pages | in tree | specs/20260317T234615-hono-jsx-auth-pages.md |
| 2026-03-16 | callback-driven-encryption-lifecycle | in tree | specs/20260316T153910-callback-driven-encryption-lifecycle.md |
| 2026-03-16 | debug-storage-monitor | removed | apps/whispering/specs/20260316T235800-debug-storage-monitor.md |
| 2026-03-16 | encryption-wiring-api-refinements | removed | specs/20260316T093000-encryption-wiring-api-refinements.md |
| 2026-03-16 | shared-extension-context | removed | specs/20260316T095000-shared-extension-context.md |
| 2026-03-16 | refactor-create-document | removed | specs/20260316T150000-refactor-create-document.md |
| 2026-03-16 | sidebar-peek-on-hover | removed | specs/20260316T175356-sidebar-peek-on-hover.md |
| 2026-03-15 | query-layer-switch-to-workspace-tables | in tree | specs/20260315T070000-query-layer-switch-to-workspace-tables.md |
| 2026-03-15 | encryption-wiring-factory | in tree | specs/20260315T141700-encryption-wiring-factory.md |
| 2026-03-15 | clean-up-dead-rpc-db-code | in tree | specs/20260315T210229-clean-up-dead-rpc-db-code.md |
| 2026-03-15 | workspace-encryption-api-design | in tree | specs/20260315T213200-workspace-encryption-api-design.md |
| 2026-03-15 | workspace-client-surface-audit | in tree | specs/20260315T213258-workspace-client-surface-audit.md |
| 2026-03-15 | flatten-timeline-into-handle | removed | specs/20260315T170000-flatten-timeline-into-handle.md |
| 2026-03-15 | keycache-chrome-extension | removed | specs/20260315T083000-keycache-chrome-extension.md |
| 2026-03-15 | encryption-mode-renaming | removed | specs/20260315T083500-encryption-mode-renaming.md |
| 2026-03-15 | snapshot-restore-via-timeline | removed | specs/20260315T120000-snapshot-restore-via-timeline.md |
| 2026-03-15 | flatten-workspace-state-prefix | removed | specs/20260315T140000-flatten-workspace-state-prefix.md |
| 2026-03-15 | encrypted-kv-simplification | removed | specs/20260315T141500-encrypted-kv-simplification.md |
| 2026-03-15 | create-encryption-wiring | removed | specs/20260315T213228-create-encryption-wiring.md |
| 2026-03-14 | remove-fs-content-namespace | in tree | specs/20260314T091500-remove-fs-content-namespace.md |
| 2026-03-14 | inline-file-creation | in tree | specs/20260314T104746-inline-file-creation.md |
| 2026-03-14 | migration-file-reorganization | removed | apps/whispering/specs/20260314T172633-migration-file-reorganization.md |
| 2026-03-14 | document-handle-cleanup | removed | specs/20260314T060000-document-handle-cleanup.md |
| 2026-03-14 | tool-trust-revocation-settings | removed | specs/20260314T061500-tool-trust-revocation-settings.md |
| 2026-03-14 | encryption-wrapper-hardening | removed | specs/20260314T063000-encryption-wrapper-hardening.md |
| 2026-03-14 | per-workspace-envelope-encryption | removed | specs/20260314T064000-per-workspace-envelope-encryption.md |
| 2026-03-14 | database-to-workspace-migration | removed | specs/20260314T070000-database-to-workspace-migration.md |
| 2026-03-14 | handle-content-conversion-api | removed | specs/20260314T070000-handle-content-conversion-api.md |
| 2026-03-14 | per-user-workspace-hkdf-key-derivation | removed | specs/20260314T070000-per-user-workspace-hkdf-key-derivation.md |
| 2026-03-14 | mutation-default-approval | removed | specs/20260314T080000-mutation-default-approval.md |
| 2026-03-14 | encrypted-blob-binary-storage | removed | specs/20260314T090000-encrypted-blob-binary-storage.md |
| 2026-03-14 | quickaction-workspace-unification | removed | specs/20260314T120000-quickaction-workspace-unification.md |
| 2026-03-14 | surgical-sqlite-index-updates | removed | specs/20260314T170000-surgical-sqlite-index-updates.md |
| 2026-03-14 | bare-uint8array-encrypted-blob | removed | specs/20260314T230000-bare-uint8array-encrypted-blob.md |
| 2026-03-14 | migration-flow-cleanup | removed | specs/20260314T232643-migration-flow-cleanup.md |
| 2026-03-14 | encryption-hygiene | removed | specs/20260314T234500-encryption-hygiene.md |
| 2026-03-13 | opensidian-sqlite-index-extension | in tree | specs/20260313T143000-opensidian-sqlite-index-extension.md |
| 2026-03-13 | opensidian-feature-additions | in tree | specs/20260313T143300-opensidian-feature-additions.md |
| 2026-03-13 | unify-document-content-model | in tree | specs/20260313T224500-unify-document-content-model.md |
| 2026-03-13 | workspace-architecture-decisions | removed | specs/20260313T063000-workspace-architecture-decisions.md |
| 2026-03-13 | three-tier-extension-api | removed | specs/20260313T000200-three-tier-extension-api.md |
| 2026-03-13 | definekv-defaults | removed | specs/20260313T070000-definekv-defaults.md |
| 2026-03-13 | add-cla-infrastructure | removed | specs/20260313T071500-add-cla-infrastructure.md |
| 2026-03-13 | chat-architecture-redesign | removed | specs/20260313T080000-chat-architecture-redesign.md |
| 2026-03-13 | rename-fs-explorer-to-opensidian | removed | specs/20260313T101639-rename-fs-explorer-to-opensidian.md |
| 2026-03-13 | remove-kv-migration | removed | specs/20260313T130000-remove-kv-migration.md |
| 2026-03-13 | encryption-docs-refresh | removed | specs/20260313T140000-encryption-docs-refresh.md |
| 2026-03-13 | honeycrisp-overhaul | removed | specs/20260313T141500-honeycrisp-overhaul.md |
| 2026-03-13 | opensidian-ui-idiomaticity | removed | specs/20260313T143100-opensidian-ui-idiomaticity.md |
| 2026-03-13 | opensidian-tree-view-adoption | removed | specs/20260313T143200-opensidian-tree-view-adoption.md |
| 2026-03-13 | document-snapshot-fixes | removed | specs/20260313T144805-document-snapshot-fixes.md |
| 2026-03-13 | per-key-device-config | removed | specs/20260313T160000-per-key-device-config.md |
| 2026-03-13 | settings-data-migration | removed | specs/20260313T163000-settings-data-migration.md |
| 2026-03-13 | encrypted-blob-format-simplification | removed | specs/20260313T180000-encrypted-blob-format-simplification.md |
| 2026-03-13 | client-side-encryption-wiring | removed | specs/20260313T180100-client-side-encryption-wiring.md |
| 2026-03-13 | kv-default-values | removed | specs/20260313T180200-kv-default-values.md |
| 2026-03-13 | do-naming-convention | removed | specs/20260313T201800-do-naming-convention.md |
| 2026-03-13 | encrypted-blob-pack-nonce | removed | specs/20260313T202000-encrypted-blob-pack-nonce.md |
| 2026-03-13 | honeycrisp-pr-cleanup | removed | specs/20260313T225500-honeycrisp-pr-cleanup.md |
| 2026-03-13 | promote-timeline-to-workspace | removed | specs/20260313T230000-promote-timeline-to-workspace.md |
| 2026-03-12 | y-keyvalue-lww-encrypted | in tree | specs/20260312T120000-y-keyvalue-lww-encrypted.md |
| 2026-03-12 | tab-actions-cleanup | in tree | specs/20260312T163132-tab-actions-cleanup.md |
| 2026-03-12 | whispering-workspace-polish-and-migration | in tree | specs/20260312T170000-whispering-workspace-polish-and-migration.md |
| 2026-03-12 | workspace-id-naming-convention | in tree | specs/20260312T173000-workspace-id-naming-convention.md |
| 2026-03-12 | branded-id-convention | in tree | specs/20260312T180000-branded-id-convention.md |
| 2026-03-12 | do-storage-tracking | removed | specs/20260312T121000-do-storage-tracking.md |
| 2026-03-12 | remove-epicenter-app | removed | specs/20260312T151300-remove-epicenter-app.md |
| 2026-03-12 | action-metadata-title-destructive | removed | specs/20260312T153000-action-metadata-title-destructive.md |
| 2026-03-12 | progressive-tool-trust | removed | specs/20260312T170000-progressive-tool-trust.md |
| 2026-03-12 | fuji-rewrite | removed | specs/20260312T192500-fuji-rewrite.md |
| 2026-03-12 | honeycrisp | removed | specs/20260312T192500-honeycrisp.md |
| 2026-03-12 | whispering-settings-separation | removed | specs/20260312T210000-whispering-settings-separation.md |
| 2026-03-12 | headless-workspace-runner | removed | specs/20260312T211500-headless-workspace-runner.md |
| 2026-03-12 | honeycrisp-ui-polish | removed | specs/20260312T224500-honeycrisp-ui-polish.md |
| 2026-03-11 | catalog-consolidation | in tree | specs/20260311T012016-catalog-consolidation.md |
| 2026-03-11 | centralize-dev-ports | in tree | specs/20260311T012849-centralize-dev-ports.md |
| 2026-03-11 | sync-status-indicator-redesign | in tree | specs/20260311T061500-sync-status-indicator-redesign.md |
| 2026-03-11 | inline-connection-hub | in tree | specs/20260311T070400-inline-connection-hub.md |
| 2026-03-11 | sync-status-enrichment | in tree | specs/20260311T100600-sync-status-enrichment.md |
| 2026-03-11 | transcribe-rs-0.2.9-upgrade | in tree | specs/20260311T120000-transcribe-rs-0.2.9-upgrade.md |
| 2026-03-11 | reddit-ingest-hardening | in tree | specs/20260311T150607-reddit-ingest-hardening.md |
| 2026-03-11 | refactor-action-context | in tree | specs/20260311T172000-refactor-action-context.md |
| 2026-03-11 | recording-actions | in tree | specs/20260311T172500-recording-actions.md |
| 2026-03-11 | unified-tab-view | in tree | specs/20260311T190000-unified-tab-view.md |
| 2026-03-11 | monorepo-cleanup | in tree | specs/20260311T195924-monorepo-cleanup.md |
| 2026-03-11 | flatten-isomorphic-folders | in tree | specs/20260311T203500-flatten-isomorphic-folders.md |
| 2026-03-11 | changelog-release-strategy | in tree | specs/20260311T224500-changelog-release-strategy.md |
| 2026-03-11 | apple-notes-archetype | removed | specs/20260311T224500-apple-notes-archetype.md |
| 2026-03-11 | auth-state-effect-root-refactor | removed | apps/tab-manager/specs/20260311T225500-auth-state-effect-root-refactor.md |
| 2026-03-11 | alarm-based-compaction | removed | specs/20260311T064000-alarm-based-compaction.md |
| 2026-03-11 | sync-handlers-rename-restructure | removed | specs/20260311T070500-sync-handlers-rename-restructure.md |
| 2026-03-11 | remove-server-local | removed | specs/20260311T080000-remove-server-local.md |
| 2026-03-11 | tab-manager-auth-gate-overhaul | removed | specs/20260311T150000-tab-manager-auth-gate-overhaul.md |
| 2026-03-11 | remove-gray-matter-polyfills | removed | specs/20260311T213400-remove-gray-matter-polyfills.md |
| 2026-03-11 | gettoken-falsy-return-fix | removed | specs/20260311T230000-gettoken-falsy-return-fix.md |
| 2026-03-11 | remove-commands-table-and-awareness | removed | specs/20260311T230000-remove-commands-table-and-awareness.md |
| 2026-03-11 | epicenter-ai-overhaul | removed | specs/20260311T120000-epicenter-ai-overhaul.md |
| 2026-03-10 | testing-client-compat.handoff | in tree | specs/20260310T111300-testing-client-compat.handoff.md |
| 2026-03-10 | sync-integration-tests | in tree | specs/20260310T202500-sync-integration-tests.md |
| 2026-03-10 | extract-do-factory-functions | in tree | specs/20260310T210000-extract-do-factory-functions.md |
| 2026-03-10 | tab-manager-cross-window-sync | in tree | specs/20260310T220000-tab-manager-cross-window-sync.md |
| 2026-03-10 | rename-room-param | in tree | specs/20260310T233248-rename-room-param.md |
| 2026-03-10 | sync-status-102 | removed | specs/20260310T235239-sync-status-102.md |
| 2026-03-09 | sync-provider-config-simplification | in tree | specs/20260309T000000-sync-provider-config-simplification.md |
| 2026-03-09 | sync-client-simplification | in tree | specs/sync-client-simplification.md |
| 2026-03-08 | sync-core-simplification | removed | specs/20260308T000000-sync-core-simplification.md |
| 2026-03-08 | server-local-elysia-to-hono | removed | specs/20260308T120000-server-local-elysia-to-hono.md |
| 2026-03-08 | sync-three-layer-split | removed | specs/20260308T120000-sync-three-layer-split.md |
| 2026-03-07 | workspace-document-room-split | in tree | specs/20260307T010000-workspace-document-room-split.md |
| 2026-03-07 | remove-server-remote-standalone | removed | specs/20260307T000000-remove-server-remote-standalone.md |
| 2026-03-07 | room-isolation-and-sharing | removed | specs/20260307T000002-room-isolation-and-sharing.md |
| 2026-03-07 | split-yjsroom-workspace-document | removed | specs/20260307T000000-split-yjsroom-workspace-document.md |
| 2026-03-07 | org-scoped-rooms | removed | specs/20260307T000001-org-scoped-rooms.md |
| 2026-03-06 | yjs-room-naming-cleanup | removed | specs/20260306T111935-yjs-room-naming-cleanup.md |
| 2026-03-05 | cloudflare-module-env-refactor | removed | specs/20260305T120000-cloudflare-module-env-refactor.md |
| 2026-03-05 | server-package-consolidation | removed | specs/20260305T120000-server-package-consolidation.md |
| 2026-03-05 | neon-to-planetscale-hyperdrive | removed | specs/20260305T180000-neon-to-planetscale-hyperdrive.md |
| 2026-03-05 | server-remote-adapter-architecture | removed | specs/20260305T180000-server-remote-adapter-architecture.md |
| 2026-03-04 | platform-agnostic-sync-primitives | in tree | specs/20260304T000000-platform-agnostic-sync-primitives.md |
| 2026-03-04 | hub-sidecar-architecture | in tree | specs/20260304T120000-hub-sidecar-architecture.md |
| 2026-03-04 | withDocument-onUpdate-callback | removed | specs/20260304T000000-withDocument-onUpdate-callback.md |
| 2026-03-03 | http-sync-protocol | in tree | specs/20260303T150000-http-sync-protocol.md |
| 2026-03-03 | unified-versioning | in tree | specs/20260303T150000-unified-versioning.md |
| 2026-03-03 | migrate-whispering-try-catch-to-wellcrafted | in tree | specs/migrate-whispering-try-catch-to-wellcrafted.md |
| 2026-03-03 | completion-error-thiserror-redesign | removed | specs/20260303T120000-completion-error-thiserror-redesign.md |
| 2026-03-03 | two-mode-auth-with-centralized-oauth | removed | specs/20260303T120000-two-mode-auth-with-centralized-oauth.md |
| 2026-03-03 | variadic-define-table-kv | removed | specs/20260303T120000-variadic-define-table-kv.md |
| 2026-03-03 | sse-sync-protocol | removed | specs/20260303T150000-sse-sync-protocol.md |
| 2026-03-02 | tagged-error-api-migration | in tree | specs/20260302T000000-tagged-error-api-migration.md |
| 2026-03-02 | whispering-sync-strategy | in tree | specs/20260302T140000-whispering-sync-strategy.md |
| 2026-03-02 | define-errors-api-redesign | removed | specs/20260302T000000-define-errors-api-redesign.md |
| 2026-03-02 | split-sub-discriminant-errors | removed | specs/20260302T200000-split-sub-discriminant-errors.md |
| 2026-03-02 | dual-runtime-workspace-mvp | removed | specs/20260302T120000-dual-runtime-workspace-mvp.md |
| 2026-02-27 | cli-reorganization | removed | specs/20260227T120000-cli-reorganization.md |
| 2026-02-27 | server-package-split | removed | specs/20260227T120000-server-package-split.md |
| 2026-02-26 | granular-error-migration | in tree | specs/20260226T000000-granular-error-migration.md |
| 2026-02-26 | tagged-error-minimal-design | removed | specs/20260226T233600-tagged-error-minimal-design.md |
| 2026-02-25 | rename-epicenter-hq-package | in tree | specs/20260225T120000-rename-epicenter-hq-package.md |
| 2026-02-25 | typebox-action-input-schemas | in tree | specs/20260225T120000-typebox-action-input-schemas.md |
| 2026-02-25 | bun-sidecar-workspace-modules | removed | specs/20260225T000000-bun-sidecar-workspace-modules.md |
| 2026-02-25 | consolidate-to-side-panel | removed | specs/20260225-consolidate-to-side-panel.md |
| 2026-02-25 | tagged-error-redesign | removed | specs/20260225T000000-tagged-error-redesign.md |
| 2026-02-25 | epicenter-workspace-module-redesign | removed | specs/20260225T172506-epicenter-workspace-module-redesign.md |
| 2026-02-25 | cli-thin-http-client | removed | specs/20260225T180000-cli-thin-http-client.md |
| 2026-02-25 | static-action-routes-with-watch | removed | specs/20260225T200000-static-action-routes-with-watch.md |
| 2026-02-25 | workspace-apps-orchestrator | removed | specs/20260225T210000-workspace-apps-orchestrator.md |
| 2026-02-25 | apple-notes-workspace | removed | specs/20260225T102116-apple-notes-workspace.md |
| 2026-02-25 | server-package-structure | removed | specs/20260225T130000-server-package-structure.md |
| 2026-02-25 | typebox-action-simplifications | removed | specs/20260225T180000-typebox-action-simplifications.md |
| 2026-02-24 | simplify-tab-manager-settings | in tree | specs/20260224T112600 simplify-tab-manager-settings.md |
| 2026-02-24 | conversation-handle-refactor | in tree | specs/20260224T141400-conversation-handle-refactor.md |
| 2026-02-24 | local-server-plugin-architecture | in tree | specs/20260224T141400-local-server-plugin-architecture.md |
| 2026-02-24 | package-renaming | in tree | specs/20260224T150508-package-renaming.md |
| 2026-02-24 | eager-conversation-creation | in tree | specs/20260224T160300-eager-conversation-creation.md |
| 2026-02-24 | ai-chat-controls-redesign | removed | apps/tab-manager/specs/20260224T141300 ai-chat-controls-redesign.md |
| 2026-02-24 | ai-chat-architecture-client-tools | removed | specs/20260224T171500-ai-chat-architecture-client-tools.md |
| 2026-02-24 | ai-chat-component-redesign | removed | specs/20260224T180000-ai-chat-component-redesign.md |
| 2026-02-24 | client-side-ai-tools | removed | specs/20260224T190000-client-side-ai-tools.md |
| 2026-02-23 | shared-provider-models | in tree | specs/20260223T024935-shared-provider-models.md |
| 2026-02-23 | network-topology-execution-plan | in tree | specs/20260223T102800-network-topology-execution-plan.md |
| 2026-02-23 | jwt-auth-for-local-server-and-sync | in tree | specs/20260223T160300-jwt-auth-for-local-server-and-sync.md |
| 2026-02-23 | bgsw-ai-runtime | in tree | specs/20260223T230000-bgsw-ai-runtime.md |
| 2026-02-23 | byok-api-key-settings | removed | specs/20260223T160300-byok-api-key-settings.md |
| 2026-02-23 | remove-key-store-simplify-api-key-resolution | removed | specs/20260223T102844-remove-key-store-simplify-api-key-resolution.md |
| 2026-02-23 | background-ai-stream-on-switch | removed | specs/20260223T195800-background-ai-stream-on-switch.md |
| 2026-02-23 | ai-tools-command-queue | removed | specs/20260223T200500-ai-tools-command-queue.md |
| 2026-02-23 | multi-conversation-ai-chat | removed | docs/specs/20260223T070755-multi-conversation-ai-chat.md |
| 2026-02-22 | network-topology-multi-server-architecture | in tree | specs/20260222T195645-network-topology-multi-server-architecture.md |
| 2026-02-22 | server-endpoint-security | in tree | specs/20260222T200800-server-endpoint-security.md |
| 2026-02-22 | server-side-api-key-management | removed | specs/20260222T195800-server-side-api-key-management.md |
| 2026-02-21 | extract-cli-package | in tree | specs/20260221T161919-extract-cli-package.md |
| 2026-02-21 | inline-run-extension-factories | removed | specs/20260221T044200-inline-run-extension-factories.md |
| 2026-02-21 | ai-chat-tab | removed | specs/20260221T190252-ai-chat-tab.md |
| 2026-02-21 | documents-top-level-namespace | removed | specs/20260221T204200-documents-top-level-namespace.md |
| 2026-02-21 | rename-doc-binding-types | removed | specs/20260221T204200-rename-doc-binding-types.md |
| 2026-02-21 | remove-document-binding-dead-code | removed | specs/20260221T204300-remove-document-binding-dead-code.md |
| 2026-02-20 | plugin-first-server-architecture | in tree | specs/20260220T080000-plugin-first-server-architecture.md |
| 2026-02-20 | clean-markdown-yaml-frontmatter-export | in tree | specs/20260220T195900-clean-markdown-yaml-frontmatter-export.md |
| 2026-02-20 | sync-plugin-rest-endpoints | in tree | specs/20260220T195900-sync-plugin-rest-endpoints.md |
| 2026-02-20 | sync-route-prefix-restructure | in tree | specs/20260220T195900-sync-route-prefix-restructure.md |
| 2026-02-20 | unify-document-extension-shape | in tree | specs/20260220T195900-unify-document-extension-shape.md |
| 2026-02-20 | flat-extension-type | in tree | specs/20260220T200000-flat-extension-type.md |
| 2026-02-20 | ai-plugin | in tree | specs/20260220T200100 ai-plugin.md |
| 2026-02-20 | trim-document-context | in tree | specs/20260220T201913-trim-document-context.md |
| 2026-02-20 | unify-extension-lifecycle | removed | packages/workspace/specs/20260220T195900-unify-extension-lifecycle.md |
| 2026-02-20 | pure-sync-server | removed | specs/20260220T044539-pure-sync-server.md |
| 2026-02-20 | unified-local-server-architecture | removed | specs/20260220T133004-unified-local-server-architecture.md |
| 2026-02-20 | filesystem-error-namespace | removed | specs/20260220T194713-filesystem-error-namespace.md |
| 2026-02-20 | flatten-extension-context | removed | specs/20260220T195800-flatten-extension-context.md |
| 2026-02-20 | deprecate-dynamic-api | removed | specs/20260220T195900-deprecate-dynamic-api.md |
| 2026-02-20 | document-handle-api | removed | specs/20260220T195900-document-handle-api.md |
| 2026-02-20 | flatten-extension-exports | removed | specs/20260220T195900-flatten-extension-exports.md |
| 2026-02-20 | extension-handle-passthrough | removed | specs/20260220T200000-extension-handle-passthrough.md |
| 2026-02-20 | surgical-extension-await | removed | specs/20260220T200000-surgical-extension-await.md |
| 2026-02-20 | unify-extension-lifecycle | removed | packages/epicenter/specs/20260220T195900-unify-extension-lifecycle.md |
| 2026-02-20 | collapse-sync-routes | removed | packages/server/specs/20260220T223633 collapse-sync-routes.md |
| 2026-02-20 | collapse-sync-routes | removed | packages/server-elysia/specs/20260220T223633 collapse-sync-routes.md |
| 2026-02-19 | server-architecture-rethink | in tree | specs/20260219T195800-server-architecture-rethink.md |
| 2026-02-19 | deployment-targets-research | in tree | specs/20260219T200000-deployment-targets-research.md |
| 2026-02-19 | migrate-filesystem-to-document-binding | removed | specs/20260219T094400-migrate-filesystem-to-document-binding.md |
| 2026-02-19 | document-extension-api | removed | specs/20260219T195800-document-extension-api.md |
| 2026-02-19 | standalone-sync-server | removed | specs/20260219T195846-standalone-sync-server.md |
| 2026-02-19 | standalone-sync-server | removed | specs/20260219T195900-standalone-sync-server.md |
| 2026-02-19 | sync-server-redesign | removed | specs/20260219T204521 sync-server-redesign.md |
| 2026-02-18 | markdown-persistence-extension | in tree | specs/20260218T211400-markdown-persistence-extension.md |
| 2026-02-18 | tab-manager-markdown-export | removed | specs/20260218T172212-tab-manager-markdown-export.md |
| 2026-02-18 | tab-manager-markdown-export | removed | docs/specs/20260218T172212-tab-manager-markdown-export.md |
| 2026-02-17 | tab-manager-popup-to-sidepanel | in tree | specs/20260217T211400-tab-manager-popup-to-sidepanel.md |
| 2026-02-17 | table-level-document-api | removed | specs/20260217T094400-table-level-document-api.md |
| 2026-02-17 | tab-manager-popup-to-sidepanel | removed | docs/specs/20260217T211400-tab-manager-popup-to-sidepanel.md |
| 2026-02-16 | component-styling-audit | in tree | specs/20260216T211358-component-styling-audit.md |
| 2026-02-16 | component-styling-audit | removed | docs/specs/20260216T211358-component-styling-audit.md |
| 2026-02-15 | updated-at-sentinel-pattern-article | in tree | specs/20260215T172007-updated-at-sentinel-pattern-article.md |
| 2026-02-15 | symmetric-v-all-tables | in tree | specs/20260215T174700-symmetric-v-all-tables.md |
| 2026-02-15 | enforce-v-at-type-level | removed | specs/20260215T180000-enforce-v-at-type-level.md |
| 2026-02-15 | updated-at-sentinel-pattern-article | removed | docs/specs/20260215T172007-updated-at-sentinel-pattern-article.md |
| 2026-02-14 | version-discriminant-tables-only | in tree | specs/20260214T225000-version-discriminant-tables-only.md |
| 2026-02-14 | sheet-timeline-entry | removed | specs/20260214T174800-sheet-timeline-entry.md |
| 2026-02-14 | workspace-level-batch | removed | specs/20260214T105600-workspace-level-batch.md |
| 2026-02-14 | fix-stale-read-after-delete | removed | specs/20260214T110000-fix-stale-read-after-delete.md |
| 2026-02-14 | migrate-y-sweet-to-epicenter-sync | removed | specs/20260214T120800-migrate-y-sweet-to-epicenter-sync.md |
| 2026-02-14 | remove-define-extension | removed | specs/20260214T133054-remove-define-extension.md |
| 2026-02-13 | browser-schema-camelcase-cleanup | in tree | specs/20260213T012108-browser-schema-camelcase-cleanup.md |
| 2026-02-13 | tab-manager-src-reorganization | in tree | specs/20260213T105705-tab-manager-src-reorganization.md |
| 2026-02-13 | extract-epicenter-server-package | in tree | specs/20260213T120800-extract-epicenter-server-package.md |
| 2026-02-13 | fix-disconnect-reconnect-race | removed | specs/20260213T000000-fix-disconnect-reconnect-race.md |
| 2026-02-13 | suspended-tabs | removed | specs/20260213T003200-suspended-tabs.md |
| 2026-02-13 | y-sweet-sync-reconnect | removed | specs/20260213T003800-y-sweet-sync-reconnect.md |
| 2026-02-13 | encrypted-workspace-storage | removed | specs/20260213T005300-encrypted-workspace-storage.md |
| 2026-02-13 | rename-suspended-to-saved | removed | specs/20260213T014300-rename-suspended-to-saved.md |
| 2026-02-13 | popup-reactive-state | removed | specs/20260213T015500-popup-reactive-state.md |
| 2026-02-13 | collapse-browser-converters | removed | specs/20260213T022250-collapse-browser-converters.md |
| 2026-02-13 | chainable-extension-api | removed | specs/20260213T102800-chainable-extension-api.md |
| 2026-02-13 | workspace-awareness | removed | specs/20260213T102800-workspace-awareness.md |
| 2026-02-13 | browser-state-simplification | removed | specs/20260213T103000-browser-state-simplification.md |
| 2026-02-13 | request-dispatch | removed | specs/20260213T103000-request-dispatch.md |
| 2026-02-13 | y-sweet-persist-sync-rename | removed | specs/20260213T104500-y-sweet-persist-sync-rename.md |
| 2026-02-13 | extract-filesystem-package | removed | specs/20260213T120800-extract-filesystem-package.md |
| 2026-02-13 | separate-extension-lifecycle-from-exports | removed | specs/20260213T120800-separate-extension-lifecycle-from-exports.md |
| 2026-02-13 | standardize-table-helper-types | removed | specs/20260213T120800-standardize-table-helper-types.md |
| 2026-02-13 | rename-whensynced-to-whenready | removed | specs/20260213T122009-rename-whensynced-to-whenready.md |
| 2026-02-13 | transparent-extension-lifecycle | removed | specs/20260213T225300-transparent-extension-lifecycle.md |
| 2026-02-13 | browser-schema-camelcase-cleanup | removed | docs/specs/20260213T012108-browser-schema-camelcase-cleanup.md |
| 2026-02-13 | popup-reactive-state | removed | docs/specs/20260213T015500-popup-reactive-state.md |
| 2026-02-13 | tab-manager-src-reorganization | removed | docs/specs/20260213T105705-tab-manager-src-reorganization.md |
| 2026-02-13 | encrypted-api-key-vault | removed | specs/20260213T030000-encrypted-api-key-vault.md |
| 2026-02-13 | runtime-server-switching | removed | specs/20260213T000100-runtime-server-switching.md |
| 2026-02-12 | remove-y-sweet-backwards-compatibility | in tree | specs/20260212T120000-remove-y-sweet-backwards-compatibility.md |
| 2026-02-12 | simplify-sleeper-to-function | in tree | specs/20260212T200000-simplify-sleeper-to-function.md |
| 2026-02-12 | async-content-doc-store-with-providers | removed | specs/20260212T000000-async-content-doc-store-with-providers.md |
| 2026-02-12 | yjs-filesystem-decomposition | removed | specs/20260212T120000-yjs-filesystem-decomposition.md |
| 2026-02-12 | events-based-tab-management | removed | specs/20260212T132200-events-based-tab-management.md |
| 2026-02-12 | simplify-y-sweet-api-surface | removed | specs/20260212T180000-simplify-y-sweet-api-surface.md |
| 2026-02-12 | y-sweet-persistence-architecture | removed | specs/20260212T190000-y-sweet-persistence-architecture.md |
| 2026-02-12 | y-sweet-provider-connection-supervisor | removed | specs/20260212T224900-y-sweet-provider-connection-supervisor.md |
| 2026-02-12 | merge-file-tree-into-yjs-filesystem | removed | specs/20260212T140000-merge-file-tree-into-yjs-filesystem.md |
| 2026-02-12 | content-doc-loading-strategy | removed | specs/20260212T000000-content-doc-loading-strategy.md |
| 2026-02-11 | fork-y-sweet-client | in tree | specs/20260211T200000-fork-y-sweet-client.md |
| 2026-02-11 | simplified-ytext-content-store | removed | specs/20260211T100000-simplified-ytext-content-store.md |
| 2026-02-11 | create-timeline-wrapper | removed | specs/20260211T200000-create-timeline-wrapper.md |
| 2026-02-11 | yjs-filesystem-conformance-fixes | removed | specs/20260211T200000-yjs-filesystem-conformance-fixes.md |
| 2026-02-11 | yjs-content-doc-multi-mode-research | removed | specs/20260211T220000-yjs-content-doc-multi-mode-research.md |
| 2026-02-11 | timeline-content-storage-implementation | removed | specs/20260211T230000-timeline-content-storage-implementation.md |
| 2026-02-11 | simplified-ytext-content-store-handoff | removed | specs/20260211T100000-simplified-ytext-content-store-handoff.md |
| 2026-02-10 | remove-idtopath-from-index | in tree | specs/20260210T000000-remove-idtopath-from-index.md |
| 2026-02-10 | content-storage-format-debate | in tree | specs/20260210T150000-content-storage-format-debate.md |
| 2026-02-10 | v14-content-storage-spec | in tree | specs/20260210T220000-v14-content-storage-spec.md |
| 2026-02-10 | content-lens-spec | removed | specs/20260210T000000-content-lens-spec.md |
| 2026-02-10 | mv-in-place-migration | removed | specs/20260210T000000-mv-in-place-migration.md |
| 2026-02-10 | content-format-spec | removed | specs/20260210T120000-content-format-spec.md |
| 2026-02-10 | unified-yjs-v14-markdown-editor-data-format | removed | specs/20260210T000000-unified-yjs-v14-markdown-editor-data-format.md |
| 2026-02-09 | simplify-content-doc-lifecycle | removed | specs/20260209T000000-simplify-content-doc-lifecycle.md |
| 2026-02-09 | branded-file-ids | removed | specs/20260209T120000-branded-file-ids.md |
| 2026-02-08 | example-implementation | in tree | specs/20260208T010000-example-implementation.md |
| 2026-02-08 | yjs-filesystem-spec | removed | specs/20260208T000000-yjs-filesystem-spec.md |
| 2026-02-08 | yjs-prosemirror-backing-type-analysis | removed | specs/20260208T150000-yjs-prosemirror-backing-type-analysis.md |
| 2026-02-08 | ytext-backed-prosemirror | removed | specs/20260208T150000-ytext-backed-prosemirror.md |
| 2026-02-08 | collaborative-document-architecture | removed | specs/20260208T002500-collaborative-document-architecture.md |
| 2026-02-07 | yjs-filesystem-spec | removed | specs/yjs-filesystem-spec.md |
| 2026-02-06 | consolidate-cell-keys | in tree | specs/20260206T025040-consolidate-cell-keys.md |
| 2026-02-06 | consolidate-cell-keys | removed | specs/consolidate-cell-keys.md |
| 2026-02-05 | rowstore-merge-and-batch | in tree | specs/20260205T170000-rowstore-merge-and-batch.md |
| 2026-02-05 | cli-config-and-composition | removed | specs/20260205T000000-cli-config-and-composition.md |
| 2026-02-05 | unify-extension-naming | removed | specs/20260205T110000-unify-extension-naming.md |
| 2026-02-05 | static-only-server-architecture | removed | specs/20260205T120000-static-only-server-architecture.md |
| 2026-02-04 | y-meta-stores | in tree | specs/y-meta-stores.md |
| 2026-02-03 | ingest-simplification | in tree | specs/20260203T000000-ingest-simplification.md |
| 2026-02-03 | epicenter-route-lib-reorganization | in tree | specs/20260203T010500-epicenter-route-lib-reorganization.md |
| 2026-02-03 | static-workspace-viewing | in tree | specs/20260203T100000-static-workspace-viewing.md |
| 2026-02-03 | static-workspace-registry | in tree | specs/20260203T110000-static-workspace-registry.md |
| 2026-02-03 | pr-draft | in tree | specs/pr-draft.md |
| 2026-02-03 | y-sweet-sync-extension | in tree | specs/y-sweet-sync-extension.md |
| 2026-02-03 | action-system-v2-context-passing | removed | specs/20260203T000000-action-system-v2-context-passing.md |
| 2026-02-03 | static-workspace-manifests-discovery-migration-cli | removed | specs/20260203T010000-static-workspace-manifests-discovery-migration-cli.md |
| 2026-02-03 | static-workspace-storage-and-reorganization | removed | specs/20260203T000000-static-workspace-storage-and-reorganization.md |
| 2026-02-02 | epicenter-cli-crud-commands | in tree | specs/20260202T000000-epicenter-cli-crud-commands.md |
| 2026-02-02 | consolidate-workspace-definition-inside-folder | in tree | specs/20260202T145245-consolidate-workspace-definition-inside-folder.md |
| 2026-02-02 | reddit-workspace-migration | in tree | specs/20260202T162500-reddit-workspace-migration.md |
| 2026-02-02 | modernize-tab-manager-client | in tree | specs/20260202T203000-modernize-tab-manager-client.md |
| 2026-02-02 | single-workspace-simplification | removed | specs/20260202T100000-single-workspace-simplification.md |
| 2026-02-02 | unify-table-helper-remove-untyped | removed | specs/20260202T203000-unify-table-helper-remove-untyped.md |
| 2026-02-01 | packages-epicenter-typecheck-fixes | in tree | specs/20260201T000000-packages-epicenter-typecheck-fixes.md |
| 2026-02-01 | simple-definition-first-workspace.handoff | in tree | specs/20260201T120000-simple-definition-first-workspace.handoff.md |
| 2026-02-01 | examples-and-scripts-fixes | removed | specs/20260201T000000-examples-and-scripts-fixes.md |
| 2026-02-01 | consolidate-id-types | removed | specs/20260201T025500-consolidate-id-types.md |
| 2026-02-01 | simple-definition-first-workspace | removed | specs/20260201T120000-simple-definition-first-workspace.md |
| 2026-02-01 | simple-definition-first-workspace-handoff | removed | specs/20260201T120000-simple-definition-first-workspace-handoff.md |
| 2026-01-31 | core-folder-reorganization | in tree | specs/20260131T013000-core-folder-reorganization.md |
| 2026-01-31 | core-reorganization-prompt | in tree | specs/20260131T013000-core-reorganization-prompt.md |
| 2026-01-31 | dynamic-workspace-simplification | in tree | specs/20260131T020000-dynamic-workspace-simplification.md |
| 2026-01-31 | phase1-agent-prompts | in tree | specs/20260131T021500-phase1-agent-prompts.md |
| 2026-01-31 | phase1-fix-core-violations | in tree | specs/20260131T021500-phase1-fix-core-violations.md |
| 2026-01-31 | phase2-core-restructure-evaluation | in tree | specs/20260131T021500-phase2-core-restructure-evaluation.md |
| 2026-01-31 | auto-injected-version-discriminant-v2 | in tree | specs/20260131T110000-auto-injected-version-discriminant-v2.md |
| 2026-01-31 | dynamic-workspace-architecture-simplification | in tree | specs/20260131T140200-dynamic-workspace-architecture-simplification.md |
| 2026-01-31 | consolidate-to-ykeyvalue-lww | removed | specs/20260131T030000-consolidate-to-ykeyvalue-lww.md |
| 2026-01-31 | dynamic-workspace-builder-pattern | removed | specs/20260131T154500-dynamic-workspace-builder-pattern.md |
| 2026-01-30 | unified-workspace-architecture | removed | specs/20260130T111500-unified-workspace-architecture.md |
| 2026-01-30 | grid-workspace-api | removed | specs/20260130T025939-grid-workspace-api.md |
| 2026-01-30 | unified-workspace-api-pattern | removed | specs/20260130T135852-unified-workspace-api-pattern.md |
| 2026-01-30 | consolidate-grid-into-dynamic | removed | specs/20260130T160535-consolidate-grid-into-dynamic.md |
| 2026-01-30 | transcription-latency-optimization | removed | specs/transcription-latency-optimization.md |
| 2026-01-29 | workspace-tables-kv-to-array | in tree | specs/20260129T143000-workspace-tables-kv-to-array.md |
| 2026-01-29 | implicit-table-id | in tree | specs/20260129T162000-implicit-table-id.md |
| 2026-01-29 | fields-record-to-array | removed | specs/20260129T000000-fields-record-to-array.md |
| 2026-01-29 | create-kv-tables-array-only | removed | specs/20260129T150000-create-kv-tables-array-only.md |
| 2026-01-29 | field-helpers-single-options-object | removed | specs/20260129T150000-field-helpers-single-options-object.md |
| 2026-01-29 | workspace-api-v2-cleanup | removed | specs/20260129T212116-workspace-api-v2-cleanup.md |
| 2026-01-28 | table-partitioned-storage | removed | specs/20260128T100000-table-partitioned-storage.md |
| 2026-01-28 | cell-workspace-typebox-validation | removed | specs/20260128T120000-cell-workspace-typebox-validation.md |
| 2026-01-27 | ykeyvalue-dual-implementation | removed | specs/20260127T120000-ykeyvalue-dual-implementation.md |
| 2026-01-27 | dynamic-workspace-architecture | removed | specs/20260127T150000-dynamic-workspace-architecture.md |
| 2026-01-27 | ykeyvalue-transaction-fix | removed | specs/20260127T180000-ykeyvalue-transaction-fix.md |
| 2026-01-27 | external-schema-architecture | removed | specs/20260127T220000-external-schema-architecture.md |
| 2026-01-26 | table-api-split | in tree | specs/20260126T103000-table-api-split.md |
| 2026-01-26 | static-workspace-api | removed | specs/20260126T120000-static-workspace-api.md |
| 2026-01-25 | versioned-table-kv-specification | in tree | specs/20260125T120000-versioned-table-kv-specification.md |
| 2026-01-24 | versioned-table-api-design | in tree | specs/20260124T004528-versioned-table-api-design.md |
| 2026-01-24 | workspace-schema-versioning | in tree | specs/20260124T125300-workspace-schema-versioning.md |
| 2026-01-24 | developer-experience-schema-api | in tree | specs/20260124T160000-developer-experience-schema-api.md |
| 2026-01-24 | stable-id-schema-pattern | in tree | specs/20260124T162638-stable-id-schema-pattern.md |
| 2026-01-24 | developer-experience-schema-api | in tree | specs/20260124T163000-developer-experience-schema-api.md |
| 2026-01-24 | static-schema-library-architecture | removed | specs/20260124T180000-static-schema-library-architecture.md |
| 2026-01-23 | single-workspace-architecture | in tree | specs/20260123T102500-single-workspace-architecture.md |
| 2026-01-23 | rename-fieldschema-to-field | removed | specs/20260123T103903-rename-fieldschema-to-field.md |
| 2026-01-23 | single-workspace-architecture | removed | docs/specs/20260123T102500-single-workspace-architecture.md |
| 2026-01-22 | extension-context-redesign | in tree | specs/20260122T094109-extension-context-redesign.md |
| 2026-01-22 | unified-observation-patterns | in tree | specs/20260122T105410-unified-observation-patterns.md |
| 2026-01-22 | subdoc-architecture | in tree | specs/20260122T225052-subdoc-architecture.md |
| 2026-01-22 | namespaced-helper-api | removed | packages/workspace/specs/20260122T103629-namespaced-helper-api.md |
| 2026-01-22 | callable-helper-api-execution | removed | packages/workspace/specs/20260122T105300-callable-helper-api-execution.md |
| 2026-01-22 | subdoc-architecture | removed | docs/specs/20260122T225052-subdoc-architecture.md |
| 2026-01-22 | namespaced-helper-api | removed | packages/epicenter/specs/20260122T103629-namespaced-helper-api.md |
| 2026-01-22 | callable-helper-api-execution | removed | packages/epicenter/specs/20260122T105300-callable-helper-api-execution.md |
| 2026-01-21 | workspace-doc-consolidation | in tree | specs/20260121T224728-workspace-doc-consolidation.md |
| 2026-01-21 | doc-architecture-v2 | in tree | specs/20260121T231500-doc-architecture-v2.md |
| 2026-01-21 | createclient-builder-api | removed | packages/workspace/specs/20260121T112000-createclient-builder-api.md |
| 2026-01-21 | sync-architecture | removed | specs/20260121T170000-sync-architecture.md |
| 2026-01-21 | client-builder-api-v2 | removed | specs/20260121T194849-client-builder-api-v2.md |
| 2026-01-21 | tables-sqlite-persistence-HANDOFF | removed | apps/epicenter/specs/20260121T211800-tables-sqlite-persistence-HANDOFF.md |
| 2026-01-21 | tables-sqlite-persistence | removed | apps/epicenter/specs/20260121T211800-tables-sqlite-persistence.md |
| 2026-01-21 | createclient-builder-api | removed | packages/epicenter/specs/20260121T112000-createclient-builder-api.md |
| 2026-01-19 | workspace-storage-architecture | in tree | specs/20260119T150426-workspace-storage-architecture.md |
| 2026-01-19 | resilient-client-architecture | removed | specs/20260119T231252-resilient-client-architecture.md |
| 2026-01-18 | table-api-simplification | removed | specs/20260118T112600-table-api-simplification.md |
| 2026-01-17 | workspace-input-normalization | in tree | specs/20260117T004421-workspace-input-normalization.md |
| 2026-01-17 | remove-slug-use-human-readable-id | in tree | specs/20260117T104719-remove-slug-use-human-readable-id.md |
| 2026-01-17 | workspace-api-simplification | removed | specs/20260117T160800-workspace-api-simplification.md |
| 2026-01-17 | workspace-type-consolidation | removed | specs/20260117T185700-workspace-type-consolidation.md |
| 2026-01-16 | schema-migration-patterns | removed | specs/20260116T082500-schema-migration-patterns.md |
| 2026-01-15 | contract | in tree | specs/20260115T100800-contract.md |
| 2026-01-15 | ai-generated-local-first-apps | in tree | specs/20260115T102836-ai-generated-local-first-apps.md |
| 2026-01-13 | rename-safe-workspace-architecture | in tree | specs/20260113T103600-rename-safe-workspace-architecture.md |
| 2026-01-11 | unified-local-persistence-provider | in tree | specs/20260111T122900-unified-local-persistence-provider.md |
| 2026-01-11 | live-table-definitions | in tree | specs/20260111T141856-live-table-definitions.md |
| 2026-01-11 | workspace-initialization.handoff | removed | specs/20260111T150000-workspace-initialization.handoff.md |
| 2026-01-11 | workspace-initialization-handoff | removed | specs/20260111T150000-workspace-initialization-handoff.md |
| 2026-01-09 | tables-with-metadata-only | in tree | specs/20260109T010011-tables-with-metadata-only.md |
| 2026-01-09 | opencode-integration-architecture | in tree | specs/20260109T140700-opencode-integration-architecture.md |
| 2026-01-09 | epicenter-app-three-fetch-migration | removed | specs/20260109T174900-epicenter-app-three-fetch-migration.md |
| 2026-01-08 | cli-architecture-cleanup | in tree | specs/20260108T000000-cli-architecture-cleanup.md |
| 2026-01-08 | two-layer-sidebar-architecture | in tree | specs/20260108T015500-two-layer-sidebar-architecture.md |
| 2026-01-08 | turso-wasm-vector-search | in tree | specs/20260108T053000-turso-wasm-vector-search.md |
| 2026-01-08 | collaborative-workspace-config-ydoc.handoff | removed | specs/20260108T133200-collaborative-workspace-config-ydoc.handoff.md |
| 2026-01-08 | collaborative-workspace-config-ydoc | removed | specs/20260108T133200-collaborative-workspace-config-ydoc.md |
| 2026-01-08 | workspace-create-accepts-capabilities | removed | specs/20260108T001900-workspace-create-accepts-capabilities.md |
| 2026-01-08 | ymap-native-storage-architecture | removed | specs/20260108T084500-ymap-native-storage-architecture.md |
| 2026-01-08 | collaborative-workspace-config-ydoc-handoff | removed | specs/20260108T133200-collaborative-workspace-config-ydoc-handoff.md |
| 2026-01-07 | workspace-guid-and-epochs | in tree | specs/20260107T005800-workspace-guid-and-epochs.md |
| 2026-01-07 | cell-level-crdt-merging.handoff | in tree | specs/20260107T114209-cell-level-crdt-merging.handoff.md |
| 2026-01-07 | action-system-redesign | in tree | specs/20260107T194104-action-system-redesign.md |
| 2026-01-07 | typebox-converter | in tree | specs/20260107T195500-typebox-converter.md |
| 2026-01-07 | ykeyvalue-conflict-resolution-analysis | removed | specs/20260107T010300-ykeyvalue-conflict-resolution-analysis.md |
| 2026-01-07 | ykeyvalue-lww-timestamps | removed | specs/20260107T020000-ykeyvalue-lww-timestamps.md |
| 2026-01-07 | cell-level-crdt-merging | removed | specs/20260107T114209-cell-level-crdt-merging.md |
| 2026-01-07 | cell-level-crdt-merging-HANDOFF | removed | specs/20260107T114209-cell-level-crdt-merging-HANDOFF.md |
| 2026-01-06 | remove-serialized-terminology | in tree | specs/20260106T120000-remove-serialized-terminology.md |
| 2026-01-06 | temporal-intermediate-representation | in tree | specs/20260106T212243-temporal-intermediate-representation.md |
| 2026-01-06 | json-serializable-rows | removed | specs/20260106T000000-json-serializable-rows.md |
| 2026-01-06 | schema-folder-consolidation-analysis | removed | specs/20260106T214000-schema-folder-consolidation-analysis.md |
| 2026-01-04 | inline-service-factories | in tree | specs/20260104T220141-inline-service-factories.md |
| 2026-01-04 | remove-execute-calls | removed | specs/20260104T220837-remove-execute-calls.md |
| 2026-01-02 | remove-blob-storage-from-epicenter | in tree | specs/20260102T012600-remove-blob-storage-from-epicenter.md |
| 2026-01-01 | schema-folder-separation | in tree | specs/20260101T011500-schema-folder-separation.md |

## 2025

| Date | Spec | State | Path |
|------|------|-------|------|
| 2025-12-31 | json-column-standard-schema | in tree | specs/20251231T160000-json-column-standard-schema.md |
| 2025-12-31 | introspection-boundary-article | in tree | specs/20251231T173000-introspection-boundary-article.md |
| 2025-12-31 | static-defaults-constraint | removed | specs/20251231T153000-static-defaults-constraint.md |
| 2025-12-30 | kv-store-feature | in tree | specs/20251230T132500-kv-store-feature.md |
| 2025-12-30 | table-iteration-type-safety | removed | specs/20251230T120000-table-iteration-type-safety.md |
| 2025-12-30 | blob-storage-redesign | removed | specs/20251230T160000-blob-storage-redesign.md |
| 2025-12-27 | api-namespace-restructure | in tree | specs/20251227T000000-api-namespace-restructure.md |
| 2025-12-26 | action-index-naming-inversion | in tree | specs/20251226T144100-action-index-naming-inversion.md |
| 2025-12-25 | epicenter-folder-discovery | removed | specs/20251225T210000-epicenter-folder-discovery.md |
| 2025-12-24 | remove-epicenter-id | in tree | specs/20251224T232100-remove-epicenter-id.md |
| 2025-12-21 | moonshine-integration.handoff | in tree | specs/20251221T000000-moonshine-integration.handoff.md |
| 2025-12-21 | language-settings-redesign | in tree | specs/20251221T120000-language-settings-redesign.md |
| 2025-12-21 | whispering-error-refactor | in tree | specs/20251221T120000-whispering-error-refactor.md |
| 2025-12-21 | moonshine-integration-handoff | removed | specs/20251221T000000-moonshine-integration-handoff.md |
| 2025-12-19 | skills-migration-plan | in tree | specs/20251219T120000-skills-migration-plan.md |
| 2025-12-19 | bulk-file-upload | in tree | specs/20251219T120345 bulk-file-upload.md |
| 2025-12-19 | bulk-file-upload | removed | docs/specs/20251219T120345 bulk-file-upload.md |
| 2025-12-18 | query-layer-commands-refactor | in tree | specs/20251218T194432 query-layer-commands-refactor.md |
| 2025-12-18 | query-layer-commands-refactor | removed | docs/specs/20251218T194432 query-layer-commands-refactor.md |
| 2025-12-14 | moonshine-addition-whispercpp-disable | in tree | specs/20251214T180000-moonshine-addition-whispercpp-disable.md |
| 2025-12-14 | transcribe-rs-0.2.0-upgrade | removed | specs/20251214T120000-transcribe-rs-0.2.0-upgrade.md |
| 2025-12-13 | table-config-api-redesign | in tree | specs/20251213T180000-table-config-api-redesign.md |
| 2025-12-13 | multi-device-tab-sync | in tree | specs/20251213T231125-multi-device-tab-sync.md |
| 2025-12-11 | default-dark-mode | in tree | specs/20251211T000000-default-dark-mode.md |
| 2025-12-11 | handoff-05-testing-client-compat | removed | docs/specs/handoff-05-testing-client-compat.md |
| 2025-12-10 | unified-providers-migration | removed | specs/20251210T120000-unified-providers-migration.md |
| 2025-12-09 | typescript-fix-handoff | removed | docs/specs/20251209T080000-typescript-fix-handoff.md |
| 2025-12-07 | wellcrafted-error-migration | in tree | specs/20251207T120000-wellcrafted-error-migration.md |
| 2025-12-06 | wxt-browser-extension | in tree | specs/20251206T120000-wxt-browser-extension.md |
| 2025-12-06 | button-link-tooltip-integration | in tree | specs/20251206T120603-button-link-tooltip-integration.md |
| 2025-12-06 | table-helper-status-api | in tree | specs/20251206T201800-table-helper-status-api.md |
| 2025-12-06 | remove-elysia-mcp | removed | packages/workspace/specs/20251206T010000-remove-elysia-mcp.md |
| 2025-12-06 | button-link-tooltip-integration | removed | docs/specs/20251206T120603-button-link-tooltip-integration.md |
| 2025-12-06 | remove-elysia-mcp | removed | packages/epicenter/specs/20251206T010000-remove-elysia-mcp.md |
| 2025-12-05 | yjs-stress-test | in tree | specs/20251205T162000-yjs-stress-test.md |
| 2025-12-05 | sqlite-index-batching | in tree | specs/20251205T164620-sqlite-index-batching.md |
| 2025-12-05 | migrate-hono-to-elysia | removed | packages/workspace/specs/20251205T175550-migrate-hono-to-elysia.md |
| 2025-12-05 | migrate-hono-to-elysia | removed | packages/epicenter/specs/20251205T175550-migrate-hono-to-elysia.md |
| 2025-12-04 | vad-createsubscriber-refactor | in tree | specs/20251204T015007 vad-createsubscriber-refactor.md |
| 2025-12-04 | vad-createsubscriber-refactor | removed | docs/specs/20251204T015007 vad-createsubscriber-refactor.md |
| 2025-12-03 | rename-repo-to-epicenter | in tree | specs/20251203T161900-rename-repo-to-epicenter.md |
| 2025-12-02 | simplify-verticalnav-pr | in tree | specs/20251202T220000-simplify-verticalnav-pr.md |
| 2025-12-02 | simplify-verticalnav-pr | removed | docs/specs/20251202T220000-simplify-verticalnav-pr.md |
| 2025-12-02 | custom-sounds-reimplementation | removed | apps/whispering/specs/20251202T163000-custom-sounds-reimplementation.md |
| 2025-12-01 | wiki-workspace | in tree | specs/20251201T000000-wiki-workspace.md |
| 2025-12-01 | wiki-workspace | removed | docs/specs/20251201T000000-wiki-workspace.md |
| 2025-11-29 | enter-after-transcription | in tree | specs/20251129T000000-enter-after-transcription.md |
| 2025-11-29 | transcribed-text-to-transcript-data-refactor | in tree | specs/20251129T000000-transcribed-text-to-transcript-data-refactor.md |
| 2025-11-29 | remove-v7.7-migration | removed | specs/20251129T000000-remove-v7.7-migration.md |
| 2025-11-29 | transcribedText-to-transcript-refactor | removed | specs/20251129T120000-transcribedText-to-transcript-refactor.md |
| 2025-11-28 | catalog-hygiene | in tree | specs/20251128T085903-catalog-hygiene.md |
| 2025-11-28 | zod-v4-migration | in tree | specs/20251128T100000-zod-v4-migration.md |
| 2025-11-28 | bits-ui-migration | in tree | specs/20251128T110000-bits-ui-migration.md |
| 2025-11-28 | spec-organization-refactor | in tree | specs/20251128T120000-spec-organization-refactor.md |
| 2025-11-28 | migrate-specs-to-root-level | in tree | specs/20251128T130000-migrate-specs-to-root-level.md |
| 2025-11-28 | organize-markdown-files | in tree | specs/20251128T140000-organize-markdown-files.md |
| 2025-11-28 | homebrew-cask-rename | in tree | specs/20251128T154007 homebrew-cask-rename.md |
| 2025-11-28 | homebrew-cask-rename | removed | docs/specs/20251128T154007 homebrew-cask-rename.md |
| 2025-11-28 | spec-organization-refactor | removed | docs/specs/20251128T120000-spec-organization-refactor.md |
| 2025-11-28 | migrate-specs-to-root-level | removed | docs/specs/20251128T130000-migrate-specs-to-root-level.md |
| 2025-11-28 | bits-ui-migration | removed | docs/specs/20251128T110000-bits-ui-migration.md |
| 2025-11-28 | zod-v4-migration | removed | docs/specs/20251128T100000-zod-v4-migration.md |
| 2025-11-28 | catalog-hygiene | removed | docs/specs/20251128T085903-catalog-hygiene.md |
| 2025-11-27 | gmail-workspace | removed | specs/20251127T165000-gmail-workspace.md |
| 2025-11-27 | gmail-workspace | removed | docs/specs/20251127T165000-gmail-workspace.md |
| 2025-11-26 | flatten-db-namespace | in tree | specs/20251126T083538-flatten-db-namespace.md |
| 2025-11-26 | fix-lucide-imports | removed | specs/20251126T095145 fix-lucide-imports.md |
| 2025-11-26 | consolidate-posts-workspace | removed | examples/content-hub/docs/specs/20251126T121500-consolidate-posts-workspace.md |
| 2025-11-26 | flatten-db-namespace | removed | docs/specs/20251126T083538-flatten-db-namespace.md |
| 2025-11-26 | fix-lucide-imports | removed | docs/specs/20251126T095145 fix-lucide-imports.md |
| 2025-11-25 | async-destroy-cleanup | removed | packages/workspace/specs/20251125T090506-async-destroy-cleanup.md |
| 2025-11-25 | async-destroy-cleanup | removed | packages/epicenter/specs/20251125T090506-async-destroy-cleanup.md |
| 2025-11-25 | async-destroy-cleanup | removed | packages/epicenter/docs/specs/20251125T090506-async-destroy-cleanup.md |
| 2025-11-21 | remove-assistant-rebuild | in tree | specs/20251121T171358 remove-assistant-rebuild.md |
| 2025-11-21 | remove-assistant-rebuild | removed | docs/specs/20251121T171358 remove-assistant-rebuild.md |
| 2025-11-14 | transform-dates-validation | in tree | specs/20251114T190000-transform-dates-validation.md |
| 2025-11-14 | mit-to-agpl-migration | removed | specs/20251114T042734 mit-to-agpl-migration.md |
| 2025-11-14 | transform-dates-validation | removed | docs/specs/20251114T190000-transform-dates-validation.md |
| 2025-11-14 | ffmpeg-stop-fix | removed | docs/specs/20251114T000000 ffmpeg-stop-fix.md |
| 2025-11-14 | mit-to-agpl-migration | removed | docs/specs/20251114T042734 mit-to-agpl-migration.md |
| 2025-11-14 | pr-draft | removed | docs/specs/pr-draft.md |
| 2025-11-13 | workspace-exports-pattern | in tree | specs/20251113T000000-workspace-exports-pattern.md |
| 2025-11-13 | workspace-exports-pattern | removed | docs/specs/20251113T000000-workspace-exports-pattern.md |
| 2025-11-12 | release-7.7.2 | in tree | specs/20251112T202614 release-7.7.2.md |
| 2025-11-12 | index-barrel-file-refactor | removed | specs/20251112T131207-index-barrel-file-refactor.md |
| 2025-11-12 | sqlite-schema-namespace-refactor | removed | specs/20251112T132055-sqlite-schema-namespace-refactor.md |
| 2025-11-12 | release-7.7.2 | removed | docs/specs/20251112T202614 release-7.7.2.md |
| 2025-11-12 | index-barrel-file-refactor | removed | docs/specs/20251112T131207-index-barrel-file-refactor.md |
| 2025-11-12 | sqlite-schema-namespace-refactor | removed | docs/specs/20251112T132055-sqlite-schema-namespace-refactor.md |
| 2025-11-11 | tags-column-with-optional-validation | removed | specs/20251111T030906 tags-column-with-optional-validation.md |
| 2025-11-11 | tags-column-with-optional-validation | removed | docs/specs/20251111T030906 tags-column-with-optional-validation.md |
| 2025-11-10 | journal-workspace | in tree | specs/20251110T160000 journal-workspace.md |
| 2025-11-10 | journal-workspace | removed | docs/specs/20251110T160000 journal-workspace.md |
| 2025-11-09 | update-pages-workspace-schema | in tree | specs/20251109T025000 update-pages-workspace-schema.md |
| 2025-11-09 | update-pages-workspace-schema | removed | docs/specs/20251109T025000 update-pages-workspace-schema.md |
| 2025-11-07 | readme-version-workflow-fix | in tree | specs/20251107T105035-readme-version-workflow-fix.md |
| 2025-11-07 | readme-version-workflow-fix | removed | docs/specs/20251107T105035-readme-version-workflow-fix.md |
| 2025-11-06 | fix-migration-cleanup | in tree | specs/20251106T140000 fix-migration-cleanup.md |
| 2025-11-06 | reposition-migration-button | in tree | specs/20251106T150000 reposition-migration-button.md |
| 2025-11-06 | settings-ui-clarity | in tree | specs/20251106T174230 settings-ui-clarity.md |
| 2025-11-06 | settings-ui-clarity | removed | docs/specs/20251106T174230 settings-ui-clarity.md |
| 2025-11-06 | reposition-migration-button | removed | docs/specs/20251106T150000 reposition-migration-button.md |
| 2025-11-06 | fix-migration-cleanup | removed | docs/specs/20251106T140000 fix-migration-cleanup.md |
| 2025-11-05 | _subpath-exports | in tree | specs/20251105T150000_subpath-exports.md |
| 2025-11-05 | _error-handling-pattern-unknown-errors | removed | specs/20251105T000000_error-handling-pattern-unknown-errors.md |
| 2025-11-05 | _error-handling-pattern-unknown-errors | removed | docs/specs/20251105T000000_error-handling-pattern-unknown-errors.md |
| 2025-11-05 | _subpath-exports | removed | docs/specs/20251105T150000_subpath-exports.md |
| 2025-11-04 | markdown-index-path-resolution-fix | in tree | specs/20251104T000000 markdown-index-path-resolution-fix.md |
| 2025-11-04 | simplify-markdown-index-signatures | in tree | specs/20251104T000000 simplify-markdown-index-signatures.md |
| 2025-11-04 | fix-whispercpp-linux-crash | in tree | specs/20251104T120953 fix-whispercpp-linux-crash.md |
| 2025-11-04 | fix-whispercpp-linux-crash | removed | docs/specs/20251104T120953 fix-whispercpp-linux-crash.md |
| 2025-11-04 | simplify-markdown-index-signatures | removed | docs/specs/20251104T000000 simplify-markdown-index-signatures.md |
| 2025-11-04 | markdown-index-path-resolution-fix | removed | docs/specs/20251104T000000 markdown-index-path-resolution-fix.md |
| 2025-11-03 | pr-preview-builds | in tree | specs/20251103T000000 pr-preview-builds.md |
| 2025-11-03 | config-relative-path-resolution | in tree | specs/20251103T175503 config-relative-path-resolution.md |
| 2025-11-03 | move-examples-to-root | in tree | specs/20251103T180000 move-examples-to-root.md |
| 2025-11-03 | fix-content-hub-type-errors | in tree | specs/20251103T193500-fix-content-hub-type-errors.md |
| 2025-11-03 | cloudflare-workers-migration | in tree | specs/20251103T214214 cloudflare-workers-migration.md |
| 2025-11-03 | rename-content-to-body-markdown-index | in tree | specs/20251103T214530 rename-content-to-body-markdown-index.md |
| 2025-11-03 | cloudflare-workers-migration | removed | docs/specs/20251103T214214 cloudflare-workers-migration.md |
| 2025-11-03 | rename-content-to-body-markdown-index | removed | docs/specs/20251103T214530 rename-content-to-body-markdown-index.md |
| 2025-11-03 | fix-content-hub-type-errors | removed | docs/specs/20251103T193500-fix-content-hub-type-errors.md |
| 2025-11-03 | move-examples-to-root | removed | docs/specs/20251103T180000 move-examples-to-root.md |
| 2025-11-03 | pr-preview-builds | removed | docs/specs/20251103T000000 pr-preview-builds.md |
| 2025-11-03 | config-relative-path-resolution | removed | docs/specs/20251103T175503 config-relative-path-resolution.md |
| 2025-11-02 | content-hub-workspace-restructuring | in tree | specs/20251102T000000 content-hub-workspace-restructuring.md |
| 2025-11-02 | content-hub-workspace-restructuring | removed | docs/specs/20251102T000000 content-hub-workspace-restructuring.md |
| 2025-11-01 | table-helpers-query-mutations | in tree | specs/20251101T120000 table-helpers-query-mutations.md |
| 2025-11-01 | migrate-yjs-datewithtimezone-to-string | removed | specs/20251101T000000 migrate-yjs-datewithtimezone-to-string.md |
| 2025-11-01 | table-helpers-query-mutations | removed | docs/specs/20251101T120000 table-helpers-query-mutations.md |
| 2025-11-01 | migrate-yjs-datewithtimezone-to-string | removed | docs/specs/20251101T000000 migrate-yjs-datewithtimezone-to-string.md |
| 2025-10-30 | delete-transformation-runs | in tree | specs/20251030T000000 delete-transformation-runs.md |
| 2025-10-30 | persistence-factory-pattern | in tree | specs/20251030T000000 persistence-factory-pattern.md |
| 2025-10-30 | sqlite-config-inversion | in tree | specs/20251030T120000 sqlite-config-inversion.md |
| 2025-10-30 | optimize-transformation-runs-queries | in tree | specs/20251030T203253 optimize-transformation-runs-queries.md |
| 2025-10-30 | optimize-transformation-runs-queries | removed | docs/specs/20251030T203253 optimize-transformation-runs-queries.md |
| 2025-10-30 | delete-transformation-runs | removed | docs/specs/20251030T000000 delete-transformation-runs.md |
| 2025-10-30 | sqlite-config-inversion | removed | docs/specs/20251030T120000 sqlite-config-inversion.md |
| 2025-10-30 | persistence-factory-pattern | removed | docs/specs/20251030T000000 persistence-factory-pattern.md |
| 2025-10-29 | fix-recording-id-type | in tree | specs/20251029T000000 fix-recording-id-type.md |
| 2025-10-29 | open-data-folders | in tree | specs/20251029T120000 open-data-folders.md |
| 2025-10-29 | vertical-nav | in tree | specs/20251029T143423-vertical-nav.md |
| 2025-10-29 | vertical-nav | removed | docs/specs/20251029T143423-vertical-nav.md |
| 2025-10-29 | open-data-folders | removed | docs/specs/20251029T120000 open-data-folders.md |
| 2025-10-29 | fix-recording-id-type | removed | docs/specs/20251029T000000 fix-recording-id-type.md |
| 2025-10-28 | fix-audio-playback-desktop | in tree | specs/20251028T134906 fix-audio-playback-desktop.md |
| 2025-10-28 | fix-audio-playback-desktop | removed | docs/specs/20251028T134906 fix-audio-playback-desktop.md |
| 2025-10-27 | appDataDir-analysis | in tree | specs/20251027T000000 appDataDir-analysis.md |
| 2025-10-27 | comprehensive-path-restructuring | in tree | specs/20251027T000000 comprehensive-path-restructuring.md |
| 2025-10-27 | fix-appDataDir-redundancy | in tree | specs/20251027T000000 fix-appDataDir-redundancy.md |
| 2025-10-27 | db-service-platform-split | in tree | specs/20251027T120000 db-service-platform-split.md |
| 2025-10-27 | db-phase-2-file-system | in tree | specs/20251027T140000 db-phase-2-file-system.md |
| 2025-10-27 | transform-clipboard-command | in tree | specs/20251027T172102 transform-clipboard-command.md |
| 2025-10-27 | transformation-picker-separate-window | removed | specs/20251027T000000 transformation-picker-separate-window.md |
| 2025-10-27 | transformation-picker-separate-window | removed | docs/specs/20251027T000000 transformation-picker-separate-window.md |
| 2025-10-27 | transform-clipboard-command | removed | docs/specs/20251027T172102 transform-clipboard-command.md |
| 2025-10-27 | appDataDir-analysis | removed | docs/specs/20251027T000000 appDataDir-analysis.md |
| 2025-10-27 | comprehensive-path-restructuring | removed | docs/specs/20251027T000000 comprehensive-path-restructuring.md |
| 2025-10-27 | fix-appDataDir-redundancy | removed | docs/specs/20251027T000000 fix-appDataDir-redundancy.md |
| 2025-10-27 | db-phase-2-file-system | removed | docs/specs/20251027T140000 db-phase-2-file-system.md |
| 2025-10-27 | db-service-platform-split | removed | docs/specs/20251027T120000 db-service-platform-split.md |
| 2025-10-24 | parser-validation-refactor | removed | packages/workspace/specs/20251024T000000-parser-validation-refactor.md |
| 2025-10-24 | workspace-persistence-array | removed | packages/workspace/specs/20251024T120000-workspace-persistence-array.md |
| 2025-10-24 | parser-validation-refactor | removed | packages/epicenter/specs/20251024T000000-parser-validation-refactor.md |
| 2025-10-24 | workspace-persistence-array | removed | packages/epicenter/specs/20251024T120000-workspace-persistence-array.md |
| 2025-10-24 | parser-validation-refactor | removed | packages/epicenter/docs/specs/20251024T000000-parser-validation-refactor.md |
| 2025-10-24 | workspace-persistence-array | removed | packages/epicenter/docs/specs/20251024T120000-workspace-persistence-array.md |
| 2025-10-22 | consolidate-cli-package | removed | packages/workspace/specs/20251022T174038-consolidate-cli-package.md |
| 2025-10-22 | markdown-index-serialization-refactor | removed | packages/workspace/specs/20251022T180000-markdown-index-serialization-refactor.md |
| 2025-10-22 | improve-actions-introspection | removed | packages/workspace/specs/20251022T220000-improve-actions-introspection.md |
| 2025-10-22 | consolidate-cli-package | removed | packages/epicenter/specs/20251022T174038-consolidate-cli-package.md |
| 2025-10-22 | markdown-index-serialization-refactor | removed | packages/epicenter/specs/20251022T180000-markdown-index-serialization-refactor.md |
| 2025-10-22 | improve-actions-introspection | removed | packages/epicenter/specs/20251022T220000-improve-actions-introspection.md |
| 2025-10-22 | improve-actions-introspection | removed | packages/epicenter/docs/specs/20251022T220000-improve-actions-introspection.md |
| 2025-10-22 | markdown-index-serialization-refactor | removed | packages/epicenter/docs/specs/20251022T180000-markdown-index-serialization-refactor.md |
| 2025-10-22 | consolidate-cli-package | removed | packages/epicenter/docs/specs/20251022T174038-consolidate-cli-package.md |
| 2025-10-21 | split-epicenter | in tree | specs/20251021T000001-split-epicenter.md |
| 2025-10-21 | workspace-client-relationship-docs | in tree | specs/20251021T235000-workspace-client-relationship-docs.md |
| 2025-10-21 | standardize-storage-locations | removed | packages/workspace/specs/20251021T000003-standardize-storage-locations.md |
| 2025-10-21 | extract-storage-dir-constant | removed | packages/workspace/specs/20251021T000004-extract-storage-dir-constant.md |
| 2025-10-21 | refactor-cli-tests | removed | packages/workspace/specs/20251021T233339-refactor-cli-tests.md |
| 2025-10-21 | standardize-storage-locations | removed | packages/epicenter/specs/20251021T000003-standardize-storage-locations.md |
| 2025-10-21 | extract-storage-dir-constant | removed | packages/epicenter/specs/20251021T000004-extract-storage-dir-constant.md |
| 2025-10-21 | refactor-cli-tests | removed | packages/epicenter/specs/20251021T233339-refactor-cli-tests.md |
| 2025-10-21 | refactor-cli-tests | removed | packages/epicenter/docs/specs/20251021T233339-refactor-cli-tests.md |
| 2025-10-21 | workspace-client-relationship-docs | removed | docs/specs/20251021T235000-workspace-client-relationship-docs.md |
| 2025-10-21 | extract-storage-dir-constant | removed | packages/epicenter/docs/specs/20251021T000004-extract-storage-dir-constant.md |
| 2025-10-21 | standardize-storage-locations | removed | packages/epicenter/docs/specs/20251021T000003-standardize-storage-locations.md |
| 2025-10-21 | split-epicenter | removed | docs/specs/20251021T000001-split-epicenter.md |
| 2025-10-20 | vulkan-support-cpu-only-fix | removed | docs/specs/20251020T044154 vulkan-support-cpu-only-fix.md |
| 2025-10-20 | vulkan-runtime-compat | removed | docs/specs/20251020T044146 vulkan-runtime-compat.md |
| 2025-10-20 | vulkan-compat | removed | docs/specs/20251020T043952 vulkan-compat.md |
| 2025-10-20 | fix-intellisense-core-types | removed | docs/specs/20251020T042301 fix-intellisense-core-types.md |
| 2025-10-20 | fix-type-intellisense | removed | docs/specs/20251020T042152 fix-type-intellisense.md |
| 2025-10-19 | replace-symbol-dispose-with-destroy | removed | packages/workspace/specs/20251019T000000-replace-symbol-dispose-with-destroy.md |
| 2025-10-19 | type-safety-improvements-client | removed | packages/workspace/specs/20251019T000001-type-safety-improvements-client.md |
| 2025-10-19 | dependency-testing-examples | removed | packages/workspace/specs/20251019T130000-dependency-testing-examples.md |
| 2025-10-19 | simplify-mcp-with-typebox | removed | packages/workspace/specs/20251019T140000-simplify-mcp-with-typebox.md |
| 2025-10-19 | replace-symbol-dispose-with-destroy | removed | packages/epicenter/specs/20251019T000000-replace-symbol-dispose-with-destroy.md |
| 2025-10-19 | type-safety-improvements-client | removed | packages/epicenter/specs/20251019T000001-type-safety-improvements-client.md |
| 2025-10-19 | dependency-testing-examples | removed | packages/epicenter/specs/20251019T130000-dependency-testing-examples.md |
| 2025-10-19 | simplify-mcp-with-typebox | removed | packages/epicenter/specs/20251019T140000-simplify-mcp-with-typebox.md |
| 2025-10-19 | simplify-mcp-with-typebox | removed | packages/epicenter/docs/specs/20251019T140000-simplify-mcp-with-typebox.md |
| 2025-10-19 | replace-symbol-dispose-with-destroy | removed | packages/epicenter/docs/specs/20251019T000000-replace-symbol-dispose-with-destroy.md |
| 2025-10-19 | type-safety-improvements-client | removed | packages/epicenter/docs/specs/20251019T000001-type-safety-improvements-client.md |
| 2025-10-19 | dependency-testing-examples | removed | packages/epicenter/docs/specs/20251019T130000-dependency-testing-examples.md |
| 2025-10-17 | simplify-workspace-index-map-generics | in tree | specs/20251017T000000-simplify-workspace-index-map-generics.md |
| 2025-10-17 | remove-runtime-config | in tree | specs/20251017T120007-remove-runtime-config.md |
| 2025-10-17 | cli-architecture-fix | in tree | specs/20251017T140000-cli-architecture-fix.md |
| 2025-10-17 | disable-yxmlfragment | removed | packages/workspace/specs/20251017T113727-disable-yxmlfragment.md |
| 2025-10-17 | disable-yxmlfragment | removed | packages/epicenter/specs/20251017T113727-disable-yxmlfragment.md |
| 2025-10-17 | cli-architecture-fix | removed | docs/specs/20251017T140000-cli-architecture-fix.md |
| 2025-10-17 | simplify-workspace-index-map-generics | removed | docs/specs/20251017T000000-simplify-workspace-index-map-generics.md |
| 2025-10-17 | remove-runtime-config | removed | docs/specs/20251017T120007-remove-runtime-config.md |
| 2025-10-17 | disable-yxmlfragment | removed | packages/epicenter/docs/specs/20251017T113727-disable-yxmlfragment.md |
| 2025-10-14 | epicenter-server | in tree | specs/20251014T101252 epicenter-server.md |
| 2025-10-14 | unify-workspace-initialization | removed | packages/workspace/specs/20251014T105747 unify-workspace-initialization.md |
| 2025-10-14 | bidirectional-markdown-sync | removed | packages/workspace/specs/20251014T105903 bidirectional-markdown-sync.md |
| 2025-10-14 | unify-workspace-initialization | removed | packages/epicenter/specs/20251014T105747 unify-workspace-initialization.md |
| 2025-10-14 | bidirectional-markdown-sync | removed | packages/epicenter/specs/20251014T105903 bidirectional-markdown-sync.md |
| 2025-10-14 | bidirectional-markdown-sync | removed | packages/epicenter/docs/specs/20251014T105903 bidirectional-markdown-sync.md |
| 2025-10-14 | epicenter-server | removed | docs/specs/20251014T101252 epicenter-server.md |
| 2025-10-14 | unify-workspace-initialization | removed | packages/epicenter/docs/specs/20251014T105747 unify-workspace-initialization.md |
| 2025-10-13 | workspace-version-number | in tree | specs/20251013T000001 workspace-version-number.md |
| 2025-10-13 | db-service-namespacing | in tree | specs/20251013T100000 db-service-namespacing.md |
| 2025-10-13 | query-layer-consolidation | in tree | specs/20251013T110000 query-layer-consolidation.md |
| 2025-10-13 | persistent-model-manager-implementation | in tree | specs/20251013T151500-persistent-model-manager-implementation.md |
| 2025-10-13 | persistent-model-manager-complete | in tree | specs/20251013T153000-persistent-model-manager-complete.md |
| 2025-10-13 | database-service-review | removed | specs/20251013T093533 database-service-review.md |
| 2025-10-13 | persistent-model-manager-implementation | removed | docs/specs/20251013T151500-persistent-model-manager-implementation.md |
| 2025-10-13 | persistent-model-manager-complete | removed | docs/specs/20251013T153000-persistent-model-manager-complete.md |
| 2025-10-13 | query-layer-consolidation | removed | docs/specs/20251013T110000 query-layer-consolidation.md |
| 2025-10-13 | db-service-namespacing | removed | docs/specs/20251013T100000 db-service-namespacing.md |
| 2025-10-13 | workspace-version-number | removed | docs/specs/20251013T000001 workspace-version-number.md |
| 2025-10-13 | database-service-review | removed | docs/specs/20251013T093533 database-service-review.md |
| 2025-10-12 | recording-method-clarity | in tree | specs/20251012T000000 recording-method-clarity.md |
| 2025-10-12 | recording-method-warnings | in tree | specs/20251012T133827 recording-method-warnings.md |
| 2025-10-12 | recording-method-warnings | removed | docs/specs/20251012T133827 recording-method-warnings.md |
| 2025-10-12 | recording-method-clarity | removed | docs/specs/20251012T000000 recording-method-clarity.md |
| 2025-10-10 | rust-audio-fallback | in tree | specs/20251010T085046 rust-audio-fallback.md |
| 2025-10-10 | rust-audio-fallback | removed | docs/specs/20251010T085046 rust-audio-fallback.md |
| 2025-10-06 | linux-vad-limitation | in tree | specs/20251006T181526 linux-vad-limitation.md |
| 2025-10-06 | linux-vad-limitation | removed | docs/specs/20251006T181526 linux-vad-limitation.md |
| 2025-10-03 | vault-core-minimal-overview | removed | docs/specs/20251003T220750 vault-core-minimal-overview.md |
| 2025-10-01 | vault-collaborative-workspaces | removed | specs/20251001T175148 vault-collaborative-workspaces.md |
| 2025-10-01 | vault-collaborative-workspaces | removed | docs/specs/20251001T175148 vault-collaborative-workspaces.md |
| 2025-09-24 | shared-tsconfig | in tree | specs/20250924T143150-shared-tsconfig.md |
| 2025-09-24 | shared-tsconfig | removed | docs/specs/20250924T143150-shared-tsconfig.md |
| 2025-08-19 | vault-architecture | removed | docs/specs/20250819T155643-vault-architecture.md |
| 2025-08-13 | reddit-adapter | removed | specs/20250813T140918-reddit-adapter.md |
| 2025-08-13 | reddit-adapter | removed | docs/specs/20250813T140918-reddit-adapter.md |
| 2025-08-11 | modular-mcp-adapter | removed | specs/20250811T153717-modular-mcp-adapter.md |
| 2025-08-11 | modular-mcp-adapter | removed | docs/specs/20250811T153717-modular-mcp-adapter.md |
| 2025-07-29 | page-seo | removed | apps/sh/docs/specs/20250729T120000-page-seo.md |
| 2025-07-25 | pnpm-to-bun-migration | in tree | specs/20250725T153000-pnpm-to-bun-migration.md |
| 2025-07-25 | pnpm-to-bun-migration | removed | docs/specs/20250725T153000-pnpm-to-bun-migration.md |
| 2025-07-24 | effect-comparison | removed | packages/wellcrafted/specs/launch/effect-comparison.md |
| 2025-07-24 | platform-posts | removed | packages/wellcrafted/specs/launch/platform-posts.md |
| 2025-07-21 | messages-ui-improvement | removed | specs/20250721T100000-messages-ui-improvement.md |
| 2025-07-21 | markdown-display-improvement | removed | specs/20250721T101500-markdown-display-improvement.md |
| 2025-07-21 | sessions-table-layout | removed | specs/20250721T123000-sessions-table-layout.md |
| 2025-07-21 | messages-ui-improvement | removed | docs/specs/20250721T100000-messages-ui-improvement.md |
| 2025-07-21 | markdown-display-improvement | removed | docs/specs/20250721T101500-markdown-display-improvement.md |
| 2025-07-21 | sessions-table-layout | removed | docs/specs/20250721T123000-sessions-table-layout.md |
| 2025-07-20 | messages-ui-improvement | removed | specs/20250720T174014-messages-ui-improvement.md |
| 2025-07-20 | messages-ui-improvement | removed | docs/specs/20250720T174014-messages-ui-improvement.md |
| 2025-07-19 | multi-server-architecture | removed | specs/20250719T211951 multi-server-architecture.md |
| 2025-07-19 | multi-server-architecture | removed | docs/specs/20250719T211951 multi-server-architecture.md |
| 2025-07-16 | rename-fetchcached-method | removed | packages/wellcrafted/specs/20250716T000000-rename-fetchcached-method.md |
| 2025-07-08 | github-issues-theme-analysis | in tree | specs/20250708T000000-github-issues-theme-analysis.md |
| 2025-07-08 | v7-release-notes-improvement | in tree | specs/20250708T000000-v7-release-notes-improvement.md |
| 2025-07-08 | reorganize-repository-structure | in tree | specs/20250708T120000-reorganize-repository-structure.md |
| 2025-07-08 | installation-section-redesign | in tree | specs/20250708T230000-installation-section-redesign.md |
| 2025-07-08 | github-issues-theme-analysis | removed | docs/specs/20250708T000000-github-issues-theme-analysis.md |
| 2025-07-08 | reorganize-repository-structure | removed | docs/specs/20250708T120000-reorganize-repository-structure.md |
| 2025-07-08 | installation-section-redesign | removed | docs/specs/20250708T230000-installation-section-redesign.md |
| 2025-07-05 | consolidate-shortcut-defaults | in tree | apps/whispering/specs/20250705T230000-consolidate-shortcut-defaults.md |
| 2025-07-05 | consolidate-shortcut-defaults | removed | apps/app/specs/20250705T230000-consolidate-shortcut-defaults.md |
| 2025-07-03 | comprehensive-documentation-enhancement | removed | packages/wellcrafted/specs/20250703T180845 comprehensive-documentation-enhancement.md |
| 2025-07-03 | epicenter-to-wellcrafted-migration | removed | specs/20250703T000000-epicenter-to-wellcrafted-migration.md |
| 2025-06-30 | blog-post | removed | packages/wellcrafted/specs/launch/20250630T120000-blog-post.md |
| 2025-06-30 | discriminated-union-improvements | removed | specs/20250630T135523 discriminated-union-improvements.md |
| 2025-06-30 | constants-barrel-refactoring | removed | specs/20250630T084800 constants-barrel-refactoring.md |
| 2025-06-30 | constants-README | removed | specs/constants-README.md |
| 2025-06-25 | version-management-best-practices | removed | specs/20250625T084500-version-management-best-practices.md |
| 2025-06-24 | refactor-error-config | removed | specs/20250624T065427 refactor-error-config.md |
| 2025-06-18 | wellcrafted-migration-plan | removed | packages/wellcrafted/specs/20250618T131515 wellcrafted-migration-plan.md |
| 2025-06-18 | overhaul-keyboard-shortcuts-ui | removed | specs/overhaul-keyboard-shortcuts-ui.md |
| 2025-06-17 | recording-mode-configuration-system | removed | specs/recording-mode-configuration-system.md |
| 2025-06-17 | shadcn-svelte-claude-best-practices | removed | specs/shadcn-svelte-claude-best-practices.md |
| 2025-06-17 | decouple-recorder-services | removed | specs/decouple-recorder-services.md |
| 2025-06-17 | split-manual-tauri-recording-modes | removed | specs/split-manual-tauri-recording-modes.md |
| 2025-05-28 | transformation-schema-versioning | in tree | specs/20250528T000000-transformation-schema-versioning.md |
| 2025-05-28 | transformation-schema-versioning | removed | docs/specs/20250528T000000-transformation-schema-versioning.md |
| 2025-02-12 | dynamic-row-index-optimization | removed | specs/20250212T124600-dynamic-row-index-optimization.md |
| 2025-02-03 | epicenter-migration | in tree | specs/20250203T000000 epicenter-migration.md |
| 2025-02-03 | closure-based-actions | in tree | specs/20250203T150000-closure-based-actions.md |
| 2025-02-03 | epicenter-migration | removed | docs/specs/20250203T000000 epicenter-migration.md |
| 2025-01-29 | remove-port-field-from-storage | removed | specs/20250129T183000-remove-port-field-from-storage.md |
| 2025-01-29 | refactor-browser-service-to-bun-shell | removed | specs/20250129T213000-refactor-browser-service-to-bun-shell.md |
| 2025-01-29 | documentation-update-plan | removed | packages/wellcrafted/specs/20250129T160000-documentation-update-plan.md |
| 2025-01-29 | wellcrafted-result-migration | removed | packages/wellcrafted/specs/20250129T150000-wellcrafted-result-migration.md |
| 2025-01-29 | refactor-browser-service-to-bun-shell | removed | docs/specs/20250129T213000-refactor-browser-service-to-bun-shell.md |
| 2025-01-29 | remove-port-field-from-storage | removed | docs/specs/20250129T183000-remove-port-field-from-storage.md |
| 2025-01-29 | constants-reorganization | removed | specs/20250129T183000 constants-reorganization.md |
| 2025-01-28 | app-constants-organization | in tree | specs/20250128T123045 app-constants-organization.md |
| 2025-01-28 | bun-shell-alternatives | in tree | specs/20250128T125500-bun-shell-alternatives.md |
| 2025-01-28 | bun-shell-alternatives | removed | docs/specs/20250128T125500-bun-shell-alternatives.md |
| 2025-01-28 | app-constants-organization | removed | docs/specs/20250128T123045 app-constants-organization.md |
| 2025-01-27 | bun-to-pnpm-migration | removed | docs/specs/20250127T195500-bun-to-pnpm-migration.md |
| 2025-01-25 | consolidated-settings-migration | removed | specs/20250125T123456-consolidated-settings-migration.md |
| 2025-01-22 | cpal-recorder-device-fallback | in tree | apps/whispering/specs/20250122T202045-cpal-recorder-device-fallback.md |
| 2025-01-22 | alt-key-macos-option1-plan | in tree | apps/whispering/specs/20250122T212045-alt-key-macos-option1-plan.md |
| 2025-01-22 | macos-option-dead-keys-analysis | in tree | apps/whispering/specs/20250122T215000-macos-option-dead-keys-analysis.md |
| 2025-01-22 | macos-dead-keys-implementation-plan | in tree | apps/whispering/specs/20250122T215500-macos-dead-keys-implementation-plan.md |
| 2025-01-22 | keyboard-layout-code-analysis | in tree | apps/whispering/specs/20250122T220500-keyboard-layout-code-analysis.md |
| 2025-01-22 | alt-key-macos-option1-plan | removed | apps/app/specs/20250122T212045-alt-key-macos-option1-plan.md |
| 2025-01-22 | macos-option-dead-keys-analysis | removed | apps/app/specs/20250122T215000-macos-option-dead-keys-analysis.md |
| 2025-01-22 | macos-dead-keys-implementation-plan | removed | apps/app/specs/20250122T215500-macos-dead-keys-implementation-plan.md |
| 2025-01-22 | keyboard-layout-code-analysis | removed | apps/app/specs/20250122T220500-keyboard-layout-code-analysis.md |
| 2025-01-22 | cpal-recorder-device-fallback | removed | apps/app/specs/20250122T202045-cpal-recorder-device-fallback.md |
| 2025-01-21 | yc-demo-script | in tree | specs/20250121T180000-yc-demo-script.md |
| 2025-01-21 | dictation-feature | in tree | specs/20250121T180500-dictation-feature.md |
| 2025-01-21 | deepgram-api-integration | removed | apps/whispering/specs/20250121T201500-deepgram-api-integration.md |
| 2025-01-21 | rename-workspaces-to-workspace-configs | removed | specs/20250121T095830-rename-workspaces-to-workspace-configs.md |
| 2025-01-21 | single-port-migration | removed | specs/20250121T143000-single-port-migration.md |
| 2025-01-21 | single-port-migration | removed | docs/specs/20250121T143000-single-port-migration.md |
| 2025-01-21 | yc-demo-script | removed | docs/specs/20250121T180000-yc-demo-script.md |
| 2025-01-21 | dictation-feature | removed | docs/specs/20250121T180500-dictation-feature.md |
| 2025-01-21 | rename-workspaces-to-workspace-configs | removed | docs/specs/20250121T095830-rename-workspaces-to-workspace-configs.md |
| 2025-01-21 | browser-platform-detection | removed | specs/20250121T214500 browser-platform-detection.md |
| 2025-01-21 | refactor-keyboard-constants | removed | specs/20250121T085230 refactor-keyboard-constants.md |
| 2025-01-21 | convert-to-modifier-specification | removed | specs/20250121T000000 convert-to-modifier-specification.md |
| 2025-01-20 | ui-overhaul | in tree | specs/20250120T012752 ui-overhaul.md |
| 2025-01-20 | ui-overhaul | removed | docs/specs/20250120T012752 ui-overhaul.md |
| 2025-01-20 | improve-pressed-keys-to-tauri-accelerator | removed | specs/20250120T193000-improve-pressed-keys-to-tauri-accelerator.md |
| 2025-01-19 | opencode-client-scaffold | removed | specs/20250119T194232 opencode-client-scaffold.md |
| 2025-01-19 | mapError-to-mapErr-migration | removed | packages/wellcrafted/specs/20250119T000000-mapError-to-mapErr-migration.md |
| 2025-01-19 | opencode-client-scaffold | removed | docs/specs/20250119T194232 opencode-client-scaffold.md |
| 2025-01-18 | error-handling-pattern | in tree | specs/20250118T192845-error-handling-pattern.md |
| 2025-01-18 | error-handling-pattern | removed | docs/specs/20250118T192845-error-handling-pattern.md |
| 2025-01-15 | epicenter-core-action-refactor | in tree | specs/20250115T000000-epicenter-core-action-refactor.md |
| 2025-01-15 | epicenter-core-action-refactor | removed | docs/specs/20250115T000000-epicenter-core-action-refactor.md |
| 2025-01-14 | cli-programmatic-positionals | removed | specs/20250114T193000-cli-programmatic-positionals.md |
| 2025-01-14 | cli-programmatic-positionals | removed | docs/specs/20250114T193000-cli-programmatic-positionals.md |
| 2025-01-13 | refactor-array-at-method | in tree | specs/20250113T000000 refactor-array-at-method.md |
| 2025-01-13 | refactor-array-at-method | removed | docs/specs/20250113T000000 refactor-array-at-method.md |
| 2025-01-10 | device-enumeration-refactor | in tree | specs/20250110T120000 device-enumeration-refactor.md |
| 2025-01-10 | device-enumeration-refactor | removed | docs/specs/20250110T120000 device-enumeration-refactor.md |
| 2025-01-09 | fix-ui-package-imports | in tree | specs/20250109T000000-fix-ui-package-imports.md |
| 2025-01-09 | local-revision-history | in tree | specs/20250109T033000-local-revision-history.md |
| 2025-01-09 | fix-ui-package-imports | removed | docs/specs/20250109T000000-fix-ui-package-imports.md |
| 2025-01-08 | ui-monorepo-refactor | in tree | specs/20250108T230000-ui-monorepo-refactor.md |
| 2025-01-08 | svelte5-runes-migration | removed | docs/specs/20250108T120000-svelte5-runes-migration.md |
| 2025-01-08 | ui-monorepo-refactor | removed | docs/specs/20250108T230000-ui-monorepo-refactor.md |
| 2025-01-07 | fix-duplicate-recording-service-errors | in tree | apps/whispering/specs/20250107T093000-fix-duplicate-recording-service-errors.md |
| 2025-01-07 | infinite-toast-duration | in tree | specs/20250107T000000-infinite-toast-duration.md |
| 2025-01-07 | consolidate-navigator-settings | in tree | specs/20250107T121043 consolidate-navigator-settings.md |
| 2025-01-07 | createTaggedError-migration | in tree | specs/20250107T160000-createTaggedError-migration.md |
| 2025-01-07 | notion-like-schema-refactor | in tree | specs/20250107T163000-notion-like-schema-refactor.md |
| 2025-01-07 | remove-projectdir-from-capability-context | in tree | specs/20250107T163200-remove-projectdir-from-capability-context.md |
| 2025-01-07 | installation-section-redesign | in tree | specs/20250107T230000-installation-section-redesign.md |
| 2025-01-07 | minimal-field-schema-refactor | removed | specs/20250107T123500-minimal-field-schema-refactor.md |
| 2025-01-07 | provider-to-capability-refactor | removed | specs/20250107T143456-provider-to-capability-refactor.md |
| 2025-01-07 | installation-section-redesign | removed | docs/specs/20250107T230000-installation-section-redesign.md |
| 2025-01-07 | fix-duplicate-recording-service-errors | removed | apps/app/specs/20250107T093000-fix-duplicate-recording-service-errors.md |
| 2025-01-06 | id-reference-architecture-migration | in tree | specs/20250106T111100-id-reference-architecture-migration.md |
| 2025-01-05 | vad-device-validation | in tree | specs/20250105T155230 vad-device-validation.md |
| 2025-01-03 | schema-naming-and-provider-context-refactor | in tree | specs/20250103T002300-schema-naming-and-provider-context-refactor.md |

## 2024

| Date | Spec | State | Path |
|------|------|-------|------|
| 2024-12-09 | record-type-fix.handoff | in tree | specs/20241209T-record-type-fix.handoff.md |
| 2024-12-09 | record-type-fix-handoff | removed | docs/specs/20241209T-record-type-fix-handoff.md |

## 2023

| Date | Spec | State | Path |
|------|------|-------|------|
| 2023-12-23 | services-query-folder-reorganization | in tree | specs/20231223T131706-services-query-folder-reorganization.md |
| 2023-12-23 | services-query-folder-reorganization | removed | docs/specs/20231223T131706-services-query-folder-reorganization.md |
