# Epicenter

Read the [app README](README.md) for the existing desktop implementation. [Shared vocabulary](../../docs/CONTEXT.md) names the
chosen direction; the linked ADRs record its decisions. Local constraints below
protect the existing implementation while it remains in use.

## Shape

- Epicenter manages folders only; apps are separate programs (ADR-0701). It compiles Settings and the Folders window from its closed `BuiltInApp` table and opens no app, site, or app page. Do not add app hosting back piecemeal: restoring it is a decision that supersedes ADR-0701, which says how (the `archive/app-hosting` tag).
- Epicenter is an application beside the others, not a shell above them (ADR-0209). Applications keep their own windows and the OS is the launcher and switcher, so do not build an in-app application switcher, a command palette over rows, or anything that indexes rows into an OS search index. Closing Epicenter must leave every other window running. Epicenter opens to the Folders window over the folders the CLI syncs (ADR-0537); the host-owned replica ADR-0209's raw view read stays deleted (ADR-0226). Do not reimport `src/inspect.ts`. Settings is the window labelled `home`; Home Chat is deleted.
- The Folders window is a front end over the `epicenter` CLI, bound to no folder (ADR-0537, ADR-0647, ADR-0700). It lists what `epicenter status --json` reports, and each folder action is one CLI call in `src-tauri/src/synced_folders.rs` (`init`, `clone`, `sync`, `forget`, `share`, `unshare`); do not reimplement Git or sync in Rust or the page. The shell owns the one `epicenter sync --watch` run. A page names a folder only by a path the last listing held; commands refuse any other. An `epicenter://init` link only queues a request the person must accept. There is no pinned, recent, or library listing and no folder state in application data. Settings opens with `open_home`.
- Epicenter opens no folder's files: its two windows are bound to no directory, and the shell does not install the folder plugin.
- Epicenter's own pages are served by the one scheme handler, `src-tauri/src/scheme.rs`, from `dist/<page>/` at `/<page>/`. Adding a page is a `BuiltInApp` entry plus its build, never another resolver, route, or server. The handler holds the containment (no link, nothing outside the directory) and the Content-Security-Policy, which hashes each document's inline scripts; a legacy page served another way loses both.
- Keep document replicas owned by application windows, never by the host (ADR-0226, ADR-0227). Read [application composition](../README.md) and [folder contracts](../../packages/folder/README.md) before changing resource acquisition.
- Native capabilities grant commands by window label, one file per kind of window: `folders.json`, which alone grants the Folders window's CLI commands and no folder plugin command; and `home.json`, which alone grants sign-in and model administration. No page gets the folder plugin or the dialog plugin's file picker. Every capability file is `"local": true` because its page is on the scheme. Check the target window's grant when adding a native call; the rule is in the README. Proposed ADR-0402 would replace these files with one host-wide constant; that implementation has not landed.
- Native startup resolves `DesktopPaths` once, before any window opens. The scheme and every `epicenter` command the shell runs read that managed state; nothing resolves those paths again. The running bundle identifier scopes data and credentials; explicit directory overrides are resolved by native startup (ADR-0201, amended 2026-09-08).
- Standalone app defaults keep the shared native policy in [Application data](README.md#application-data). Do not add per-app home selection, first-use persistence, ownership registries, collision suffixes, or legacy-location lookup for those defaults. Only fixed defaults may be created; explicitly opened directories must already exist.
- **The host-owned data plane is deleted** (ADR-0226, ADR-0227). Gone with it: the desktop store owner, the `honeycrispMirrorLens` that re-declared another application.s workspace id, the `src/folder/` markdown renderer and its SQLite projection (ADR-0207, ADR-0208), `src/inspect.ts` and the `/api/home/inspect` routes, the `/api/data` proxy and its observation socket, and the durable Home conversation rows. Do not rebuild any of them here. A markdown mirror or a raw view belongs to whoever owns the authority those rows live in.
- Read the relevant application README before changing its file interpretation, save policy, or native ownership boundary.

## Refusals (do not reopen without a new ADR)

- No daemon `mount.ts` as the composition model; the mount path is CLI/projection for one app.
- No MCP for first-party in-process apps; MCP stays the boxed-app airlock (ADR-0073).
- No loose in-process TypeScript tool modules in v1; future scripting starts from an out-of-process runner unless a new ADR explicitly accepts unsafe developer-mode host imports.
- The `epicenter-app` scheme serves Epicenter's own pages only (ADR-0701).
- No source installer, app manifest, or app registry (ADR-0611, ADR-0701). A folder syncs to a hosted repository by `epicenter sync <dir> --to <namespace>/<name>` (ADR-0546).
- No per-capability permission menu or device prompt. A capability alone is not a sandbox (ADR-0179, ADR-0334).
- Settings (the `home` window) owns the one active local transcription model and its administration; no other window holds any of it (ADR-0180).
- No new Settings pane and no global rail. Settings is one page. A rail still needs a launchable list large enough to earn it (ADR-0189). Re-adding a Data pane means first deciding how a reader becomes a replica of somebody else's authority, which is an ADR, not a component.
- Do not turn an app-owned file bridge into a generic host command router, synced command table, or transport-adapter framework.
