# 0493. Whispering runs as one application in three deployment forms

- **Status:** Proposed
- **Date:** 2026-10-03
- **Amends:** [ADR-0118](0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md) at the Whispering packaging boundary: Epicenter is no longer its only desktop shell; Epicenter's own trusted Bun-hosted origin remains.
- **Unbuilt:** Whispering integration in Epicenter, shared Rust implementations of the remaining Whispering sidecar services, standalone bundled-asset loading without a sidecar, and release distribution of the desktop and browser builds.

## Context

ADR-0118 excludes a separately packaged Whispering desktop app. The current
`apps/whispering/src-tauri` already provides that shell, and Whispering's browser
workspace opens an IndexedDB folder. Epicenter still has a Whispering build
target, but it does not start the services or register the folder that the
current application needs.

Both desktop shells already depend on `tauri-plugin-epicenter-folder`. Its
`epicenter-folder-core` crate owns native folder operations without depending on
Tauri; the plugin exposes commands, events, and permissions. The remaining
Whispering desktop services live in `apps/whispering/native`, a Bun sidecar.
Sharing the folder plugin therefore does not yet make the whole application
usable in both shells.

The desired distribution is different shells around the same app. People can
install Whispering alone, open it inside Epicenter, or use it in a browser.
Choosing a distribution must not create a second implementation of Whispering's
recording, transcription, transformation, and editing workflows.

## Decision

**`apps/whispering` owns one application with three deployment forms.**
Its UI and workflows remain shared. The desktop forms supply native services;
the browser form supplies browser implementations or reports an unavailable
capability.

| Deployment | Distributed artifact | Execution host |
| --- | --- | --- |
| Standalone desktop | Whispering installer published through `braden-w/whispering` GitHub Releases | `apps/whispering/src-tauri`, loading bundled SPA assets |
| Epicenter desktop | Compiled Whispering SPA bundle admitted by Epicenter | `apps/epicenter/src-tauri`, with SPA assets served by Epicenter's Bun host |
| Standalone browser | Static SPA assets hosted on a website or downloaded and served locally | An ordinary browser |

A SPA bundle contains built HTML, JavaScript, CSS, and supporting assets.
Downloadable source requires a build before it becomes that artifact. A
downloaded browser bundle served on localhost is the browser deployment; loading
an admitted bundle inside Epicenter is the Epicenter deployment.

**Both desktop shells compile the same Rust implementations of the native services Whispering uses.**
The folder implementation stays in `tauri-plugin-epicenter-folder` and its
`epicenter-folder-core` crate. Remaining Whispering native services move out of
`apps/whispering/native` into reusable Rust modules or crates that both shells
can compile. A module compiled inside only one shell does not meet this rule.
Services with separate consumers or dependency requirements can have separate
crates; there is no mandatory crate containing every Epicenter native service.

The shells register matching focused Tauri commands. Shared typed TypeScript
bindings call them through Tauri `invoke`; capabilities authorize the app's
windows and served origins. Each shell chooses its roots and owns startup,
window lifetime, native permissions, and shutdown. The SPA cannot install a
Rust command by importing JavaScript.

```text
apps/whispering: shared UI and workflows
    |
    +-- standalone Tauri shell --+
    |                           +-- shared Rust implementations via invoke
    +-- Epicenter Tauri shell ---+
    |
    +-- ordinary browser ---------- browser implementations
```

Each desktop installation runs its own process and native service instances.
Sharing code does not share a live runtime, operating-system permission grant,
or data directory. One window opens a folder at a time
([ADR-0531](0531-the-page-runs-the-folder-engine-and-the-shell-grants-the-directory.md)), and two desktop processes cannot hold the same canonical
folder at once. Browser storage remains separate; deployment selection performs no data
migration or synchronization.

**An Epicenter-hosted Whispering bundle uses only native commands compiled into that Epicenter release.**
Acquisition checks the native protocol before admitting operations. Missing
commands, denied capabilities, or an incompatible protocol fail visibly and
never select IndexedDB inside a desktop shell. A SPA update that needs new
native commands requires a compatible Epicenter release.

## Consequences

Whispering can ship on its own without requiring Epicenter. Epicenter can host
the same application without embedding a separate Whispering executable.
Both installers include the shared Rust code, and each retains its own
packaging, signing, updater, and operating-system permission identity.

Browser users receive the shared workflows within browser limits. Current
browser storage is IndexedDB, and direct provider requests require an endpoint
that allows the page's origin through CORS. A local static server supplies
assets; it does not supply Rust commands or access to the desktop data folder.

The shared folder crate is already present. Completing desktop parity requires
the remaining native services, compatible bootstrap in both shells, and
verification of startup, active work, dirty-page close, quit, and reopen through
each desktop entrypoint. GitHub release publishing does not require a second
maintained copy of the application source.

## Considered alternatives

- Epicenter as the only desktop distribution: prevents installing Whispering
  independently.
- Separate Rust backends for each shell: fixes and command behavior diverge
  while both serve the same application.
- One shared cross-process native daemon: adds installation, discovery,
  authentication, and lifetime coordination without being needed for code reuse.
- Downloading native extensions with a SPA: JavaScript assets cannot register
  new commands in an already compiled Tauri executable.
