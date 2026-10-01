# Personal software public materials

**Date:** 2026-09-30
**Status:** In Progress
**Owner:** Braden
**Branch:** `codex/personal-software-branding`
**Worktree:** `/Users/braden/.codex/worktrees/personal-software-branding/epicenter`

## Outcome

Design the root README, landing page, and supporting documentation for the completed personal-software model. Work backward from that description to the developer experience and implementation evidence required to deliver it.

The root [README](../README.md) now contains Braden’s approved opening verbatim. It describes the target product in the present tense. Current Yjs implementation details and migration gaps do not belong in that opening. This design branch is not evidence that the file-based foundation or independent releases are available.

## Public articulation

> **Make software that’s unmistakably yours.**
>
> Epicenter is a foundation for building personal apps over Markdown and SQLite files you own.

The remainder of the approved opening explains applications as interfaces over accessible personal data and compatibility through shared formats. Preserve those four paragraphs exactly unless Braden revises them.

The README explains the general technical model. The landing page owns the visual invitation and app discovery. App READMEs own build steps, data behavior, and publisher attribution. Package READMEs own their current API contracts.

Whispering’s approved identity is:

> Whispering
>
> Press a shortcut. Speak. Get text.
>
> By Braden Wong. Built on Epicenter.

The intended home is `whispering.bradenwong.com`; the intended source home is `braden-w/whispering`. These remain destinations, not verified deployments or extracted repositories. [ADR-0460](../docs/adr/0460-vocab-and-whispering-are-braden-wongs-apps-built-on-epicenter.md) records the publisher direction.

## Developer documentation

[Building a personal app](../docs/guides/personal-apps.md) owns the target journey and its required evidence. It is a design guide while the API is unfinished. It must identify unresolved interfaces beside the affected stages and distinguish target ADRs from implementation proof.

The journey is: define an app’s data, save it, inspect and edit source outside the app, reopen it, change the interface, use another compatible interface, and publish software for a second person with separate data. Optional SQL and owned media have their own acceptance scenarios in the guide. Do not duplicate the evidence ledger here.

The current [application guide](../apps/README.md) and [application package](../packages/app/README.md) stay accurate to existing contracts. Do not replace their Yjs openers with invented file APIs. `@epicenter/app` is private; independent package distribution, native packaging, and browser data access require their own implemented paths before a runnable external starter exists.

The absorbed README draft is retired. Its previous requirement to supply a tested starter before adopting the target copy is superseded: the README establishes the destination, and the design guide records the proof still required. Executable instructions need actual tested code; ADR acceptance alone does not establish implementation.

## Remaining work

- [x] Install and commit project-level design skills.
- [x] Preserve design studies and the accepted refined prototype.
- [x] Explore personal publishing in a separate prototype.
- [x] Apply the approved general technical opening to the root README.
- [x] Add and review the target developer guide without inventing API signatures.
- [ ] Apply the approved visual direction to the Astro landing page as a target design. Preserve current prototype comparisons until review is complete.
- [ ] Align landing metadata with each page’s purpose and public URL.
- [ ] Draft Whispering’s independent-product README and personal-domain product page, keeping build mechanics unresolved where necessary.
- [ ] Reconcile `docs/positioning.md` with the approved articulation; do not revive superseded one-way projection or mandatory-host rules.
- [ ] Reconcile and retire the conflicting [earlier landing plan](20260612T063520-landing-page-public-realignment.md) when its remaining useful requirements are incorporated.

## Decisions and open edges

Personal publishing addresses such as `alice.epicenter.so` and community spaces are separate product proposals. Their place in a design study does not choose deployment, provisioning, permissions, or community tooling.

The file model follows [ADR-0450](../docs/adr/0450-current-files-own-portable-document-data.md). SQLite roles follow [ADR-0459](../docs/adr/0459-sqlite-is-a-local-capability-for-derived-or-transactional-state.md) and the generated index follows [ADR-0463](../docs/adr/0463-a-data-folder-exposes-a-generated-root-sqlite-index.md). The overall product articulation follows [ADR-0470](../docs/adr/0470-epicenter-helps-people-make-software-that-is-unmistakably-theirs.md). The records identify unbuilt work; neither copy nor record status implements it.

The adversarial review reduced the supporting-doc proposal to one journey guide. Separate speculative API, sync, browser-permission, and deployment tutorials would duplicate unsettled contracts. The retained cost is that the design guide is not yet a runnable quickstart. Publishing software and authorizing access to someone’s files remain distinct handoffs.

## Verification and handoff

Verify the approved README passage byte for byte, local links, and changed documentation paths. Preserve current package contracts. Record implementation evidence in the journey guide before promoting its scenarios to runnable instructions.

The developer guide was drafted in a dedicated clone at baseline `f67826c2e6`. Integration verified existing exports, package privacy, ADR statuses, and artifact checkout behavior. No runtime API or current application/package contract was changed.

The documentation-path baseline at `f67826c2e6` reports 49 dead references in existing ADRs and reports. New work must introduce none. Broader repairs are separate from this writing task.

This plan remains in progress for landing and app materials. Retire it when those decisions and required work have moved to their durable owners; retain implementation evidence with the developer guide.
