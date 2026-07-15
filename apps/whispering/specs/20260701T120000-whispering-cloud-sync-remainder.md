# Whispering cloud sync remainder: audio to R2

**Date**: 2026-07-01
**Status**: Draft
**Owner**: Braden
**Carries forward from**: `apps/whispering/specs/20260602T140000-cloud-sync-and-account.md` (deleted). That spec's Phases 1 (auth wiring), 2 (optional synced workspace, reload-on-auth), and 4 (first-sign-in migration) shipped and are verified live in `apps/whispering/src/lib/whispering/whispering.active.ts`, `apps/whispering/src/lib/whispering/reload-on-principal-change.ts`, and `apps/whispering/src/lib/migration/sign-in-migration.svelte.ts`, so they are not repeated here. Phase 3 (settings sync allowlist) needed no work; the `deviceConfig` vs `whispering.kv` split already implemented it. The generic Tauri daemon remainder is dropped by ADR-0144. This file now carries only opt-in audio upload and the parent spec's remaining open questions.

## One Sentence

Recording audio stays device-local by default; the unbuilt remainder is an opt-in per-recording upload to R2 through principal-scoped bearer-authenticated routes.

## Phase 5: Audio to R2 (opt-in)

- [ ] **5.1** Add `audioUpload` column (nullable pointer) with a table migration.
- [ ] **5.2** R2 bucket binding + principal-scoped PUT/GET routes in `packages/server` / `apps/api/worker`.
- [ ] **5.3** Per-recording "Upload audio" action + UI; cross-device "Download / Play" vs "audio on original device."
- [ ] **5.4** Decide + implement audio-at-rest encryption (see Open Questions).

### Recording row shape

Audio lives in Dexie today (`$lib/services/blob-store`), separate from the Yjs metadata. Keep it there; add a pointer on the recording row.

```txt
recordings row gains:
  audioUpload: nullable({ status: 'uploaded', r2Key, bytes, uploadedAt })   # null = device-local only

Per recording:
  [Upload audio]  -> encode -> (encrypt?) -> PUT via API -> set audioUpload on row
On another device:
  audioUpload != null  -> [Download / Play] (GET from API)
  audioUpload == null  -> "Audio is on the device that recorded it"
```

### Route shape

New principal-scoped, bearer-authed routes in `packages/server` (consumed by `apps/api` worker) backed by an R2 bucket binding:

```txt
PUT  /api/audio/:recordingId    # upload (presigned or proxied)
GET  /api/audio/:recordingId    # download/stream
```

### Billing note

R2 storage/egress is hosted-personal-cloud only; keep it in `apps/api/worker`, never in the shared library seam.

## Open Questions

1. **Local doc vs principal doc reconciliation after sign-out.**
   - Options: (a) signed-out startup always builds the local doc, and signed-in work lives only in the principal doc (sign-out "hides" synced-only recordings until you sign back in); (b) mirror principal writes back into the local doc so signed-out keeps a read-only copy; (c) after first sign-in, treat the principal doc as the only doc on that device and never fall back.
   - **Recommendation**: (a) for MVP. Reload-on-auth implements it directly (the signed-out startup picks the local doc), it is the simplest honest model, and it matches "sync is an optional layer." Revisit if users find disappearing-on-sign-out surprising. Leave open.

2. **Audio encryption at rest in R2.**
   - Options: (a) plaintext in R2 (server-readable, simplest, consistent with today's plaintext-body gap); (b) client-side keyring-encrypt the whole blob before PUT and decrypt on GET (E2E, but no range/streaming).
   - **Recommendation**: (b) whole-blob encrypt for short recordings, since the keyring is already in hand and this is someone's voice. Confirm against the encryption skill and relay/body model. Leave open.

3. **Mobile / narrow-viewport placement.**
   - The sidebar footer is desktop-only; `BottomNav` has four fixed slots.
   - **Recommendation**: rely on the Settings -> Account page on mobile; optionally a small account glyph in `BottomNav`. Defer the exact mobile chrome.

4. **OAuth launcher on Tauri.**
   - Redirect vs deep-link vs OOB. tab-manager uses an extension launcher; whispering is Tauri.
   - **Recommendation**: deep-link callback if a scheme is registered, else OOB paste. Verify against `packages/auth` machine-auth + browser launchers. Leave open.
