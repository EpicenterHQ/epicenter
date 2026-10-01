# Personal software public materials

**Date**: 2026-09-30
**Status**: Draft
**Owner**: Braden
**Branch**: `codex/personal-software-branding`
**Worktree**: `/Users/braden/.codex/worktrees/personal-software-branding/epicenter`

## Current working mode

Braden clarified that this branch designs the README and related public material for the fully implemented product. The root README is the target description, with the approved opening preserved verbatim. Implementation status, migration gaps, and current Yjs stores belong in this plan, not in the proposed README. Earlier passages below record the previous readiness-first approach; they are superseded for this design pass. Deploying these materials publicly is separate from preparing them here.

### Work backward from the target

| Target statement | Required proof | Owning material |
| --- | --- | --- |
| Personal data remains accessible as Markdown, attachments, and SQLite. | Open and edit saved source outside the app; recover documents and media from a complete folder copy. | Data-folder contract and recovery guide. |
| Compatible applications work with the same data. | Two interfaces use one compatible format and preserve fields they do not understand. | Application composition guide and worked example. |
| SQL tools can query the data. | Generate and open the root index; regenerate it after source changes without losing source. | SQLite index contract. |
| Apps compose the capabilities they need. | A small application acquires only its required resources and has a documented build path. | Package READMEs and starter guide. |
| Applications have independent repositories, releases, and domains. | Build, release, and use one app without the Epicenter desktop host. | Whispering README and independent release instructions. |
| Publishing software does not publish user data. | Two users run the published app with separate data; document access and network behavior. | Application access and trust contracts. |

The next documentation pass should define the target application guide and a smallest complete developer journey: create an app, save data, inspect it externally, change the interface, reopen compatible data, and publish the app for another person. Missing APIs and unsettled access or synchronization contracts stay explicit in design notes; do not invent commands to make the journey appear implemented.

## One sentence

Make the root README and Epicenter landing page explain the personal-software foundation, while Whispering's public material identifies Braden as its publisher and describes its available build.

Today the public surfaces describe incompatible older architectures. The target separates publisher identity, application behavior, data ownership, and optional Epicenter services. This work is complete when the surfaces tell the same story, state availability accurately, and direct visitors to working next steps.

## Settled direction

Use the product articulation from [ADR-0470](../docs/adr/0470-epicenter-helps-people-make-software-that-is-unmistakably-theirs.md):

> Make software that’s unmistakably yours.
>
> Keep your data in Markdown and SQLite files you own. Use our apps, someone else’s, or build your own.

Use this approved attribution for Whispering:

> Whispering
>
> Press a shortcut. Speak. Get text.
>
> By Braden Wong. Built on Epicenter.

Link Epicenter to `https://epicenter.so`. The shortcut line describes desktop use; any browser offering must explain its supported interaction separately.

The intended Whispering home is `whispering.bradenwong.com`. The intended source home is `braden-w/whispering`. These are destinations, not evidence of an existing deploy or extracted repository. Independent builds and releases are the target; the current desktop build still depends on Epicenter's host.

[ADR-0460](../docs/adr/0460-vocab-and-whispering-are-braden-wongs-apps-built-on-epicenter.md) records publisher identity. [ADR-0449](../docs/adr/0449-epicenter-connects-independent-applications-through-personal-data.md) records independent applications. The repository move is follow-up engineering work; this plan does not extract code or choose new package boundaries.

## Current evidence

| Surface | Current mismatch | Planned treatment |
| --- | --- | --- |
| [Root README](../README.md) | Leads with a CRDT store, declares one runtime, and refuses third-party installed apps. | Lead with the personal-software purpose. Explain the current implementation and independent-app destination separately. |
| [Landing homepage](../apps/landing/src/pages/index.astro) | Leads with local-first apps and claims every tool shares one folder today. Contains an outdated API snippet and product lineup. | Rebuild its narrative around shaping software and retaining data. Replace unsupported availability claims and unverified examples. |
| [Shared layout](../apps/landing/src/layouts/BaseLayout.astro) | Uses a generic default description and gives every page the homepage canonical and Open Graph URL. | Align metadata with page purpose and use each page's actual public URL. |
| [Whispering page](../apps/landing/src/pages/whispering.astro) | Links to the former browser origin and contains broad privacy and pricing claims. | Present the approved identity, actual build availability, and connection-dependent inference behavior. |
| [Whispering README](../apps/whispering/README.md) | Correctly documents the present Epicenter host dependency, but retains older refusals as permanent policy. | Preserve current build instructions. Explain the independent product destination without claiming it ships. |
| [Positioning](../docs/positioning.md) | Defines Yjs authority, one-way projections, and Whispering as Epicenter's main product. | Reconcile the product story with ADRs 0450, 0460, and 0470. Link architecture details to their owning docs instead of retaining obsolete copy rules. |
| [Earlier landing plan](20260612T063520-landing-page-public-realignment.md) | Plans a Whispering-led Epicenter homepage and forbids agent-oriented public copy. | Replace its conflicting execution path with this plan during implementation and retire the old spec under the spec lifecycle. |

[ADR-0450](../docs/adr/0450-current-files-own-portable-document-data.md) explicitly identifies the live application migration to file authority as unbuilt. [ADR-0451](../docs/adr/0451-one-cloud-subscription-includes-hosted-inference-across-apps-without-credits.md) identifies the shared subscription without credits as unbuilt. Neither capability can become a present-tense public promise through a copy change.

## Work backward from the experience

[Target README draft](personal-software-readme-draft.md) is a separate future-state writing exercise. Braden requested present-tense copy as if the vision is implemented, to judge the complete user journey before updating current public documentation. The initial version included personal publishing; the technical-reader revision below narrows its role. Its review notes identify unresolved services and the required tested starting path. The live README still documents current behavior.

The subsequent technical-reader review separates the surfaces: the README explains the data contract and provides developer proof; the landing page owns the invitation and app discovery. The revised target draft preserves the accepted Markdown-and-SQLite opening, then demonstrates an illustrative recording folder before explaining SQL. It removes the promotional app catalog and hosted publishing/community story. Independent publication remains a short ownership explanation. Fresh Codex and Opus reviews checked the draft against the ADRs; integration corrected the recording-body transcript assumption using current Whispering source. The illustrative format is not a settled migration schema.

Braden’s next correction rejects the app-specific example and conversational agent narrative as the README’s opening structure. The current target draft instead explains the general relationship between applications and accessible personal data, followed by Data model, Application model, Development, and License. It draws that articulation from ADRs 0208, 0209, 0449, and 0470 without restoring superseded projection or runtime mechanisms. A worked example is deferred to a developer guide; the live README remains unchanged.

```text
Person discovers Whispering on Braden's website
  -> understands speech-to-text and obtains its available build
  -> chooses a supported inference connection
  -> saves recordings and transcripts under the build's actual storage rules
  -> follows "Built on Epicenter" to understand or adapt the foundation

Person discovers Epicenter
  -> understands the purpose: change software while retaining saved work
  -> sees a concrete example and its implementation status
  -> explores an app or follows a verified developer starting point
```

The destination proof is one app saving real data, changing its interface, and reopening the same compatible data. Publishing the app lets another person use their own data. Until exercised, present this sequence as what the foundation is being built to support. Do not illustrate it as a completed product demonstration.

Whispering's existing desktop Add to Capture action is a specific integration. Separately hosted browser apps do not currently have that handoff. Quickcapture remains a prospective personal app example, not a deployed product entry.

## Page outlines

The approved four-paragraph opening has now been applied verbatim to the root README. The remaining README uses the general data/application model with a separate implementation-status section, current trust boundaries, development entrypoints, and license. The previous API tutorial and app catalog were replaced by links to their owning READMEs. Local links and exact approved text were verified. The landing page and app README edits remain pending.

### Root README

1. Approved Epicenter headline, purpose, and a nearby statement of current readiness.
2. Short ecosystem explanation: independently published apps, shared primitives, optional services, and the person's data.
3. Current status: what runs, where it runs, and what still needs migration or independent packaging.
4. Developer starting point using actual exports and a supported workflow. Verify the existing example against source before retaining or replacing it; do not invent the future file API.
5. Repository map, development commands, trust boundaries, contribution path, and license.

Keep useful technical details accessible through package READMEs. Yjs describes current mechanisms where applicable; it does not define the overall brand. Remove blanket runtime refusals and unsupported app-status claims after checking current source.

### Epicenter homepage

1. Approved headline and a concrete explanation of the foundation. State its development status alongside the file-ownership promise while migration remains unbuilt.
2. A short explanation of why software should fit a person's life while saved work survives changes. Keep capability contracts in developer material.
3. Apps built on Epicenter: publisher attribution and truthful availability for the examples that earn inclusion. Whispering and Vocab demonstrate Braden's apps; repository membership does not determine publisher identity.
4. A working next step. Initially use a code link and app information links. Use "Build your first app" only when a tested starting path exists.

Do not put the hypothetical build/save/redesign demonstration, capability checklist, cloud-provider section, or generic FAQ on the initial homepage. An actual proof can earn space later. Provider and privacy details belong with the app or service whose behavior they explain.

Remove the obsolete quickstart snippet, shared-memory claims, unsupported "Available now" guarantees, and unrelated product cards. Delete a component only after checking its consumers. Use the shared component system when implementation begins.

### Whispering material

Lead with the approved product copy and linked attribution. Follow with the available acquisition path and capabilities, then provider choices and data behavior. Distinguish the current Epicenter-hosted build from the future standalone build.

Retain `/whispering` as useful product information during the transition. Link to the personal-domain page only after verifying it serves the intended content. Redirect only once that destination is live. The repository's own README links must continue to resolve until extraction actually happens.

## Decisions and boundaries

| Decision | Basis | Consequence |
| --- | --- | --- |
| One Epicenter promise, different reader paths | Coherence; ADR-0470 | README supports developers; homepage explains the purpose before implementation details. |
| Braden publishes Whispering | Coherence; ADR-0460 and user-selected attribution | App identity leads. Epicenter attribution explains the foundation. |
| Present capabilities require evidence | Current source and ADR Unbuilt entries | Do not imply live file authority, standalone packaging, or a shared credit-free plan. |
| Transcription is initially a capability | Scope of the requested branding work | Do not add a Transcribe product or deploy `transcribe.epicenter.so` in this change. |
| Personal domain and source repo are destinations | User-selected names; current host coupling | No dead acquisition links and no extraction claim before independent builds work. |

This work changes explanations and the landing site. Native packaging, durable IDs, recording migration, authentication origins, cloud entitlements, repository extraction, and domain deployment are separate implementation work. Paying for inference does not imply synchronizing recording history. Publishing an app does not publish its user's files.

## Implementation sequence

### Approval checkpoints

Braden requested step-by-step approval before replacing existing articulations or public surfaces. Drafts and local previews can proceed; approval of one checkpoint does not approve the next replacement.

1. Review the retained ideas, retired claims, and unresolved cruxes below. Approve the positioning replacement before editing `docs/positioning.md` or retiring the earlier spec.
2. Review the Astro prototype and choose the page hierarchy and copy. Approve the resulting page before replacing `index.astro` or changing shared metadata.
3. Review the complete proposed README text beside the existing text. Approve its replacement before editing the root README.
4. Review Whispering attribution, availability, and transition links before replacing its page or README.
5. Review the integrated result and verification. Publishing, domain changes, and repository extraction remain separate actions.

### Ideas to retain and claims to replace

Retain "Your data outlives the app that wrote it," concrete app usefulness, inspectable formats, model choice where supported, and explicit trust boundaries. "Apps come and go. Your files shouldn't" can explain durability below the headline; it need not compete with the approved main articulation. "Capture, curate, keep" describes Braden's app workflows rather than the whole foundation.

Replace blanket claims that every app already shares one folder, that all app data must permanently live in Yjs, that desktop hosting is mandatory, or that exports are universally unnecessary. Preserve accurate implementation details in current-state sections.

### Cruxes to resolve through review

- The initial customer is someone adapting software with a coding agent. Does the page make that person recognize a problem they have, without requiring them to build an app before getting value?
- Epicenter must earn its place beyond files an agent can already write. Which working save, recovery, or reuse example can demonstrate that value?
- "Yours" must include saved data and workflow freedom. Compatible data contracts permit reuse; arbitrary apps and formats do not automatically interoperate.
- A portable native folder and browser-managed storage are different experiences. Browser access from independently published origins remains unbuilt and cannot be implied by domain branding.
- Epicenter the foundation, Epicenter desktop, and Epicenter Cloud need distinct explanations. The current host must not become a permanent prerequisite through copy.
- Third-party adoption needs an independently buildable dependency path and clear distribution terms. Current shared packages are private and AGPL; "build your own" does not establish a published SDK or unrestricted licensing promise.
- Braden's personal apps can integrate deeply while their shared contracts remain usable by another publisher. Quickcapture and a separate Transcribe product are not established deployments.

The local, throwaway Astro preview is `/prototype/personal-software?variant=editorial`, with `proof` and `apps` alternatives. It tests entrances to the same promise, not three competing architectures. Its production static-path list is empty. Keep the homepage and existing positioning untouched until their checkpoints are approved.

### September 30 design review and dialectic

Braden rejected the initial preview's documentation-like presentation and AI section. He requested a warmer, sepia or humanistic direction, using `/Users/braden/Code/blog` as a reference, with several expressions visible side by side before a complete redesign.

A fresh read-only GPT-6.1 Sol reviewer and read-only Claude Opus 5.5 reviewer independently inspected the implemented draft. Both found that the page presented the specification as public copy. The accepted simplification removes capability lists, the hypothetical demonstration, cloud/provider copy, future-domain migration detail, and repeated readiness caveats from the homepage. Necessary implementation and migration work remains; its explanation moves to app and developer documentation.

The next draft follows Opus's three art-direction briefs at `/prototype/brand/board`, with full-size studies at `/prototype/brand/invitation`, `/prototype/brand/studio`, and `/prototype/brand/guide`. These routes are dev-only. Their shared copy is held constant so the comparison exposes character and hierarchy:

- Invitation: Georgia, warm paper and brick links; purpose first, app authorship beneath.
- Studio: apricot and terracotta, bold sans with Georgia italic; app specimens on a small pinboard.
- Field guide: cream and forest ink, Georgia display, publisher fields within app entries.

Braden selected the left version of the subsequent typography comparison: A's paper and brick accents with C's left alignment, roman Georgia for the headline, and sans serif for navigation, app names and body text. This settles the typography direction for the next draft, not the complete homepage or its unresolved copy. Opus initially suggested a founder letter; the focused follow-up rejected a signature and portrait because they risk making the foundation a personal portfolio and require invented author convictions. The unsigned invitation instead expresses human presence through useful apps and their publisher attribution.

The typography comparison is available in development at `/prototype/typography/board`, with full-size `/serif` and `/sans` variants beneath `/prototype/typography`. It holds layout, palette and copy steady while changing the headline font. These routes are excluded from production builds.

Braden also requested a comparison with the current [Y Combinator homepage](https://www.ycombinator.com/). Its restrained cream, serif display and compact sans navigation reinforce the selected direction. Its company imagery suggests a further proposed refinement: show actual app use beneath Epicenter's purpose, preserving each app's independent identity. Do not copy its company carousel, valuation claims or visual scale. A screenshot or demonstration of Whispering would need to reflect current behavior. This refinement remains a proposal.

Status must be normal readable copy next to the foundation purpose, and current build information must appear beside app actions. The proposed sentence is "Epicenter is early. We’re building the file foundation in the open." Braden's approval is still needed for this sentence and Vocab's draft tagline. The supporting phrase "Use our apps" also needs judgment alongside personal publisher attribution; do not silently change his selected copy.

The blog uses Georgia and Libre Franklin with warm stone and brick accents. These studies use local Georgia and existing Geist for an initial comparison; font selection can follow the chosen direction. Do not retheme shared product UI to match a marketing study. The cost of the smaller homepage is less immediate technical detail; the benefit is an understandable invitation with accurate availability. Code and build-information links retain the path to that detail.

Claude consultation session: `72ed12e7-6fe9-4603-98fc-f573e6f8ddd3`, verified model `claude-opus-5-5`. Claude provided review and art direction only. Codex owns the Astro implementation. A complete Opus-led redesign remains after the user's dialectic and selection, not implied by producing these studies.

### Execution checklist

October 1, accepted direction and visual cleanup: Braden loves the refined direction, especially “Your files in the middle. Apps around them,” and requested smoothing visual artifacts. The refined preview now fades hero rings before the section boundary and omits curved labels whose complete bounds cannot fit. The file panel no longer rotates text off the pixel grid. Status badges use flex layout and explicit leading so padding is respected. The large footer wordmark uses the serif family and shows its complete baseline. Desktop at 1440px, intermediate at 1024px and phone at 390px were inspected; final desktop and phone documents have no horizontal overflow. This acceptance settles the visual direction for continued refinement, not publishing or replacing production material. Original A remains intact.

October 1, project skill commit and refinement: Braden authorized saving and committing both design skills at project level, then building with them. Both complete skill folders and upstream license files are now tracked under `.agents/skills/` in this isolated worktree, commit `41fca18bd0`. Global installations remain available. No hooks were installed. `/prototype/opus/refined` is a separate copy of A guided by frontend-design and Impeccable's refinement guidance. It keeps the palette, display family, rings, product facts and sample behavior, while reducing hero space, using roman display and sans body prose, removing paper noise, decorative eyebrows, numbered folios and repeated section entrance animation. `/prototype/opus/refinement` compares the original and refined pages at full width. This is a preview for judgment, not production approval. Desktop and phone rendering, sample tabs, practice reveal and mobile menu were inspected. Typecheck and build passed; small scan-flagged labels were subsequently enlarged. The original A and public homepage remain unchanged.

October 1, design skill setup: Braden prefers the warm earlier direction and Opus A, and rejects B and C. A is closer, not an approved finished design. At his request, installed and read both upstream skills in `/Users/braden/.codex/skills/`: `frontend-design` from `anthropics/claude-code/plugins/frontend-design/skills/frontend-design`, and `impeccable` from `pbakaus/impeccable/.agents/skills/impeccable` (skill version 4.4.0). Impeccable's context command successfully resolved A's source in this isolated worktree. The installed launcher required its executable bit restored after ZIP extraction. No project hooks were installed.

Lead subsequent work with both skills. Frontend-design owns the compact visual plan and restraint; Impeccable supplies focused critique, typography, layout and polish guidance. The user’s preference overrides any generic warning against cream, serif or warm accents. Preserve A and earlier references for comparison. Work on a separate preview copy of A, retaining product facts, app authorship and availability. Improve type proportions, readable measures, spacing and the app examples before adding visual effects. Do not interpret the skills' emphasis on boldness as a new request for a loud identity. Any Claude implementation brief must explicitly include both installed SKILL.md paths and their referenced guidance. Production copy and homepage replacement still require the established step-by-step user approval.

October 1: Braden rejected the previous studies as unprofessional and explicitly authorized three fresh Opus 5.5 implementation assignments. Each ran in its own shallow standalone clone of coordinating-worktree HEAD `4934146e0e15586d3a9be62a9655636fc4335118`, under `/Users/braden/.codex/design-labs/epicenter-opus-20261001/`. No previous conversation or prototype designs were supplied. Each received the same product facts and a separate creative brief. The resulting designs remain proposals; none replaces the earlier choices or establishes a selected production identity.

- `atelier`: warm independent software studio. Session `e49b7d5d-d42d-4f27-85ff-f383e76b9677`.
- `instrument`: technical drawing and an interactive builder bench. Session `fd56fec5-1181-4d40-b130-d1039e946fa7`.
- `journal`: bold graphic publication. Session `e290f6e5-2e90-4535-824d-a3ffe098103b`.

All sessions used verified model `claude-opus-5-5`. Claude produced standalone HTML, design rationale and offline checks in each clone's `design-study/`. Codex reproduced those checks, then copied only HTML and rationale into `apps/landing/src/prototypes/opus/`. The development-only Astro route `/prototype/opus/board` stacks the complete pages at full width, with individual `/atelier`, `/instrument` and `/journal` pages. Supporting artifacts stay outside Astro's pages folder. The original checks remain in the independent clones.

Codex inspected desktop rendering at 1440px and phone rendering at 390px, with no horizontal document overflow at the inspected phone width. Sample folder tabs, transcription illustration, Vocab practice, assembly slider, app renaming and table switching, entry editing and adding, and cover customization worked in browser checks. The board displayed three 1240px-wide embedded pages with content-driven heights. Landing typecheck and build passed. The production build emitted no prototype pages. The README and production landing pages remain unchanged pending Braden's step-by-step approval.

October 1: Braden requested a more active builder direction and wide examples because narrow columns obscure the layouts. `/prototype/builders/wide` now stacks three full-width embedded pages: the new Workshop, the working collection, and the shared place. Each opens independently. At the inspected desktop size, every embedded preview is 1240px wide and adjusts its height to its contents. The earlier single-study pages now allow a wider container. `/prototype/builders/workshop` puts an editable name and note beside the selected serif hero, with accent choices and reset. It is explicitly an illustration with no persistence, inference, or backend; it does not establish a new shipped Epicenter app. Rename, accent switching and reset were verified in the browser. No direction is selected by creating this study. Typecheck and build passed.

Braden rejected the paper/voice study as more corporate than the previous draft, specifically questioning the ellipse around “yours.” The circle, oversized campaign typography and filled marketing actions are not accepted brand elements. He requested three more options side by side. `/prototype/places/board` now compares an open notebook (a small transcript example), a working collection (prominent app names and directory rows), and a shared place (an editorial reading column and maker credits). Each has an “Open” link for its full-size layout. These are new proposals; no option is selected. Preserve the earlier typography choice, but do not interpret “less plain” as permission to add marketing flourishes. The previous paper/voice study remains only for comparison.

Braden accepted “apps built on Epicenter” as the authorship direction, but found the feature study too plain and requested online research and a creative landing-page pass. The next study is `/prototype/paper/voice`, following Opus 5.5's “paper, ink and a voice” art direction in the same read-only consultation session. It uses a larger roman-serif headline, a static brick ellipse around “yours,” a primary app-discovery action, a ruled-paper sample interaction, and publisher credits. The proposed supporting sentence is “Keep your data in Markdown and SQLite files you own. Use apps built on Epicenter, or build your own.” This narrows the previously selected alternatives clause, so it remains draft copy for judgment.

Research: [NNGroup homepage principles](https://www.nngroup.com/articles/homepage-design-principles/), [Linear](https://linear.app/), [Stripe](https://stripe.com/), and the earlier YC reference. These inform purpose, examples and actions; they do not prove this design converts. The new study removes the archival screenshot. The microphone is Whispering's actual source asset; the sentence is a labeled illustration, not live recording, inference or file persistence. The sample works by button, has an accessible completion announcement, shows the final text without JavaScript, and skips animation with reduced motion. Desktop rendering and sample completion were inspected; mobile at 390px showed no horizontal overflow. Typecheck and build passed with no prototype pages emitted. No production material changed.

The earlier content-arrangement studies are `/prototype/story/feature` and `/prototype/story/collection`. Both preserve the selected roman-serif direction and app attribution. The feature keeps Whispering's promise beside its image; the collection places apps in adjacent entries beneath a compact two-column introduction. Codex recommended the feature because its image and explanation stayed together, but Braden found it too plain. The image is an archival screenshot from the blog, explicitly captioned as a layout reference. These studies remain comparison references; no public-material replacement is authorized by creating them.

- [ ] Audit current public claims against app source, package exports, build scripts, and live destinations. Record which acquisition links actually work.
- [ ] Reconcile `docs/positioning.md` with the selected direction. Retire the conflicting older landing spec and record its replacement in `docs/spec-history.md` using the existing lifecycle.
- [ ] Rewrite the root README as a whole. Verify examples and commands rather than retaining old technical prose by default.
- [ ] Rebuild the Epicenter homepage from the outline; align metadata and remove obsolete copy and unused components.
- [ ] Align `/whispering`, its app README, and the landing app README. Update the apps index or host README only where a touched explanation would otherwise contradict them.
- [ ] Audit adjacent navigation, FAQs, and link destinations. Preserve historical blog posts as historical writing; do not silently rewrite the archive into present-day messaging.
- [ ] Preview desktop and mobile layouts, follow each CTA, and review the cumulative change against the intended experience.

All edits, installs, builds, and previews run in the worktree named above. Start a dev preview there with `bun dev:landing` from that worktree's root. Do not switch branches, stage changes, or run broad formatting in `/Users/braden/Code/epicenter`.

## Verification and completion

This planning change only creates this spec. During implementation:

- Run `bun run --cwd apps/landing typecheck` and `bun run --cwd apps/landing build` from this worktree root. Report failures with evidence; do not guess their baseline.
- Verify README examples against current exported APIs, using a focused check if needed. Check relative documentation links and root development commands.
- Inspect the rendered homepage and Whispering page on desktop and mobile. Essential copy and links must remain usable without client JavaScript. Check page titles, descriptions, canonical URLs, and social metadata.
- Search touched surfaces for obsolete branding, unsupported file or sync guarantees, wrong publisher attribution, old origins, and claims that independent releases already exist.
- Follow each acquisition link and make sure it delivers the build or information promised. A future URL is insufficient.
- Apply post-implementation review to the whole diff before handoff. Confirm the landing page, README, product attribution, and availability statements agree.

The copy change can complete before product independence does. A standalone Whispering build, personal-domain launch, and repository extraction remain separately verifiable milestones. Once this plan's public-material work lands, retire the spec according to [the spec lifecycle](README.md).
