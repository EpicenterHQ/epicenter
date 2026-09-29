# 0227. One runtime: a desktop SPA in a WebView, over a client-owned store

- **Status:** Accepted
- **Amended by:** [ADR-0273](0273-an-epicenter-app-is-an-spa-with-a-namespace-and-background-work-is-a-hidden-window.md) at two points: a window may run without being shown, and the client-owned store is what an application may use rather than what makes it one. Proposed amendment: [ADR-0449](0449-epicenter-connects-independent-applications-through-personal-data.md) revises the refusal of standalone desktop products.
- **Amended by:** [ADR-0305](0305-the-third-party-app-catalog-is-a-future-epicenter-deployment-plane.md) at the temporary refusal of third-party installed apps. The current product remains one first-party runtime; the future catalog plane is preserved as an unbuilt deployment direction.
- **Amended by:** [ADR-0310](0310-an-applications-provider-credential-is-a-labeled-secret-and-the-browser-keeps-none.md) at the hosted-web refusal, which shipped code already contradicts. A browser build is a target again, and a deliberately reduced one. Every other refusal here stands.
- **Date:** 2026-08-08
  this branch. Reconcile at merge time (`docs/adr/README.md`).
- **Supersedes:** [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md),
  [ADR-0210](0210-an-installed-app-declares-its-name-and-the-namespace-it-owns.md),
  [ADR-0211](0211-an-installed-app-runs-only-inside-epicenter-so-its-client-stops-asking.md)
  and [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md):
  the third-party installed-app plane is refused for now, so the client it was
  reached through, the folder it was admitted as, and the declaration it carried
  all go with it.
- **Amends:** [ADR-0226](0226-a-host-serves-bundles-and-brokers-credentials-it-owns-no-application-data.md),
  widening it from Honeycrisp to every surface.
- **Relates:** [ADR-0223](0223-a-page-holds-the-store-and-only-three-small-relations-have-to-survive.md)
  (where the store runs),
  [ADR-0225](0225-a-store-authority-is-one-durable-object-per-principal-and-application-and-being-signed-in-is-the-sharing-model.md)
  (the one authority),
  [ADR-0215](0215-an-application-is-one-document-and-a-row-owns-a-nested-container.md).

## Context

The repository supported five runtimes at once: a hosted web SPA, a standalone
Tauri bundle, a build the desktop host served, a Bun entrypoint, and a Chrome
extension. Every one of them multiplied the seams. Whispering alone declares
NINETEEN `#platform/*` seams; fourteen are native-capability seams whose
`default` leaf exists only so the app can run in a browser it is not really
for.

Underneath, 69% of `packages/data` was a superseded stack kept alive because
nine consumers still imported it, and `packages/lens` carried a second
vocabulary for the same reason. Two data models, two contract vocabularies,
five runtimes, and one of everything actually being used.

## Decision

**One runtime: a desktop SPA in a WebView, served by a Bun host, over a store
the client owns.** The host serves bundles and brokers credentials (ADR-0226,
widened here to every surface). The store lives in the client (ADR-0223). Sync
is one authority per account (ADR-0225).

Four refusals follow, and they are refusals rather than deferrals:

- **Hosted web is refused.** A browser tab is not a target, so a native
  capability seam collapses to its `tauri` leaf and the `default` leaf is
  deleted rather than maintained.
- **The Chrome extension runtime is refused**, and `apps/tab-manager` is
  deleted with it. An extension has its own storage model and no WebView host,
  so keeping it would mean keeping a second data path for one consumer.
- **Third-party installed apps are refused for now**, and `packages/app` goes
  with the plane. `packages/lens` survives as the inert vocabulary and is the
  seed if this is ever rebuilt.
- **The superseded data stack is deleted rather than kept compiling.**
  `@epicenter/data/legacy/*`, `@epicenter/lens/legacy`, and
  `packages/document-sync`.

**Existing data on the superseded stack is accepted as lost.** No importers, no
probe, no restore prompt. An importer is a reader for the old format, which is
the code this decision exists to delete, kept alive under a kinder name.
Honeycrisp already took this stance and said so in its README.

**vocab and skills survive, and their shapes are deliberately undecided.**
Neither is in the host's served set today, so neither has a runtime under this
decision, and the obvious reading is that they follow tab-manager. They do not.
What is refused is the extension runtime and the third-party app plane, not
these two applications; what is unsettled is what their data and their Lens
should look like, which is a design question nobody has answered and which this
record is the wrong place to answer. They stay broken until someone does, and
that is a smaller cost than deciding their shape in a hurry to make a deletion
tidy.

**Applications may be broken in the interim.** The deletion lands before the
migrations, because the reverse order is impossible: the new store has no
row-document HTTP path, no multi-process observation carrier and no extension
storage, so there is nowhere for a consumer to move until those are refused.

## Consequences

About 13,500 lines are deleted across `packages/data`, `packages/lens`,
`packages/document-sync`, `packages/app` and `apps/tab-manager`.

Whispering, vocab, skills and `apps/epicenter` stop compiling when the stack
goes, and are rebuilt against the store afterwards. That interval is the price
of the ordering above, and it is visible in the branch rather than hidden
behind a compatibility layer.

**A fresh install now transcribes on device.** Whispering's default
transcription service was `OpenAI`, injected by the runtime, and it was that
because a browser build cannot run a local model. With the browser build refused
the constraint is gone, so the Lens declares `transcriptionService = 'local'` and
a fresh install works with no API key, which the old default never did.

The failure mode is already handled rather than newly introduced: the local
route needs an active model (ADR-0180), and when there is none
`getLocalRouteBlocker()` returns the host's own sentence and the UI shows it
verbatim. It degrades to a stated reason, not to silence.

**What this gives up is real.** Whispering's recordings, vocab's data and
tab-manager's saved tabs become unreachable. The hosted web surface, which is
how somebody tries the product without installing anything, stops existing. And
third-party apps, which ADR-0186 through ADR-0211 built a whole admission model
for, stop being a thing the product does.

**What would reopen it.** Hosted web, if trying-before-installing turns out to
matter more than the seams cost: the store already runs in a page (ADR-0223),
so the refusal is about capability seams rather than storage. Installed apps, if
there is ever a second party to build one; the vocabulary survives for that
reason.

The one thing that does NOT reopen it is a request to keep an old app working.
That is what a compatibility layer is, and it is what this decision refuses.
