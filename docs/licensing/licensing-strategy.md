# Licensing Strategy

**Status:** Active
**Date:** 2026-04-28
**Owner:** Braden Wong
<!-- doc-path-check: ignore-next-line -->
**Promoted from:** `specs/20260428T120000-licensing-strategy.md` (spec deleted in PR #2248)

## Summary

The whole model in one line: **run our apps freely (AGPL-3.0, which only blocks taking our work, closing it, and reselling it), build on our toolkit freely (MIT, build and own anything).**

Epicenter uses two active license tiers, split by how you use the code rather than by package type: code you *run* (all apps, the shared `server` library, the CLI) is AGPL-3.0, and code you *build with* (the embeddable toolkit: `workspace`, `ui`, `sync`, and their internal utilities) is MIT to maximize developer adoption. A third proprietary tier is documented as an escape hatch but deferred indefinitely; revenue comes from hosting, not licensing. There is no Contributor License Agreement; we do not dual-license.

This document is the canonical reference. The companion document [FINANCIAL_SUSTAINABILITY.md](../FINANCIAL_SUSTAINABILITY.md) is the public-facing narrative for why we made these choices. The root [LICENSE](../LICENSE) is the legal dispatch. This spec is the technical reasoning, threat model, and decision procedure for new packages.

## Operating principle

Two rules classify every package, not one.

1. **Product decision (roots):** is this a package we actively offer third-party developers to embed in their own software? If yes, it is a toolkit root and it is MIT. This is the only judgment call; everything else follows mechanically.
2. **Mechanical rule (closure):** whatever a root's workspace dependency closure touches must also be MIT, or the root itself could not legally stay MIT. A package can be swept into MIT by rule 2 alone even though nobody embeds it standalone. `@epicenter/agent-protocol` is that case: no third party embeds `agent-protocol` on its own, but it sits inside the dependency closure of the MIT toolkit roots, so rule 2 forces it to MIT regardless.

A package that is neither a chosen root nor inside a root's closure is something we ship as a product or run as our own infrastructure, and it is AGPL-3.0. This is safe because the toolkit is not our competitive moat; the moat is the apps, the hosting, and the AGPL `server` engine, so giving the toolkit away permissively costs us nothing and buys adoption.

To the two audiences it reads as two promises:

- **Run our apps freely** (all apps, plus the code we run them on: the shared `server` library and the CLI). These are AGPL-3.0. Running is not distribution, so for someone running the apps locally AGPL never triggers; they can run, read, and modify their own copy with no obligation. What AGPL blocks is taking our work, closing it, and shipping it to others: a closed-source rebrand (blocked by GPL conveyance copyleft) or a network-served modified fork that hides its source (blocked by AGPL §13). This costs an honest user nothing.
- **Build on our toolkit freely** (`workspace`, `ui`, `sync`, and the MIT-clean contracts they carry). These are MIT. For a library, "use" means shipping it inside your own software, which is the whole point; AGPL would force every app built on the toolkit to also be AGPL, blocking the primary use and killing adoption. So: build anything on the toolkit, including closed-source and commercial products, and own what you build.

Note that "does it run" is not the discriminator, because all code runs; "is it offered for you to embed" is. `packages/server` is a library our two deployables build with, yet it is AGPL, because it is our sync/auth/hosting engine, not a toolkit we offer third parties. That is the case the embed test sorts correctly and a naive "library means permissive" rule would get wrong.

These tiers cannot collapse to one license. "Free to use" is compatible with AGPL for the apps and fundamentally incompatible with it for a ship-inside library; a single license would either mislead builders or restrict people running the apps for no gain. MIT on the toolkit is load-bearing, not a legacy concession. (LGPL is the theoretical middle for a copyleft-but-linkable library. It would protect only improvements to the toolkit's own internals, which are not our moat, while adding real friction: its relink obligation is ill-defined for tree-shaken JS bundles, and many corporate legal teams blanket-ban the GPL family. MIT is strictly cleaner here.)

This also stays sustainable for a single maintainer. AGPL on the products is operationally cheap: no proprietary build pipelines, no commercial license sales process, no enterprise plugin gating, no CLA bot. MIT on the toolkit adds only one dependency-closure guard (`bun run check:licenses`), which fails if any MIT package can reach an AGPL one. Revenue is captured at the hosting layer (uptime, ops, backups, support, compliance), not the license layer.

The proprietary tier is preserved as an option for one specific situation: a paying customer requires a specific feature that AGPL self-hosting would otherwise give away free. It will not be populated speculatively. An empty proprietary tier is the correct end-state if hosting revenue scales, and is the model used by Plausible and PostHog.

Consumer apps (Whispering and the rest) are AGPL for the same reason as everything else we ship, and the protection is real, not cosmetic. Running one locally never triggers §13, so AGPL there reduces to GPL conveyance copyleft, which is exactly what stops a competitor from forking a shipped app (the wedge app most of all) into a closed-source rebrand. That block, not "brand consistency," is the load-bearing reason the apps are AGPL, and it preserves every freedom the local-first ethos cares about: users can always read, run, modify, and fork what they run.

## Threat model

The motivating concern is direct code copying by competitors. This is not theoretical: there is a steady drumbeat of stories in the local-first and developer-tools space of one team taking another team's open source code, rebranding it, and shipping it as a competing product, sometimes hosted, sometimes embedded inside a closed-source app.

We sort this into four scenarios:

| # | Scenario | MIT outcome | AGPL outcome | Proprietary outcome |
|---|---|---|---|---|
| 1 | An individual runs Epicenter locally for personal use | Allowed | Allowed (no §13 trigger when running locally) | Forbidden |
| 2 | A developer forks an Epicenter library to build their own app | Allowed | Their app must also be AGPL (kills adoption) | Forbidden |
| 3 | A company forks an Epicenter app and ships it under a new brand, closed-source | **Allowed** | Forbidden (must publish source) | Forbidden |
| 4 | A company forks the sync server and runs it as a competing hosted service | **Allowed** | Forbidden (§13 forces publishing source of running version) | Forbidden |

Scenarios 3 and 4 are the threat. AGPL handles both. We default to AGPL rather than proprietary for these scenarios because AGPL preserves the right to read and fork the code (consistent with the local-first ethos), still forces a hosted fork to publish its (modified) source via §13, and avoids the operational overhead of running a proprietary tier.

Scenario 4 (a hosted competitor) is the one where the license is most load-bearing, because hosting a fork is a low-effort, high-leverage attack on revenue. We extend AGPL to the consumer apps too (Whispering, Honeycrisp, etc.): on a locally-run app AGPL reduces to GPL conveyance copyleft, which is not "little protection" but exactly what blocks scenario 3, a competitor forking a shipped app into a closed-source rebrand. Brand, distribution, and update cadence remain the real moats for end-user apps; the license is the backstop that keeps a fork from being closed.

## Three-tier split

### Tier 1: MIT

**Applies to:** the embeddable toolkit libraries: `packages/workspace`, `packages/ui`, `packages/sync`, `packages/sqlite`, `packages/row-sync`, `packages/data`, and `packages/document-sync`, plus the toolkit-internal packages they carry: `packages/identity`, `packages/agent-protocol`, `packages/encryption`, `packages/field`, `packages/chat`, and `packages/agent`.

**Rationale:**
- Libraries: we want developers to embed `@epicenter/workspace` in their own projects with zero friction. AGPL would forbid that for closed-source consumers, killing adoption. The library is not what we sell.
- Toolkit-internal packages (`identity`, `agent-protocol`, `encryption`, `field`, `chat`): these are dependencies bundled into the MIT toolkit libraries, so they must be MIT-compatible for the toolkit to stay distributable as MIT. `@epicenter/identity` owns the capability and identity vocabulary shared by the MIT toolkit and the AGPL auth layer; `@epicenter/agent-protocol` is the agent wire contract shared the same way. They are not separately marketed.
- MIT-clean closure: the toolkit no longer depends on any AGPL package. `PrincipalId` and `AuthState` live in `@epicenter/identity`; the room route and bearer subprotocol moved to the now-MIT `@epicenter/sync`; the agent wire contract is the now-MIT `@epicenter/agent-protocol`; and the daemon takes its API base URL as config instead of importing the hosted constant. `bun run check:licenses` enforces this. `cli` stays AGPL primarily because it is a shipped CLI app (decision-procedure rule 2, not a toolkit root); it also directly imports AGPL `auth` for machine-auth login, and reaches AGPL `constants` only transitively, through `auth` and `client`.

### Tier 2: AGPL-3.0

**Applies to:** all apps (`apps/api`, `apps/self-host`, `apps/whispering`, `apps/honeycrisp`, `apps/reddit`, `apps/landing`, `apps/posthog-reverse-proxy`, `apps/matter`, `apps/local-books`, `apps/local-mail`), `packages/cli`, and the internal packages `packages/auth`, `packages/svelte-utils`, `packages/app-shell`, `packages/skills`, `packages/constants`, `packages/server`, `packages/client`, `packages/matter-core`, `packages/vite-config`.

**Rationale:**
- `apps/api` (hosted cloud: sync server, auth, AI inference; serves the same-origin dashboard SPA from its `ui/`): the infrastructure a competitor would need to clone Epicenter Cloud. AGPL §13 means any hosted fork must publish source, including improvements, which destroys the economics of forking-and-hosting. `apps/self-host` is the self-hosted single-partition instance reference deployment.
- Consumer apps: on a locally-run app AGPL reduces to GPL conveyance copyleft, which is exactly what blocks a competitor from forking a shipped app into a closed-source rebrand (scenario 3). That is real protection, not brand consistency. The toolkit libraries are the only MIT surface.
- Internal packages (`auth`, `svelte-utils`, `app-shell`, `skills`, `constants`, `server`, `client`, `matter-core`, `vite-config`): private glue that composes the apps and hosted server; never offered for third-party embedding, so AGPL with no adoption cost.

### Tier 3: Proprietary (deferred)

**Applies to:** none today, and none planned.

**Rationale:** Documented as an escape hatch for one specific situation: a real paying customer requires one specific feature that AGPL self-hosting would otherwise give away free. The tier will not be populated speculatively. The empty-tier end-state is the goal; populating it is a sign that hosting revenue alone was not enough.

**Convention if ever used:**
- Live in their own subdirectory, e.g. `apps/<name>/proprietary/` or a dedicated `enterprise/` top-level directory.
- `LICENSE` file in that directory contains an "all rights reserved" notice (template in this spec).
- `package.json` uses `"license": "SEE LICENSE IN LICENSE"`.
- Listed explicitly in the root `LICENSE` dispatch under a "Proprietary" section.
- Code is publicly visible on GitHub (for transparency and customer trust) but no rights are granted to use, copy, modify, or redistribute.
- Scoped to the smallest unit that solves the customer's problem. Do not gate adjacent features speculatively.

This is the same pattern Bitwarden uses for `bitwarden_license/` and Sentry uses for `getsentry/getsentry`. We treat it as a graduation path, not a default.

## Planned `apps/api` split

`apps/api` today is a kitchen sink: Yjs sync protocol, Postgres-backed persistence, auth, workspace management, AI inference. This is fine operationally but muddies the self-host story ("self-host `apps/api` but disable these 14 features").

When `apps/api` becomes uncomfortable to maintain as a single unit, split it:

```
apps/sync-server   pure Yjs sync protocol, genuinely self-hostable
                   on a VPS with no other Epicenter infrastructure.
                   AGPL.

apps/api           cloud platform: auth, Postgres, workspace mgmt,
                   billing hooks, admin endpoints. AGPL, but
                   practically requires the full Epicenter stack.

apps/dashboard     UI for apps/api. AGPL.
```

The split is architectural, not licensing. All three remain AGPL. The benefit is a cleaner self-host story for individuals and homelabbers (`apps/sync-server` alone) without conflating it with the cloud-platform code.

This is not blocking and not scheduled. Trigger to execute: `apps/api` becomes painful to keep as a single unit, or a community member wants to self-host the sync protocol without the rest.

## Deferred MIT carve-out candidates

The boundary currently errs toward AGPL: some toolkit-shaped code is AGPL only because it is bundled with, or has not yet been separated from, AGPL code. None of these are live defects, because every consumer today is one of our own AGPL apps, and an AGPL app depending on an AGPL package is fine. So each is recorded here with the trigger that would move it, rather than executed now. The rule is the same as for new packages: refuse the carve-out until a third-party embedder actually exists.

| Candidate | Today | Would become | Trigger to execute |
|---|---|---|---|
| `@epicenter/svelte` main barrel (`fromTable`, `fromKv`, `fromDisposableCache`, `createPersistedState`, `createPersistedMap`, `bindAgentConversation`) | AGPL | MIT; the auth wrapper (the `./auth` subpath) relocates to an AGPL `@epicenter/auth/svelte` | A third party embeds the MIT `@epicenter/workspace` in a Svelte app, or we publish the toolkit for external use. Strongest candidate: the barrel already imports only MIT `@epicenter/workspace`, so the split is nearly free. |
| `@epicenter/client` | AGPL | MIT | We decide to offer a public client SDK. Requires closure surgery first: `AuthFetch` moves to `@epicenter/identity` and `API_ROUTES` to an MIT constants surface. |
| `packages/matter-core` | AGPL | MIT | We offer Matter's markdown-to-SQLite engine for third-party embedding as a standalone library. |
| `is-websocket-upgrade` (in `packages/server`) | AGPL (by location only) | MIT, no surgery needed | Its only import is Hono's `Context` type; nothing in its own closure is AGPL. It sits inside AGPL `packages/server` only because nothing ships it standalone yet, not because it needs surgery. Move the file out whenever a consumer wants it alone. |
| `room/contracts` (in `packages/server`) | AGPL | MIT | The old id-brand closure blocker is gone now that `PrincipalId` lives in MIT `@epicenter/identity`. The remaining question is product demand: move this only when a third party implements a wire-compatible room backend against these contracts. Low value until then. |

Recording these keeps the "nothing moves today" answer honest: the design is not frozen, it just has no live producer for any of these seams yet.

## Per-package breakdown

All apps are AGPL-3.0. MIT is reserved for the embeddable toolkit libraries.

| Path | License | Notes |
|---|---|---|
| `apps/api` | AGPL-3.0 | Hosted cloud: sync server, auth, AI inference (its `ui/` is the same-origin dashboard SPA) |
| `apps/self-host` | AGPL-3.0 | Self-hosted single-partition instance reference deployment |
| `apps/whispering` | AGPL-3.0 | Desktop transcription |
| `apps/honeycrisp` | AGPL-3.0 | Notes app |
| `apps/reddit` | AGPL-3.0 | Reddit data importer |
| `apps/landing` | AGPL-3.0 | Public site |
| `apps/posthog-reverse-proxy` | AGPL-3.0 | Analytics proxy |
| `apps/matter` | AGPL-3.0 | Typed grid for user-owned Markdown folders |
| `apps/local-books` | AGPL-3.0 | QuickBooks mirror |
| `apps/local-mail` | AGPL-3.0 | Local email client |
| `packages/workspace` | MIT | Core CRDT library (toolkit) |
| `packages/ui` | MIT | shadcn-svelte components (toolkit) |
| `packages/identity` | MIT | Capability and identity vocabulary shared by the MIT toolkit and AGPL auth layer (toolkit-internal) |
| `packages/sync` | MIT | Yjs sync protocol primitives: wire format, room route, auth subprotocol (toolkit) |
| `packages/agent-protocol` | MIT | Agent wire contract: prompt messages, streamed chunks, engine shape (toolkit-internal) |
| `packages/encryption` | MIT | HKDF and blob crypto (toolkit-internal) |
| `packages/field` | MIT | Field schema kinds (toolkit-internal) |
| `packages/chat` | MIT | Chat message primitives (toolkit-internal) |
| `packages/sqlite` | MIT | Domain-free synchronous SQLite adapter contract shared across embedded runtimes |
| `packages/row-sync` | MIT | Schema-opaque scalar row synchronization protocol and digests |
| `packages/data` | MIT | Typed local-first Epicenter replica and sync |
| `packages/document-sync` | MIT | Row-document sync plane |
| `packages/agent` | MIT | UI-free agent loop |
| `packages/auth` | AGPL-3.0 | Framework-agnostic auth core (private, internal) |
| `packages/svelte-utils` (`@epicenter/svelte`) | AGPL-3.0 | Svelte 5 reactive helpers and auth wrapper |
| `packages/app-shell` | AGPL-3.0 | Shared app shell UI (private, internal) |
| `packages/skills` | AGPL-3.0 | Skill definitions |
| `packages/constants` | AGPL-3.0 | Shared constants |
| `packages/cli` | AGPL-3.0 | `epicenter` CLI: a shipped CLI app (decision-procedure rule 2), not a toolkit root; also directly imports AGPL `auth` and transitively reaches AGPL `constants` through `auth` and `client` |
| `packages/server` | AGPL-3.0 | Shared Hono server library |
| `packages/client` | AGPL-3.0 | API client |
| `packages/matter-core` | AGPL-3.0 | Markdown-to-SQLite projection engine |
| `packages/vite-config` | AGPL-3.0 | Shared Vite config |

> **MIT-clean closure:** the MIT toolkit's entire dependency closure is MIT. `@epicenter/workspace` no longer imports from any AGPL package: shared capability state lives in `@epicenter/identity`, the room route plus bearer subprotocol moved to the now-MIT `@epicenter/sync`, and the agent wire contract is the now-MIT `@epicenter/agent-protocol`. `cli` stays AGPL because it is a shipped CLI app (decision-procedure rule 2); it also directly imports AGPL `auth`, and reaches AGPL `constants` only transitively, through `auth` and `client`. `bun run check:licenses` walks every package's dependency closure and fails if an MIT package can reach an AGPL one.

## Decision procedure for new packages

When adding a new package or app, ask in order:

1. **Is this meant for third-party developers to embed in their own software (or a contract/utility bundled into something that is)?** → MIT. No further questions. Confirm its dependency closure is MIT-compatible (`bun run check:licenses`), or document the AGPL deps.
2. **Is this an app (desktop, browser extension, CLI app, hosted service) that Epicenter ships?** → AGPL-3.0. Running it locally never triggers §13, so AGPL there reduces to GPL conveyance copyleft, which blocks a closed-source rebrand of a shipped app. That block is the reason, not brand consistency.
3. **Is this internal/glue or server infrastructure (auth, server, constants, client) that composes the product rather than being offered for third-party embedding?** → AGPL-3.0.
4. **Is there a real paying customer asking for one specific feature that AGPL would let them self-host for free?** → Proprietary, scoped to that feature, in its own subdirectory. Otherwise → AGPL. Never gate speculatively. The proprietary tier is reactive, not prospective.

When the embed test is unclear, default to AGPL and record the possible MIT carve-out with its trigger. An accidental MIT release of server/app value is the worse mistake because that version stays permissive forever; an AGPL internal package can still move to MIT when a real third-party embedder appears and the dependency closure is clean. If external contributors have already touched the AGPL code, get their consent before moving it to MIT.

## Contributor licensing posture

**No CLA. No DCO. No dual-licensing.**

Reasoning:
- We do not sell commercial AGPL exemptions to enterprises. Our revenue model is hosting, not licensing.
- Cal.com, dub.sh, Plausible, and most other open-core projects we are modeled on do not require CLAs either. The friction discourages contributors and provides no benefit for a hosting business.
- If we ever needed to relicense `packages/server` or `apps/api` away from AGPL (e.g. to sell self-hosted enterprise licenses without copyleft), we would need either (a) a CLA from the start, or (b) consent from every external contributor at that point. We accept (b) as a future cost in exchange for present-day contributor friendliness. As of this spec, there are zero external contributors to AGPL components, so the cost is zero today.
- If a meaningful external PR lands on an AGPL component and we anticipate ever wanting to dual-license, we can add CLA Assistant (a GitHub bot, click-through CLA) at that point. We do not pre-commit to that decision.

By contributing to Epicenter, contributors agree their contributions are licensed under the same license as the file they are modifying. This is the standard "inbound = outbound" convention used by Linux, Rails, and most open source projects without formal CLAs.

## Prior art

Two clusters of prior art are relevant. We anchor to the first cluster (no proprietary tier, monetize hosting) and keep the second cluster as a graduation path if a specific enterprise deal forces it.

**Closest models (no proprietary tier, hosting-only revenue):**
- **Plausible Analytics:** AGPL throughout, single-founder-led for years, monetizes via hosted SaaS only. No proprietary, no CLA.
- **PostHog:** Apache and AGPL components, monetizes via hosted SaaS and enterprise SLA contracts on the same code. No proprietary tier in the standard sense.
- **Cal.com:** AGPL throughout, hosted SaaS, no CLA.
- **dub.sh:** AGPL throughout, hosted SaaS, no CLA.
- **Yjs:** MIT for the core library and client-side providers (`y-websocket`, `y-webrtc`, `y-indexeddb`); AGPL for `y-redis` (server-side scaling backend).

**Graduation models (proprietary tier alongside open core, only if needed):**
- **Liveblocks:** Apache-2.0 for client libraries; AGPL for server.
- **Bitwarden:** GPL/AGPL for clients and core server; proprietary for `bitwarden_license/` enterprise modules.
- **Sentry:** Migrated through several variants (MIT to BSL to FSL); historically used a `getsentry/getsentry` proprietary repo for paid features.

Our default model is closest to Plausible and PostHog: permissive for libraries, AGPL for apps and servers, hosting is the revenue surface, proprietary tier exists on paper but stays empty. We graduate toward the Bitwarden/Sentry pattern only if a specific enterprise customer pulls a specific feature into the proprietary tier.

## Proprietary LICENSE template

When the first proprietary module is added, use this text:

```
Copyright (c) 2023-2026 Braden Wong. All rights reserved.

This software and associated documentation files (the "Software") are
proprietary and confidential. The Software is made available on GitHub
for transparency and customer trust, but no license is granted to use,
copy, modify, merge, publish, distribute, sublicense, or sell copies of
the Software except as expressly permitted in writing by the copyright
holder or as required to view the source on GitHub.

For commercial licensing, contact: github@bradenwong.com

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

## Open questions and review triggers

- Revisit if a meaningful external contributor lands a PR on `apps/api`, `apps/self-host`, `packages/server`, or `packages/sync`. Decide then whether to add CLA Assistant.
- Revisit if a specific paying customer requires a feature that AGPL would let them self-host for free. This is the trigger to populate the proprietary tier (one feature, scoped to a subdirectory). Until that happens, the tier stays empty by design.
- Revisit if `apps/api` becomes painful to maintain as a kitchen sink, or a community member asks to self-host the sync protocol alone. This is the trigger to execute the `apps/sync-server` split.
- Revisit if we sell self-hosted enterprise licenses. That would be the trigger for moving to a real dual-license posture (and retroactively adding CLAs).
