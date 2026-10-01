# 0402. A window label is identity, never authority, and the capability is a host constant

- **Status:** Proposed
- **Date:** 2026-09-12
- **Amends:** [ADR-0189](0189-home-launches-applications-into-their-own-windows-and-stays-open-behind-them.md) at one consequence: "Its capability file is the only thing holding that line" is withdrawn, because no capability file holds a line any more. Home still owns the launch verb; what says so is Home's UI, not the host's ACL. [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) at "only the third is bounded by a capability file": nothing is bounded by one. [ADR-0183](0183-epicenter-mediates-the-effects-it-owns-and-names-the-rest-unmediated.md) at the target step that edits `trusted-app-windows-*.json`: the file no longer exists, and ADR-0185 had already withdrawn the step. [ADR-0190](0190-a-build-declares-which-epicenter-owns-its-data-not-which-window-it-runs-in.md) at "an application gets a native capability file only when it calls native commands" and its refusal of the trusted-app file "for symmetry": every window holds every verb, so neither sentence has a subject. [ADR-0246](0246-an-app-is-named-by-its-full-reverse-domain-id-everywhere-including-the-ones-epicenter-ships.md) at the consequence asking for a per-label granted-set test: the capability selects no label. [ADR-0387](0387-the-clipboard-is-a-platform-module-beside-the-app-not-a-capability-on-it.md) at "permissions the generic trusted app-window capabilities grant": the host constant grants them to every window.
- **Relates:** [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) (no grant, no scope, no capability manifest; this record applies that to the last place a grant existed), [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) (an app window runs as Epicenter; its third clause enumerated the command surface this record makes total), [ADR-0209](0209-epicenter-is-the-raw-view-beside-its-applications-not-a-shell-above-them.md) (windows are deliberate; this record keeps that for identity and drops it for authority), [ADR-0180](0180-epicenter-has-one-host-owned-active-local-transcription-model.md) (Home administers the model; still true as a fact about which UI calls the verb), [ADR-0388](0388-the-app-owns-what-a-library-scopes-and-the-package-s-modules-supply-what-the-device-supplies.md) (platform modules; a new one no longer needs a capability line)
- **Unbuilt:** All of it. `apps/epicenter/src-tauri/capabilities/` still holds fourteen files keyed by window label, eleven tests in `apps/epicenter/src-tauri/src/lib.rs` and one in `application-close.rs` read them, `apps/epicenter/src/mail-authorization.test.ts` reads the Mail pair, and two more `lib.rs` tests reason about labels against the `app-*` glob.

## Context

The desktop host grants native verbs per window label. Fourteen capability
files say that `home` may administer models and launch applications, that
`whispering` may simulate keystrokes and replace shortcuts, that `mail` may
open one Google URL, and that `app-*` and `whispering` may record, transcribe,
make HTTP requests, and read the clipboard. Twelve Rust tests and one
TypeScript test keep those files consistent with each other, with the
command list, and with the two Tauri configs that select them.

ADR-0334 settled that an app a person deployed runs as that person, with no
grant, no scope, and no capability manifest. ADR-0179 had already said the
capability file is not a sandbox. The files kept a second job, ownership
wiring: a reader could learn from `home-model-administration-*.json` that only
Home holds the administration verb, and the host would refuse a Whispering
window that tried.

That second job has a cost that grows with every window and every verb.
`honeycrisp` and `mail` are compiled windows whose labels match neither
`app-*` nor `whispering`, so nothing the trusted app-window file grants
reaches them (they sit only in the close-acknowledgement file): the
clipboard module already fails there, and flipping the default runtime to
desktop recording would make their App close fail on the `current_recording`
probe. Every platform module ADR-0388 adds needs a line in the shared file,
and a developer building on the package cannot add that line. The label
grammar carries two meanings, which window this is and what it may do, and
only the first one is consumed by anything.

## Decision

**A window label names what a window is. It never says what a window may do.
The host grants every native verb it has to every window, at full scope, and
that grant changes only when the host gains a plugin or a command.**

`apps/epicenter/src-tauri/capabilities/` holds two files, one per build, that
differ by the loopback port. Each names `"windows": ["*"]`, keeps
`"local": false` with the host's loopback origin as its only remote URL, and
lists every `allow-*` identifier Tauri's generated schema knows. The schema
scopes exactly two groups, `http:*` by URL and `opener:*` by URL or path, and
both carry the widest scope Tauri accepts. One Rust test replaces the twelve:
the permission list equals the schema's set of identifiers, the window list is
`["*"]`, and both Tauri configs select the file for their build. The
schema is generated, gitignored, and regenerated by every build, so adding a
plugin to `Cargo.toml` is what changes the list, and the test prints the new
lines.

The origin is the guard. A document that is not served from the host's
loopback origin holds nothing, and no Epicenter window loads a foreign origin,
because consent screens open in the OS browser (ADR-0189's Mail clause).

Labels keep their one remaining job. Home focuses the existing `honeycrisp`
window instead of opening a second, `cancel_recording_owned_by(label)`
cancels the capture a destroyed window owned, and `app-` still means the
window was opened for an installed folder.

## Consequences

- Twelve capability files, the twelve Rust tests that read them, the Mail
  TypeScript test, the `app-*`-glob label test, and the `APP_WINDOW_CAPABILITIES`
  and `PUBLIC_CLIENT_COMMANDS` helpers are deleted. Adding a platform module
  to `@epicenter/app` touches nothing under `apps/epicenter`.
- The one per-app scoping left is the CSP `connect-src` the Bun server
  stamps per application document (`APPLICATION_CONNECT_ORIGINS`). It is a
  network policy, not an authority grant, and this record leaves it alone.
- Whether `honeycrisp` and `mail` join any window list stops being a question,
  now and for every future window.
- ADR-0391's default runtime can flip to desktop recording: the
  `current_recording` probe at App close is permitted in every window.
- An installed app in an `app-*` window can set the active transcription
  model, delete a model file, launch another application, replace the global
  shortcuts, and simulate a keystroke. It could already read every document,
  hold the session, and make any HTTP request. ADR-0334 priced the second list
  and it is the larger one.
- "Only Home holds the administration verb" becomes a fact about which UI
  calls it, stated where Home's verb lives, not a refusal the host enforces.
- ADR-0179's third clause, which enumerated the command surface an app window
  reaches, reads as history: the surface is everything the host has.

## Considered alternatives

- **Add `honeycrisp` and `mail` to the shared file and keep per-window
  wiring.** Answers today's question and leaves the mechanism that produced
  it: every new window and every new verb asks it again, and a developer on
  the package still cannot answer it.
- **Grant every window exactly what `@epicenter/app`'s host leaves invoke,
  derived from the leaves by a test.** A truthful manifest, kept true by
  extracting `invoke` names and plugin commands from the package's host leaves
  and comparing them to the file. It keeps a promise nobody consumes, that
  the file says what a window can do, and pays for it with a derivation that
  reaches into each plugin's build output. Refused; the reasoning is kept
  because it is the shape to return to if a window ever has to hold less.
- **Reach native effects through the Bun host instead of Tauri plugins, so
  the ACL has nothing to grant.** Bun is a sidecar without a clipboard,
  notifications, or audio, so every effect would hop through Rust anyway, and
  ADR-0185 already refused the gateway shape for HTTP.
- **Withhold one verb from `app-*` windows.** No verb was named that an
  installed app must not call and that is not already implied by holding the
  session. If one appears, it is the single exception the test names, and the
  rest of this record stands.
