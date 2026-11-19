# 0103. STT overspend is bounded by cheap guards in trigger order, never by media preflight or a reservation lock

- **Status:** Accepted
- **Date:** 2026-07-03
- **Relates:** ADR-0100 (the STT gate-and-meter policy this refines; 0100 deferred overspend control to "an input duration/size ceiling if abuse or material overspend appears"), ADR-0054 (the metered house-key-only gateway)

> **Correction (2026-07-05):** Whispering now has a live hosted STT producer through the `epicenter` transcription provider. That removes the "producerless path" fact from the original investigation, but not the decision: the first revisit triggers remain a loose-capped hosted backend, observed abuse, or material overspend. While the hosted backend remains pinned to `whisper-1`, the single-call term is still provider-capped.

<!-- doc-path-check: ignore-file (records the hosted API, retired by ADR-0970; its paths are as they were) -->

## Context

ADR-0100 settled that STT gates on a usable wallet and meters per transcribed minute after success, deliberately refusing a reservation lock. It named one deferred remedy for the bounded overspend, "an input duration/size ceiling," and left the trigger and the mechanism loose. A follow-up investigation (2026-07-03: primary-source research across OpenAI, Deepgram, AssemblyAI, Rev AI, Google Cloud STT, Groq, and ElevenLabs, plus a map of the local STT path) asked the sharper question: if we *can* make audio duration known before provider spend, *should* we, and does that collapse STT into chat's exact-reservation mechanic? The evidence refined the deferred remedy enough to record on its own: the single-call bound 0100 worried about is already capped by the provider, the only *live* overspend vector is concurrency (which a size ceiling does not touch), and the cheapest first guard is operational, not a billing control.

Three facts from the investigation drive this ADR. (1) Every comparable provider bills on decoded audio duration, returns billable duration only *after* the call (`duration` / `metadata.duration` / `audio_duration` / `duration_seconds` / `totalBilledTime` / `audio_duration_secs`), and exposes no pre-submission cost; their size/duration/concurrency limits protect the provider, never Epicenter's per-user spend. (2) On the pinned `whisper-1` backend the largest single call is already bounded by OpenAI's 25 MB file cap to roughly 26-210 credits (about $1.30 of provider cost), so the single-call term needs no new control. (3) The hosted STT gateway (`packages/server/src/routes/transcription.ts`) buffers the entire multipart upload into memory in a 128 MB Worker isolate with no size cap. As of 2026-07-05, Whispering's `epicenter` transcription provider is the live producer for that gateway; the provider-capped single-call bound still holds, and concurrency remains the live overspend vector.

## Decision

STT overspend is controlled by a fixed order of cheap, independently-shippable guards, each gated on an observed trigger, not by making duration knowable before the call. **Media duration preflight (metadata probing or decode) and an exact STT reservation lock stay refused.** The remedy order is:

1. **Operational upload-size ceiling.** A blunt byte cap enforced before `formData()` buffers the body, returning 413 in the OpenAI error shape. Its justification is operational, protecting the 128 MB isolate and cutting wasted egress on files the provider would reject anyway, and only incidentally a crude single-call spend bound. It is honest bytes, not cost: a small compressed file can still be long.
2. **Per-principal concurrency / rate cap.** The actual remedy for the only live overspend path: because the pre-gate proves only "balance >= 1," many in-flight calls can each pass before any usage settles. A cap on concurrent (or per-window) transcriptions per principal bounds that directly, with no media code. This, not the input ceiling, is what a reservation lock would have bought, at a fraction of the cost.
3. **Free-tier economic lever.** The overspend path only matters where there is no revenue backstop: the free tier has no card and no overage. Requiring a card for hosted STT, lowering the free grant, or excluding free-tier STT kills the abuse economics with a catalog change and no request-path code.

Duration preflight and exact reservation are refused because: no comparable provider performs a preflight, so it would be a mechanism Epicenter alone owns; the single-call bound it would tighten is already provider-capped; and it forces a permanent media subsystem (metadata probing, decode fallback for headerless/VBR/streamed audio, codec and container edge cases, bad-metadata handling, preflight-versus-result reconciliation, new 4xx states, rejected-long-file copy, and a media-edge test matrix) that is disproportionate to a bounded risk on a path with no live producer. Unifying STT's authorization *mechanic* with chat's is cosmetic: chat cost is known before the call and STT cost is not, so a shared lock must either over-reserve (blocking legitimate long recordings) or reserve an untrusted estimate.

## Consequences

- **The size ceiling is honest, and mostly redundant today.** On `whisper-1` it duplicates OpenAI's own 25 MB cap, so it buys operational safety (no OOM buffering) more than billing safety. It becomes genuinely load-bearing only if the hosted backend moves to a loose-capped provider (Deepgram 2 GB, AssemblyAI 10 hr, Rev 17 hr); **that backend change is the primary revisit trigger**, because it silently removes the single-call bound the current design leans on.
- **Concurrency is the residual exposure until guard 2 ships.** Meanwhile it is loosely bounded by the provider's own RPM and Cloudflare's concurrency, and by the free tier's small grant. A near-empty free wallet can still be over-tipped by scripted concurrent calls; that is accepted until a trigger fires.
- **Nothing is built now.** All three guards are trigger-gated. Building any of them before a trigger fires would add request-path cost and a product-visible limit to defend an exposure that is currently bounded by the pinned provider cap and the free tier's small grant.
- **The refusal is the asymmetric win.** Refusing exact-cost-knowledge (a marginal "fail closed before spend" nicety for STT) deletes the entire media-preflight subsystem. The additive guards are each a constant or a catalog change, not a subsystem.
- **Provider evidence is captured so it need not be re-derived.** The cross-provider invariants (bill on decoded duration; duration only post-call; provider limits protect the provider) are the durable grounding for 0100's "no comparable provider reserves," now verified rather than asserted.

## Considered alternatives

Each candidate and the one reason it lost. The first three are the decision above; the rest are refused or deferred.

- **Operational size ceiling (guard 1).** Chosen as the first guard: cheapest, protects the isolate, has in-repo precedent (`MAX_IMPORT_FILE_SIZE`). Refused as a *billing* control: bytes are not cost.
- **Per-principal concurrency / rate cap (guard 2).** Chosen as the real overspend remedy: it bounds the only live path with no media code. This is the honest substitute for the reservation lock 0100 rejected.
- **Free-tier economic lever (guard 3).** Chosen as the most asymmetric option: a catalog change removes the abuse economics without touching the request path.
- **Keep policy with no new guard.** Correct today while the pinned backend keeps the single-call term provider-capped; not durable if the backend moves to a loose-capped provider or observed traffic shows abuse/material overspend. The guards above are the staged answer.
- **Client-side duration warning.** Kept as pure UX (the recorder already computes `durationMs`), explicitly decoupled from billing: client duration is untrusted and trivially bypassed, so it controls confusion, not spend.
- **Server-side duration probe, keep gate-and-meter.** Refused: builds the whole preflight subsystem to tighten a bound the provider already enforces; concurrency untouched.
- **Server-side probe plus exact reservation.** Refused: the option 0100 exists to reject; forces a preflight no comparator performs and either over-reserves or trusts an estimate.
- **Mirror provider-specific limits in Epicenter.** Refused: a drift-prone table of numbers the provider enforces itself for free (the investigation already found stale figures across providers); protects against provider-side rejection, not Epicenter spend.
- **Product-level max transcription duration.** Deferred to a genuine product decision, not a billing one; if taken, implement it as the byte ceiling (guard 1), never as a duration probe.
