# 0358. Installation admits a built application release

- **Status:** Proposed
- **Date:** 2026-09-08
- **Relates:** [ADR-0179](0179-an-installed-app-is-an-inert-built-folder-admitted-through-one-static-artifact-boundary.md) (installation reads an inert built folder), [ADR-0314](0314-an-app-is-one-directory-and-installation-is-a-rename.md) (one installed app directory), [ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md) (the deployment supplies the authority), [ADR-0334](0334-a-deployed-app-is-a-trusted-app-because-deploying-it-was-the-consent.md) (deployment is consent), and [ADR-0335](0335-a-person-is-an-origin-and-an-app-is-a-path-under-it.md) (hosted deployment paths)
- **Implementation status:** the local release format, desktop installation
  plane, CLI entrypoint, and end-to-end host path described below are landed;
  remote distribution and hosted deployment remain future work

## Context

Epicenter currently launches only the applications compiled into its own
release. `apps/epicenter/src/applications.ts` declares the closed
`COMPILED_APPLICATIONS` list, `apps/epicenter/src/static-assets.ts` loads each
application's built static directory, and `apps/epicenter/package.json` builds
those applications as part of the desktop release. There is no installed-app
discovery surface and no `epicenter install` command.

The future installation plane needs a vocabulary that a person and an agent can
read without confusing source code, executable bytes, and the data those bytes
open. A GitHub repository is source. A built SPA is executable release content.
An installed app is one release admitted into one Epicenter runtime. The
application's data survives replacement of the release.

The word `deploy` currently covers too many acts. An author builds and
publishes a release. A person installs a release. An operator deploys a release
to a hosted or self-hosted target. These acts have different owners and should
not share one command merely because they can occur in sequence.

## Decision

**Installation accepts a built application release, not an application source project.**

The source project belongs in a working directory the person controls. A person
may clone it, copy it, edit it, or give it to an agent. Its build tool,
dependency installation, and build scripts stay outside the Epicenter host. A
release is the smallest thing the host needs to validate and serve.

```txt
application       stable product identity and app ID
source            editable project directory or repository
release           immutable versioned bundle and provenance
installation      one release admitted into one local Epicenter
deployment        one release served by a hosted or self-hosted target
data              application state that survives release replacement
```

The V1 local release contains one manifest and one ready-to-serve file tree:

```txt
release/
  manifest.json
  index.html
  assets...
```

The installed application keeps the release beside the data it owns:

```txt
<platform data root>/so.epicenter/
  apps/
    <app-id>/
      bundle/            release files, including manifest.json
      local/            local-session-owned app state
        data/            local data generations
        blobs/           local app bytes
      accounts/         account-session-owned app state
        <authority-id>/
          <principal-id>/
            data/        account data generations
            blobs/       account app bytes
      sqlite/            app-owned device files
```

`bundle/` is replaceable release output. `local/` and `accounts/` hold
application data and blobs by session scope. `sqlite/` is application-owned
device state or a local projection. The exact version and generation path below
these directories remains governed by the separate storage decisions. Updating
or reinstalling a release does not remove any of those data directories.

The app directory is a shared ownership boundary, not a promise that one layer
owns every byte below it. Epicenter owns the installed `bundle/` and may replace
it during installation. The application owns `local/`, `accounts/`, and
`sqlite/`; the host provides the capabilities that open or serve those stores
but does not interpret their application contents. An installed application
never receives the platform data-root path.

There is no second registry file in the V1 installed layout. The manifest is
copied into `bundle/` with the release. A future installation record may add
provenance, but it must not become a second source of application identity.

If provenance is retained later, its fields are informational, not a trust
decision or an instruction to fetch or execute source:

```json
{
  "appId": "com.example.notes",
  "title": "Notes",
  "version": "1.2.0",
  "source": {
    "url": "https://github.com/example/notes",
    "revision": "abc123"
  },
  "artifact": {
    "sha256": "..."
  }
}
```

The authority is supplied by the deployment. The source project and release do
not name Epicenter Cloud or a self-hosted instance. A self-hosted deployment
uses its one `instance` principal; the installed release does not need a
self-host-specific source tree.

The human-facing command vocabulary is:

```txt
epicenter install <release>       admit or replace a release in this Epicenter
epicenter list                    show installed applications
epicenter remove <app>            remove the installed application

epicenter build <source>          author-side source-to-release step
epicenter publish <release>       author-side release distribution step
epicenter deploy <release>        operator-side hosted deployment step
```

Only `install` belongs to the first installation slice. Reinstalling the same
app ID replaces its bundle and preserves every entry outside `bundle/`.
`list` follows through Home's existing `/api/apps` surface; `remove` remains
deferred. `build`, `publish`, and
`deploy` name useful later lifecycle acts, but this record does not require an
Epicenter command for each one. A project can own its build, GitHub can host a
release, and an operator can use an existing deployment mechanism.

## Consequences

- A person can obtain source from GitHub or another host, make it their own in a
  working directory, and build it with the project's own tools. A raw source
  repository is not an installable release; it becomes one only after its
  ready-to-serve output is prepared.
- An author may use GitHub as a source host without Epicenter operating a
  public catalog. A later release registry can add discovery, artifact storage,
  publisher identity, signatures, and update channels without changing the
  installed directory.
- The host remains inert at installation. It validates the release and replaces
  only the host-owned bundle, leaving app-owned entries untouched. It does not
  install dependencies or execute source-project build scripts.
- The host's filesystem ownership stops at `bundle/`. Storage paths below the
  app directory are implementation details of the app's data and device
  capabilities, even when the host process opens the underlying files.
- V1 installation is a stopped-host administrative action. The operator stops
  Epicenter, installs or replaces the bundle, and then restarts it. Hot
  replacement coordination is a later decision.
- The app ID remains the stable application coordinate for the first installed
  release. A later record must decide whether one machine can hold the same
  application under multiple authorities and, if so, whether the path needs a
  distinct installation coordinate.
- The current compiled-application path remains a valid first-party release
  path. Installed-app discovery is an additional source of applications, not a
  reinterpretation of `COMPILED_APPLICATIONS`.
- Copying source does not create a new application automatically. Keeping the
  same app ID means the resulting release updates or replaces that application;
  choosing a new app ID makes a fork with a separate data namespace.
- Removing an installed app follows ADR-0314's one-directory model and can
  remove its data, SQLite files, and blobs. A `remove` surface must make that
  consequence explicit rather than presenting it as removal of the bundle only.

## Considered alternatives

- **Have `epicenter install` download a GitHub repository and build it.**
  Rejected. It makes installation execute author-controlled build code, hides
  the source-to-release boundary, and contradicts the inert built-folder model
  in ADR-0179. Source acquisition remains compatible with installation when the
  person prepares the release outside the host.
- **Call every lifecycle step `deploy`.** Rejected. A person installs, an
  author publishes, and an operator deploys. One verb hides who owns the act.
- **Create a public Epicenter catalog for V1.** Rejected. Public discovery,
  publisher identity, trust, moderation, and artifact distribution are a
  larger product than local installation. GitHub URLs and release URLs are
  sufficient inputs while that product remains undecided.
- **Add a second registry beside the bundle.** Rejected for V1. The release
  manifest already owns application identity, and duplicating it creates a
  consistency problem before a registry has a clear owner.
