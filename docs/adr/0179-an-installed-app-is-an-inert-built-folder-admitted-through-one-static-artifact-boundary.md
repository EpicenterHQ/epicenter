# 0179. An installed app is an inert built folder admitted through one static-artifact boundary

- **Status:** Accepted
- **Date:** 2026-07-25
- **Superseded by:** [ADR-0227](0227-one-runtime-a-desktop-spa-in-a-webview-over-a-client-owned-store.md): the installed-app plane is refused for now, so no folder is admitted and the static artifact boundary has nothing to admit.
- **Supersedes:** [ADR-0153](0153-trusted-apps-are-source-built-static-catalog-members.md). Its source-build admission mechanism, composition-root source convention, and build-time trust ceremony are withdrawn; its runtime trust model, immutable-generation catalog, and app-window authority are restated below so this record stands alone. This record also carries forward ADR-0153's supersession of the future third-party installation shape in [ADR-0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md): installation still does not begin with a runtime manifest, permission grant, or installed-app registry.
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) at the app-admission and native-authority boundary, inheriting ADR-0153's reversal of its refusal of a generic outbound HTTP surface; and [ADR-0152](0152-epicenter-home-is-a-shell-above-workspaces.md) at the deferred third-party installation boundary. Both amendments pass through ADR-0153 unchanged in substance.
- **Amended by:** [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md) at one bounded clause of the native command surface: unrestricted HTTP and HTTPS through the Tauri HTTP plugin is withdrawn in favor of one attributed host gateway. That withdrawal did not survive: [ADR-0185](0185-trusted-app-http-uses-tauris-standard-transport-without-observation.md) restored this record's unrestricted grant one day later, so the grant below is what governs and the code still carries it. Read ADR-0183's clause as a target that was reconsidered, never as the current rule. And by [ADR-0186](0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md) at the same clause, which adds recording and transcription to it, so specialized native commands no longer stay host-only or bound to Whispering. The admission boundary, the full-trust ceremony, and the refusal of per-app permissions and prompts are unchanged. And by [ADR-0210](0210-an-installed-app-declares-its-name-and-the-namespace-it-owns.md) at two clauses. "Installation still does not begin with a runtime manifest" is withdrawn for a declaration of name and shape only, which carries no authority; the refusal of a permission grant, an installed-app registry, and publisher identity stands, as does the refusal to install dependencies, run a build system, or read application source. And "presentation metadata is derived from the app's own validated output" is withdrawn for the title: an app declares its name, or is called by its id, and the `&lt;title&gt;` scrape is deleted rather than kept as a fallback. And by [ADR-0402](0402-a-window-label-is-identity-never-authority-and-the-capability-is-a-host-constant.md) at "only the third is bounded by a capability file": the host grants every native verb to every window, so no clause of the surface is bounded by a capability file.
- **Relates:** [ADR-0155](0155-epicenter-desktop-auth-is-one-credential-free-window-bun-authority.md), [ADR-0160](0160-lenses-interpret-durable-namespaces-without-creating-lifecycle-scopes.md), [ADR-0168](0168-lenses-are-complete-pure-json-interpretations.md), [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md)

## Context

ADR-0153 settled the trust model correctly: one shared browser origin, no
per-app sandbox, admission rather than containment as the protection. It then
bound admission to one mechanism. Epicenter would run the app's own
`bun install --frozen-lockfile` and `bun run build` from a user-owned
composition root, and that was the only way a folder could become a catalog
member.

That coupled three separable things: where an artifact came from, whether
Epicenter executes the app's toolchain, and what authority the served app
receives. Only the third is a real boundary. Executing an arbitrary app's build
system is the most powerful thing Epicenter could do on a user's machine, it
happens outside the runtime authority floor ADR-0153 spent its length defining,
and it is not needed to serve static files.

<!-- doc-path-check: ignore-next-line -->
The running code already moved. `apps/epicenter/scripts/publish-app-catalog.ts`
promotes finished `dist/` trees and states in its own header that it does not
install dependencies or run build scripts. The accepted decision and the
shipped promotion command disagree.

ADR-0153 also deferred prebuilt third-party distribution as "a different
product" needing its own record. Reading it against the artifact-only promotion
path shows the opposite: a prebuilt folder and a locally built folder are the
same object arriving at the same door.

## Decision

An Epicenter app is a folder of inert, already-built static files. There is one
admission boundary, and it accepts folders.

**Epicenter never runs an app's build system.** It does not install
dependencies, execute build or postinstall scripts, or read application source.
Admission validates a finished folder and copies it.

**Provenance is outside the contract.** A folder may come from a publisher URL,
a self-hosted builder, a local developer build, or offline media. All four
enter through the same boundary and receive exactly the same authority. Nothing
about where a folder came from grants or withholds privilege, and the host
keeps no provenance-derived trust level. How a folder reaches the disk is not
Epicenter's job either: admission starts at a folder that is already there, so
naming a publisher URL as an origin describes where a user got files, not a
fetcher Epicenter operates.

**Source correspondence is an unverified publisher claim.** Source may sit
beside an app, linked and editable, and a developer may iterate on it freely.
Epicenter does not read that source, does not verify that the built folder came
from it, and does not present the pairing as evidence. A developer clones,
builds externally, and submits the built folder like anyone else.

Carried forward from ADR-0153, unchanged:

- Admission publishes one complete immutable generation beneath the host-owned
  catalog root, then atomically replaces a small `current` pointer. A process
  resolves that pointer once at startup and serves that generation directory
  for its whole lifetime, so publication cannot hot-swap a running process.
  Activation is a full restart. Generations are never mutated and never
  automatically deleted. There is no generation manager and no rollback pointer:
  recovery is admitting the folder you want again.
- The catalog is derived from validated output, never authored by a host
  manifest. The app ID is the direct folder name matching `[a-z0-9-]+`, and a
  folder claiming a reserved built-in surface ID is not a member. Presentation
  metadata is derived from the app's own validated output, falling back to the
  ID and a host default.
- Bun serves every member through one generic containment-checked resolver at
  `/apps/<id>/`. A missing extensionless path falls back to that app's
  `index.html`; a missing asset does not.
- Within the catalog, admitted output with the same ID as a bundled member
  replaces it. Admission names every replacement prominently. There is no second
  permission ceremony, because replacement does not increase authority. This is
  scoped by the reserved-ID rule above: a built-in surface that is not yet a
  catalog member cannot be replaced, because its ID cannot be admitted at all.
- Rust opens members through one validated app-window path. App windows use one
  reserved `app-` label prefix, one capability glob covers them, and the
  frontend never supplies a window URL.
- App code is static client code. An installed app ships no host module and
  gains no background lifetime; durable background work stays a host-owned
  service or an external tool.

### Full trust, stated at full width

An installed app runs **as** Epicenter, not beside it. Its authority is the
union of three things, and only the third is enumerated anywhere:

1. **The shared browser origin.** Same cookies, same browser storage, same
   session, same Epicenter data, same same-origin APIs as every other Epicenter
   surface (ADR-0118).
2. **Device access under the Epicenter application's own OS grants.** Browser
   and device APIs reach an app window through whatever the platform allows the
   Epicenter webview process and profile, and the underlying OS grant belongs to
   the Epicenter application, never to the individual app. Microphone capture is
   the verified case. Which further APIs a generic app window reaches is
   platform behavior that Epicenter neither enumerates nor mediates, so this is
   a statement about who holds the grant, not a per-API guarantee in either
   direction. The durable part: there is no per-app device permission and no
   per-app prompt, so a request from an app window is a request from Epicenter.
3. **The native command surface reachable from an app window.** Today that is
   unrestricted HTTP and HTTPS through the Tauri HTTP plugin, plus the
   recording and transcription operations the public `@epicenter/app` client
   exposes (ADR-0186).

Only the third is bounded by a capability file, and it is the smallest of the
three. Presenting the app-window capability list as an app's sandbox would be
false. What that file names is a product decision rather than an isolation
one: an operation is in it because the client offers it to every app, and the
native commands left out of it (model administration, device enumeration, the
rest of Whispering's own surface) are held back for API, resource, and
lifecycle correctness, not as a boundary.

The protection is admission. A user who admits a folder is choosing to run that
code as Epicenter.

### Deliberately not decided here

This record decides the admission boundary and nothing downstream of it. It does
not decide a registry, publisher identity, artifact signing, update discovery,
update UX, pinning, or how a publisher URL earns trust. "A folder may come from
a publisher URL" describes an entry path, not an endorsement mechanism, and no
part of that product design may be inferred from this ADR.

## Consequences

- The most dangerous operation ADR-0153 defined, executing an app's toolchain
  with the user's machine authority, is deleted rather than confirmed. Admission
  now means "serve these files at this origin."
- A non-developer can receive and admit a prebuilt folder without a toolchain.
  ADR-0153's claim that prebuilt distribution is a different product is
  withdrawn as a boundary claim; the open questions it named are registry
  questions, not admission questions.
- Epicenter can never tell a user that a served app matches source sitting next
  to it. Anyone who wants that guarantee builds the artifact themselves and
  admits their own output.
- ADR-0153's `package.json`, `bun.lock`, and `build`-script source convention
  stops being a host contract. `index.html` at the folder root remains the one
  convention, because the resolver needs an entry document, not because a build
  system produced it.
- A malicious admitted app can read same-origin Epicenter data, use granted
  device access, and exfiltrate through native HTTP. This is unchanged from
  ADR-0153; it is now stated across all three sources of authority instead of
  one.
- Any Lens an app ships travels as one of these inert files, is validated as
  pure JSON (ADR-0168), and grants its app no admission authority and no
  ownership of the data it interprets (ADR-0160).
- Registry, signing, and update remain unbuilt and undecided, so there is no
  supported way to learn that an installed folder is out of date.

## Considered alternatives

- **Keep source build as the only admission path (ADR-0153).** Rejected: it
  makes the least trustworthy step mandatory, excludes every non-developer, and
  already contradicts the shipped promotion command.
- **Two boundaries, one for source builds and one for prebuilt folders.**
  Rejected: both doors admit the same kind of object and grant it the same
  authority, so a second one would advertise a difference in trust that does not
  exist.
- **Verify source-to-artifact correspondence at admission.** Rejected:
  reproducing an arbitrary app's build is exactly the build execution this
  record deletes. An unverified claim, honestly labeled, beats a verification
  Epicenter cannot perform.
- **Per-app device permission prompts.** Rejected: a full-trust app already
  holds the Epicenter session on the shared origin, so a prompt would advertise
  an isolation boundary that does not exist. Note that a window is not that
  boundary: each app already gets its own webview window, but every window loads
  the same loopback origin with the same session, so the window separates
  presentation and never authority.
- **A separate origin, storage profile, or process per app.** Rejected: this is
  the only shape that would make per-app permissions honest, and adopting it
  would reopen the one-trusted-origin decision (ADR-0118) and abandon the
  full-trust model on purpose. Full trust is the product, not an accident of the
  current window arrangement.
- **Grant privilege by provenance, so a publisher URL outranks a sideload.**
  Rejected: that is a registry trust decision, deliberately left open.
