# 0068. Privacy is a deployment, not a product feature; the hosted app carries zero privacy-configuration surface

- **Status:** Accepted
- **Date:** 2026-06-24
<!-- doc-path-check: ignore-next-line -->
- **Relates:** [ADR-0004](0004-trust-the-relay-reject-zero-knowledge.md) (privacy is a property of topology; the relay is trusted), [ADR-0035](0035-durable-storage-is-one-per-person-coordination-box.md) (the relay / anchor / store / worker roles; one coordination box per person), [ADR-0066](0066-runtime-portability-is-per-concern-injection-not-a-runtime-object.md) (the runtime port that makes self-host one Bun binary plus Postgres plus any S3); the in-flight work and gap ledger live in `specs/20260624T223835-privacy-is-a-deployment-self-host-and-relay-anchor-gradations.md`; the user-facing copy is `docs/trust-model.md`; the vocabulary is `docs/CONTEXT.md`.

## Context

A design pass explored modeling privacy as a configurable product feature: a ladder of "tiers" with operations like "take custody," "move," and "seal." It felt wrong, and the reason it felt wrong is the decision here. That framing was a configuration space wearing a minimal costume; it invented vocabulary for the *designer* reasoning about the space, not for the user, who only ever asks "is my data private" and "where does it run." Meanwhile two settled decisions already answered the question: ADR-0004 established that privacy is a property of topology (who runs the anchor), not of client-side cryptography, and ADR-0035 established the one-coordination-box-per-person shape. The forcing question was whether privacy is something the hosted app exposes as settings, or something a user gets by choosing where the program runs.

## Decision

There is one program, and privacy is the choice of which computer runs it, not a toggle inside the app. A user either uses Epicenter hosted (managed, zero setup, full server-side AI; Epicenter holds and can read the data, and the product says so plainly) or runs it themselves (their machine, their data; Epicenter is never an endpoint of their data). Privacy is the choice between those two.

The hosted product therefore exposes **no** privacy-configuration surface: no tiers, no per-role encryption switch, no "custody" knobs. All the flexibility lives in "the program is open; run it where you want." The only privacy investment is making self-host genuinely runnable and reachable, never an in-app privacy feature.

This holds the line that ADR-0004 and ADR-0035 already drew, restated as a product shape. The roles that carry it (relay, anchor, store, worker) are defined in `docs/CONTEXT.md`; privacy depends on exactly one of them, the anchor (who holds your data), and never on the relay. Today, in the Cloudflare deployment, the relay and the anchor are **fused in one Durable Object** (ADR-0035), so "Epicenter's relay" also holds and reads your plaintext. That fusion is why the choice is currently binary: a "host your own data but keep Epicenter's relay" middle is refused, because while relay and anchor are one box that configuration would be a false privacy claim. The honest middle (own a lightweight anchor, borrow Epicenter's blind relay for reachability) becomes available only once the relay role is separated from the anchor role (ADR-0035 decomposes the coordination box into relay/anchor/store/worker). That separation is transport-agnostic: the per-user relay floor (2026-06-29, now the only cross-device transport; the iroh peer link was deleted) is a step toward a self-hostable relay, and the storage-anchor split is the unfinished half.

## Consequences

- **The hosted app ships no privacy settings, on purpose.** There is nothing to configure, audit, or get subtly wrong. The product copy in `docs/trust-model.md` stays load-bearing: "we cannot read your data" is true on self-host, not on the default, and that two-tier honesty is the whole privacy claim.
- **The only privacy roadmap is deployment reachability,** tracked in the spec as waves: package the Bun self-host binary (ADR-0066 makes it one binary plus Postgres plus any S3), and add a first-class instance-URL setting to the prebuilt clients so a self-hosted origin is reachable without a rebuild. Two real gaps remain until then: the browser clients bake `https://api.epicenter.so` in at build time, and the shipped `apps/self-host` is still a Cloudflare Worker rather than the Bun binary a homelabber wants. Self-host gives real data confidentiality against Epicenter today; the *reachability* of your own instance is the unfinished half.
- **The relay's metadata exposure is documented, not denied.** Even a future blind relay sees who-talks-to-whom, timing, and sizes; it only stops seeing content. When you run the relay yourself that metadata is yours.
- **What this forecloses:** the tier / custody / seal ladder, permanently. Re-introducing privacy as in-app configuration is re-litigating this ADR. Privacy moves by relocating the anchor, not by flipping a setting.

## Considered alternatives

- **Privacy tiers / custody / seal as product features.** Rejected: a configuration space in a minimal costume, named for the designer's coordinate system, not the user's question. The collapse removes the coordinate system instead of shrinking it.
- **A "partial self-host" middle today (own data, Epicenter's relay).** Rejected: while the relay and anchor are fused in one Durable Object, it is a false privacy claim. It becomes honest, and is then welcome, only after the relay role is split from the anchor role (ADR-0035), a split that does not depend on any particular transport.
- **An encrypted hosted mode for the privacy-conscious user who will not run a server.** Deferred, additive-later per ADR-0004. Trigger: that user becomes a real, asked-for segment; it can be added without undoing this decision, which is exactly the property ADR-0004 preserved.
