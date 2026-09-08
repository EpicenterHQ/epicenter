# Local release installation

**Date**: 2026-09-08
**Status**: In Progress
**Owner**: Epicenter desktop
**Supersedes**: None

## One Sentence

Admit a local ready-to-serve app folder into Epicenter's trusted runtime while
keeping the installed bundle separate from the app's data.

## Current State

Epicenter serves only applications compiled into its own desktop release.

```txt
apps/epicenter/src/applications.ts
  COMPILED_APPLICATIONS

apps/epicenter/src/static-assets.ts
  loadStaticAssets(appsDist, COMPILED_APPLICATIONS)

apps/epicenter/src/server.ts
  /apps/<id>/...
  /api/apps
```

`apps/epicenter/src/main.ts` resolves one platform data root, creates a global
blob store below `dataRoot/blobs`, creates the current device owner at
`dataRoot`, and loads the release's compiled app directories. There is no
installed-app directory scan, local release installer, or `epicenter install`
command.

The repository already contains the durable direction:

- [ADR-0179](../docs/adr/0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md)
  refuses build execution during admission.
- [ADR-0314](../docs/adr/0314-an-app-is-one-directory-and-installation-is-a-rename.md)
  gives each app one platform-managed directory.
- [ADR-0324](../docs/adr/0324-a-database-address-is-its-data-id-and-generation-and-the-definition-declares-its-authority.md)
  puts the app identity into the data address.
- [ADR-0358](../docs/adr/0358-installation-admits-a-built-application-release.md)
  records the proposed release and command vocabulary.

## Target Shape

The first supported input is a local release folder that is already ready to
serve. Its contract is deliberately small:

```txt
release/
  manifest.json             { id, title, version }
  index.html
  assets...
```

```sh
epicenter install ./dist
```

The installer does not clone a repository, install dependencies, or execute
the source project's scripts. A person or agent prepares the folder outside
Epicenter:

```txt
source project
  -> human or agent edits
  -> project-owned build
  -> ready-to-serve folder
  -> epicenter install ./dist
```

The platform-managed layout is:

```txt
<platform data root>/so.epicenter/
  apps/
    <app-id>/
      bundle/       installed release files, including manifest.json
      local/        local-session-owned application state
        data/       local data generations
        blobs/      local app bytes
      accounts/     account-session-owned application state
        <authority-id>/
          <principal-id>/
            data/   account data generations
            blobs/  account app bytes
      sqlite/       app-owned device files
```

This tree is schematic. ADR-0348 owns the versioned local and
authority-plus-principal SQLite paths, and ADR-0349 owns the matching blob
paths. The installation decision owns the app directory boundary and bundle
replacement rule; it does not replace those storage decisions.

The manifest is copied into `bundle/` with the release. There is no second
registry file in this slice. A directory below `apps/` is an installed app only
when it contains a host-owned `bundle/`; compiled apps may otherwise already
own data below that directory without being installed releases.

The host discovers installed apps at startup, combines them with the release's
compiled applications, and serves both through the existing `/apps/<id>/`
route shape. A local installation replaces or adds one app and does not alter
any other app.

## Installation Contract

The installer must:

1. Read a local ready-to-serve folder.
2. Reject missing or invalid app identity.
3. Reject a missing root entrypoint.
4. Reject path traversal and symlink escape from the source folder.
5. Copy the release into a temporary bundle under the platform root.
6. Replace only the host-owned `bundle/`; leave every other app-owned entry
   untouched.
7. Restore the previous bundle if activation fails.
8. Leave the existing installation unchanged if validation or copying fails.

The installed bundle is trusted application code. Installation is the consent
to run it, consistent with ADR-0334. This is not a sandbox or per-app
permission boundary. Installation is a stopped-host administrative operation in
this slice: stop Epicenter, install or replace the bundle, then restart it.
Hot replacement while the resolver is serving the previous bundle is deferred.

The installer must not:

- read a source repository to discover how to build it;
- install package dependencies;
- execute `build`, `postinstall`, or arbitrary project scripts;
- fetch a GitHub repository as part of local installation;
- infer greater or lesser authority from the source URL.

## Implementation Plan

### Wave 1: release validation

- [x] Extract the existing contained-static-file checks from
  `apps/epicenter/src/static-assets.ts` into a reusable validation boundary, or
  compose the same checks without duplicating traversal rules.
- [x] Define the minimum ready-to-serve input: `manifest.json` plus a root
  `index.html` with its contained assets.
- [x] Test missing entrypoints, traversal, symlink escape, and malformed identity.

### Wave 2: app-directory installation

- [x] Add a pure installer boundary that takes a source folder and platform root.
- [x] Copy into a temporary sibling directory.
- [x] Preserve every existing app entry outside `bundle/` when replacing it.
- [x] Replace the completed bundle and restore the previous bundle on failure.
- [x] Test replacement and data preservation.

### Wave 3: installed-app discovery

- [x] Replace the closed application asset input with a composition of compiled and
  installed application assets.
- [x] Keep reserved built-in IDs protected.
- [x] Keep `/api/apps` and `/apps/<id>/` behavior consistent for both sources.
- [x] Preserve the current CSP, session gate, and contained resolver behavior.

### Wave 4: app-owned storage paths

Deferred from this slice. The installer preserves existing app-owned entries
without relocating or opening them. The next storage-specific change must run
in this order:

1. Define the scoped capability handoff that gives a host route or native
   recorder both the app ID and captured principal. A shared-origin route that
   receives only a blob ID cannot safely select the ADR-0349 directory.
2. Align desktop SQLite opening with ADR-0348's
   local/data/<data-id>/<generation>.sqlite and
   accounts/<authority-id>/<principal-id>/data/<data-id>/<generation>.sqlite
   paths.
3. Align desktop blobs with ADR-0349's
   local/blobs/<blob-id>/ and
   accounts/<authority-id>/<principal-id>/blobs/<blob-id>/ paths.
4. Add restart, account-replacement, erase, and reinstall proofs before
   removing the current shared blob root.

The installer remains storage-agnostic throughout this work. It preserves
entries outside bundle/ and never migrates or interprets them.

### Wave 5: CLI entrypoint

- [x] Add the smallest user-facing entrypoint for `epicenter install <folder>`.
- Keep URL fetching, source cloning, source builds, public registries, and
  hosted deployment out of this slice.
- [x] Make the command report the installed app ID and path after success.

## Verification

The slice is complete when:

- [x] a local built folder installs into one app directory;
- [x] an invalid folder does not change an existing installation;
- [x] a second install replaces the bundle without deleting app data;
- [x] the host discovers and lists the installed app after restart;
- [x] the installed app serves through `/apps/<id>/` with the existing session and
  CSP behavior;
- [x] the real install CLI and spawned Bun sidecar prove that install, discovery,
  authentication, listing, and serving compose in one end-to-end test;
- [x] compiled first-party apps continue to launch unchanged;
- [x] no installer path executes a project build script or dependency installer;
- [x] tests cover traversal, symlink escape, replacement, discovery, and
  data preservation.

## Deferred Questions

- Whether the CLI should reject installation while the desktop host is running
  by coordinating a host lock.

- Whether a release URL or GitHub release asset becomes an input after the
  local folder path works.
- Whether Epicenter ever owns a source-to-release build command.
- Whether a public release registry needs object storage and metadata tables.
- Whether `update` and `remove` become CLI commands, and what `remove` does to
  app data.
- Whether one application may be installed against multiple authorities on one
  machine.
