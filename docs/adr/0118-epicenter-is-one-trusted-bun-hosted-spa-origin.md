# 0118. Epicenter is one trusted Bun-hosted SPA origin

- **Status:** Accepted
- **Date:** 2026-07-10
- **Supersedes:** [ADR-0084](0084-super-chat-shell-is-a-bun-hosted-local-server-not-a-bundled-spa.md) by promoting its Bun-hosted shell into the application host and replacing its ephemeral production port and URL-carried token.
- **Amends:** [ADR-0080](0080-the-super-app-is-a-desktop-host-cross-device-is-remote-access-to-the-session-not-a-per-app-capability-plane.md) only at the application-packaging boundary: Whispering becomes a trusted surface and native subsystem inside Epicenter instead of remaining a separately shipped desktop runtime. The host-session remote-access decision is unchanged.
- **Amended by:** [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) at the app-admission and native-authority boundary: admitted app windows receive a generic unrestricted outbound HTTP surface, reversing the refusal of an HTTP proxy below. The one-trusted-origin decision itself is unchanged and is what makes a per-app permission system dishonest. Proposed amendment: [ADR-0449](0449-epicenter-connects-independent-applications-through-personal-data.md) revises mandatory shared desktop packaging.
- **Relates:** [ADR-0011](0011-rust-owns-the-macos-dictation-capability.md), [ADR-0096](0096-local-workspace-persistence-is-environment-injected.md), [ADR-0111](0111-super-chat-v1-exposes-built-in-epicenter-apps-and-defers-extension-surfaces.md), [ADR-0113](0113-super-chat-session-commands-are-host-owned-transports-only-frame-them.md), [ADR-0117](0117-global-shortcut-input-is-plugin-chords-only-and-the-macos-tap-is-just-the-paste-grant-watcher.md)

## Context

Super Chat already proves that a Bun loopback server can own one SPA, its APIs,
WebSockets, and its host session. Whispering separately proves that a Tauri
process can own recording, local transcription, global shortcuts, clipboard
delivery, and native audio artifacts while its WebView owns a Yjs workspace in
IndexedDB. Shipping those as separate desktop runtimes would duplicate bundle
identity, native lifecycle, permissions, updates, and window ownership just as
Epicenter begins to expose several built-in application surfaces.

The browser origin is also durable identity. An ephemeral production port would
change IndexedDB, cookies, cache, and Tauri remote authority across launches,
while a bundled fallback SPA would create a second hosting and recovery mode.

## Decision

Epicenter ships as one signed Tauri application with bundle identifier
`so.epicenter`. Rust boots and supervises one required, compiled Bun child;
Bun serves every release-bundled trusted SPA, API, and WebSocket from one
loopback origin. Production binds exactly `http://127.0.0.1:39130`, ignores port
overrides, and fails visibly on collision instead of falling back. Development
defaults to `http://127.0.0.1:39131` and may use `EPICENTER_DEV_PORT`; Rust
resolves that port once and passes it to Bun.

Every Epicenter SPA is fully trusted. Tauri grants the exact production Bun
origin remote access to focused, input-validating Rust commands. Full trust does
not authorize a generic native executor, process launcher, HTTP proxy, SQL
executor, or Bun-to-Rust command bridge. The per-launch loopback credential is
delivered to Bun over stdin and bootstrapped into trusted WebViews without a URL,
durable browser storage, or logs.

Rust owns application identity, Bun lifecycle, windows, deep links, recording,
native audio artifacts, local transcription, global shortcuts, Accessibility,
clipboard delivery, overlay, tray, autostart, and updates. Bun owns hosting and
Bun-native services, including Query's existing host session. A SPA may keep an
honest WebView-local durable store: Whispering retains the
`epicenter-whispering` Yjs workspace and IndexedDB persistence, while Rust keeps
its WAV artifacts. Bun does not mount a Whispering Yjs replica in the first
milestone.

Whispering remains one independently hostable SPA with build-time environment
selection. Its browser build uses browser implementations and can be deployed as
static assets on Cloudflare; its Epicenter build selects focused Tauri
implementations and is served under `/apps/whispering/`. Epicenter is the only
native desktop runtime. There is no separately packaged Whispering Tauri app and
no runtime branch that guesses which host it is running inside.

The first release is a clean break. It does not read or migrate the old
Whispering origin, app-data directory, settings, recipes, shortcuts, recordings,
or permissions. Epicenter has no Bun-independent mode and no bundled production
SPA. Closing every window leaves Rust, Bun, the tray, and global dictation
resident; an explicit Quit stops and reaps Bun before Rust exits.

## Consequences

- Query becomes one SPA and Bun-owned service inside Epicenter rather than the
  product identity of the host.
- Whispering keeps its existing data-owner split but receives a new origin,
  native app-data directory, bundle identity, and macOS permission identity.
- The Whispering SPA remains browser-deployable from the same source tree; only
  its standalone native desktop runtime is retired.
- All trusted SPAs share one browser security origin. Workspace ids and database
  names separate their data logically, not as a sandbox or security boundary.
- A production port collision or Bun boot failure prevents application windows
  from opening and requires a native Retry, Reveal Logs, or Quit surface.
- Changing the production scheme, host, or port becomes a persisted-data
  migration. Development storage remains intentionally separate from production
  storage.
- The shared application has a larger trust and failure blast radius. In return,
  it deletes separate desktop runtimes, duplicate native ownership, a second UI
  hosting mode, fallback-port behavior, and a misleading per-SPA permission
  model.

## Considered alternatives

- **Keep Super Chat and Whispering as separate desktop applications.** Rejected
  because it preserves duplicate application, permission, lifecycle, and updater
  owners where the product promises one host.
- **Keep an ephemeral production port.** Rejected because the port is part of
  browser storage identity and Tauri remote authority.
- **Bundle a fallback SPA.** Rejected because it creates a second origin and a
  partial no-Bun product mode.
- **Sandbox trusted SPAs separately.** Rejected because macOS grants native
  permission to Epicenter, all SPAs share one origin, and the product does not
  yet have an extension sandbox or permission broker.
- **Migrate old Whispering data.** Rejected because old-origin and old-app-data
  readers would create a second persistence path during the runtime transplant.
