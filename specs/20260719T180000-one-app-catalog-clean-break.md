# One app catalog: strict selection and one document contract

- **Status:** In Progress
- **Date:** 2026-07-19 (narrowed 2026-07-22 after the data clean break)
- **Owner:** Epicenter desktop host
- **Decision owner:** [ADR-0153](../docs/adr/0153-trusted-apps-are-source-built-static-catalog-members.md)

## Product sentence

Every Epicenter application surface, bundled or installed, is one trusted
source-built static catalog member, served and opened through one document
contract and activated only by a full host restart.

This spec owns only the application catalog. The record, Lens, document, blob,
snapshot, Backup, Restore, and Proposal model lives in the separate
[Epicenter data clean break](20260720T002337-epicenter-data-clean-break.md).
Earlier versions of this spec also planned Workspace runtime changes. Those
sections are spent: `packages/workspace` and its public nouns are deleted, and
ADR-0160 through ADR-0178 now own the replacement.

## Accepted premises

- Catalog members are trusted source builds on the shared Epicenter origin.
  This is not an app sandbox or permission system.
- Publication produces an immutable generation and atomically selects it with
  one `current` pointer. A running process binds its selection once; activation
  requires restart.
- Missing selection means the shipped defaults. A present but corrupt
  selection is an error, not permission to silently boot a partial catalog.
- App documents are inert static files. Session enforcement belongs to APIs,
  not HTML substitution.
- Apps bring pure Lenses at runtime. Catalog metadata does not inventory
  namespaces, create data owners, or define data lifecycle.
- No compatibility loader, dual document contract, hot reload, automatic
  generation deletion, or installed Bun server module.

## Current state

The immutable publication seam has landed:

```txt
<catalog-root>/
  current
  generations/
    <generation>/
      <app-id>/index.html
```

`promoteAppCatalogCandidate` copies and validates a complete candidate before
renaming it into place, then atomically replaces `current`. A process loads
that pointer once, so later publication cannot partially alter its active
catalog.

Four gaps remain:

1. Loading is forgiving. Malformed or dangling selections become an empty
   catalog, and invalid generation members can be skipped.
2. Bundled Home and Whispering still use a separate serving path with session
   shell substitution, HTML bootstrap injection, and per-document CSP hashes.
3. Rust still carries a closed built-in surface family beside generic
   `app-<id>` windows.
4. Publication accepts only prebuilt output. There is no complete trusted
   source-build, confirmation, install, publish, and restart UX.

## Target

```txt
trusted source tree
  -> explicit trust confirmation
  -> frozen install and build
  -> validate complete candidate
  -> immutable generation + generated catalog.json
  -> atomic current pointer
  -> full restart
  -> one logical catalog
       shipped defaults shadowed by selected members
  -> /apps/<app-id>/
  -> app-<app-id> native window
```

`catalog.json` is generated output, never app-authored authority. It contains
only serving metadata such as version, app ID, title, root, and an optional
derived icon. Its app ID set must exactly equal the member directories in the
generation. It contains no Lens, namespace inventory, provider role, schema
fingerprint, permission claim, or executable host module.

Every member follows one document contract:

1. `index.html` and all assets are served unchanged below `/apps/<app-id>/`.
2. Executable code is in same-origin external files. The host does not rewrite
   HTML or maintain build-specific script hashes.
3. Tauri's init script establishes the browser session before app code calls a
   guarded API.
4. Non-secret boot state comes from one guarded same-origin endpoint, not an
   injected DOM payload.
5. The native label is `app-<app-id>` and every open, tray, shortcut, overlay,
   and deep-link path resolves through the same validated app ID.

## Execution waves

Each wave is a standalone checkpoint. Build the replacement, stop importing
the old family, prove the cutover, then delete it.

### Wave 0: durable catalog decisions

- Add an ADR that amends ADR-0153 with immutable generation storage, one
  `current` pointer, restart activation, retained old generations, and refusal
  of content addressing and hot reload.
- Record the three product decisions before code changes:
  - adopt the external-script document contract;
  - compose shipped defaults with selected members shadowing by ID;
  - refuse startup on a corrupt present selection and use the native startup
    error dialog for recovery.
- Delete this Wave 0 section after its ADR lands; do not edit accepted ADR-0153
  in place.

### Wave 1: strict loading and generated manifest

- Generate `catalog.json` inside staging before the generation rename.
- Make pointer absence the only non-error fallback.
- Refuse malformed pointers, dangling generations, invalid manifests, member
  set mismatches, missing indexes, and containment failures with a named
  catalog error.
- Add a structured pre-ready sidecar error frame and route its message into the
  existing native startup-failure dialog.
- Prove every corruption case, first-run fallback, and immutable
  running-process selection.
- Treat the on-disk format as a clean break: republish or remove `current`;
  never dual-read the old generation layout.

### Wave 2: universal static document contract

- Build Home as ordinary external Vite assets.
- Externalize Whispering's theme initializer and SvelteKit bootstrap for the
  Epicenter build.
- Replace injected bootstrap DOM reads with the guarded boot-state endpoint.
- Establish one static hash-free CSP.
- Through the generic resolver, prove Home boot and Whispering recording,
  transcription worker, SQLite worker, VAD WASM, and session establishment.

### Wave 3: one serving and native window family

- Compose shipped defaults and selected members once at startup.
- Serve every member through the generic contained resolver.
- Move all native opening, tray, shortcut, overlay, and deep-link behavior to
  validated `app-<id>` windows.
- Run the full Bun and Rust suites plus a packaged desktop smoke.
- After call-site and import audits show the old family is unreachable, delete
  the built-in surface loop, session shell, HTML injection, CSP hashing,
  static-asset loader, placeholder pages, reserved-ID path, closed Rust
  surface enum, enumerated labels, and built-in deep-link table.

### Wave 4: trusted source build and restart UX

- Add the explicit confirmation that names arbitrary build-code execution and
  selected-member shadowing.
- Run `bun install --frozen-lockfile`, the member build, candidate assembly,
  validation, and promotion as one user-visible workflow.
- Show restart pending when `current` differs from the generation bound by the
  running process. Never reload the catalog in place.
- Uninstall by publishing a generation without the member. Record data remains
  in the one Epicenter and becomes visible again when a compatible Lens returns.
- Prove the workflow against an isolated data directory and review the trust,
  failure, and restart copy.

## Deletion ledger

The final cutover removes these responsibilities, though a filename may remain
if another cohesive responsibility still earns it:

```txt
apps/epicenter/src/server.ts
  SESSION_SHELL, injectAuthBootstrap, built-in surface loop,
  Whispering special branch, per-document CSP hashing

apps/epicenter/src/static-assets.ts
  built-in static loader and load-time title parsing

apps/epicenter/src/routes.ts and surface-pages.ts
  closed built-in catalog and placeholder pages

apps/epicenter/src/main.ts
  legacy built-in loading and reserved-ID wiring

apps/epicenter/src-tauri/src/lib.rs and capabilities/
  closed surface enum, built-in open refusals, enumerated app labels,
  built-in deep-link table

apps/epicenter/vite.config.ts
  single-file Home build

apps/whispering
  inline desktop scripts and injected-bootstrap DOM reader
```

## Verification

Per-wave focused tests come first. Every landing also runs:

```sh
bun test apps/epicenter
bun run --filter '@epicenter/epicenter' typecheck
bun scripts/check-doc-paths.ts
bun scripts/check-doc-hygiene.ts
```

The final stale-family audit expects no production matches:

```sh
rg 'SESSION_SHELL|injectAuthBootstrap|surfacePages|loadStaticAssets' apps/epicenter/src
rg 'reservedIds|PLACEHOLDER_SURFACE_PAGES' apps/epicenter
rg 'epicenter-auth-bootstrap' apps
rg 'singlefile' apps/epicenter
```

The packaged desktop smoke is not replaceable by unit tests. It must exercise
Home, Whispering, one selected app, tray recording, overlay, deep links, and
restart activation through the final route and label family.

## Open decisions

1. Icon derivation: web manifest, link icon, or host default.
2. Restart notice placement: Home, tray, or both.

Neither decision changes the catalog's trust, selection, serving, or data
boundaries.

## References

- `apps/epicenter/src/app-catalog.ts`
- `apps/epicenter/src/static-assets.ts`
- `apps/epicenter/src/server.ts`
- `apps/epicenter/src/main.ts`
- `apps/epicenter/src/sidecar-runtime.ts`
- `apps/epicenter/src-tauri/src/lib.rs`
- `apps/epicenter/scripts/publish-app-catalog.ts`
- `docs/adr/0153-trusted-apps-are-source-built-static-catalog-members.md`
