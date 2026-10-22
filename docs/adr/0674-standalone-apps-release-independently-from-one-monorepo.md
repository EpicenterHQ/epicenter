# 0674. Standalone apps release independently from one monorepo

- **Status:** Accepted
- **Date:** 2026-10-22
- **Relates:** [ADR-0611](0611-epicenter-is-only-the-data-layer-its-apps-reach-over-git.md) (independent apps over shared data) and [ADR-0635](0635-generic-desktop-data-tools-are-deferred.md) (optional desktop clients).
- **Unbuilt:** per-product desktop release workflows and updater signing key provisioning, distribution signing and notarization, signed updater artifacts, updater integration, and hosting and promotion of the per-product update feeds; standalone Whispering also needs its own native shell.

## Context

The apps under `apps/` share workspace packages and a lockfile. A change to
the Folder API or file format can update its consumers in one commit.
Separate repositories would require publishing those packages and
coordinating their upgrades before the apps could build together again.

Source ownership does not determine release cadence. Epicenter bundles
Todos, Capture, Honeycrisp, Whispering, and Messages through
`apps/epicenter/scripts/build-bundled-apps.ts`. Todos also has a standalone
Tauri shell. Whispering's desktop page runs inside Epicenter; an independent
Whispering installer is not implemented. There are no desktop release
workflows or configured update feeds in this checkout on 2026-10-22.

ADR-0611 retired source installation inside Epicenter. Distributing
standalone installers does not restore that installer or require an app
registry. A person downloads a built application, while contributors and
agents can still clone and build the monorepo.

## Decision

**First-party apps stay in the monorepo, and each independently installed
desktop product owns its version, release, and update feed.**

A product is an application a person installs and updates as a unit:
Epicenter, standalone Todos, or standalone Whispering once its shell exists.
Its stable lowercase name, such as `epicenter`, `todos`, or `whispering`,
identifies its release workflow, tag prefix, and update feed. These names,
tags, feeds, and signing keys have separate roles:

| Concept | Example for standalone Todos | Role and lifetime |
| --- | --- | --- |
| Product name | `todos` | Identifies the installed product across releases |
| Release tag | `todos-v0.2.1` | Identifies the exact source commit for one product version; retained without moving |
| Update feed | `https://updates.epicenter.so/todos/stable.json` | Keeps the same address while its manifest advances to newer releases |
| Updater signing key pair | Todos's own private and public keys | Verifies update artifacts; reused across releases of that product |

Each product uses semantic versions and tags of the form
`<product>-v<version>`. The installed application's version matches the
version in its tag and update manifest. The following versions illustrate
independent releases, not release commitments:

| Product | Example tag | What its installer contains |
| --- | --- | --- |
| Epicenter | `epicenter-v0.3.0` | The desktop shell, its CLI sidecar, and its bundled app pages |
| Standalone Todos | `todos-v0.2.1` | Todos's native shell and page |
| Standalone Whispering | `whispering-v8.0.0` | Whispering's native shell and page, when implemented |

Each tag identifies a commit of the whole repository. The workflow checks
out that commit and builds the product with its workspace dependencies and
lockfile. Shared packages stay workspace dependencies; distributing these
apps requires no separate package publication.

Independent cadence means a product can release when it has a useful change.
It does not require a release for every commit, a fixed schedule, or a
version bump for every other product. Shared-code changes receive checks
for affected consumers, even when only one product is being released.

**Apps bundled with Epicenter update only through an Epicenter release.**

The Epicenter build consumes the canonical app source under `apps/`, with
the host configuration each page needs. Its release identifies the source
commit that supplies all bundled pages and the CLI sidecar. It neither
downloads standalone installers into its bundle nor checks those products'
feeds. A bundled app has no independently replaceable installation.

For example, publishing standalone Todos 0.2.1 leaves an installed Epicenter
0.3.0 unchanged. Shipping that Todos change inside Epicenter requires a new
Epicenter release. Both distributions can use the same app source and data
format without sharing a version number or release date. Sharing files
requires compatibility across released readers and writers; a shared source
repository alone does not establish that compatibility.

**GitHub Releases holds one release per product version, with all supported
platform downloads attached to that release.**

GitHub Actions performs the builds. A product's release workflow builds its
supported operating-system and architecture variants in parallel, within
runner and account limits. Supporting a platform remains a separately
verified product capability; a matrix entry alone does not establish it.
Assets have distinct names that identify the product, version, and target.
Multiple installers and updater bundles belong to one product release;
unrelated products have separate releases in the same repository.

Each product has its own tag-triggered workflow, following the
`release.<product>` naming convention, with shared build steps where useful.
An optional dispatch can start several product releases together. One
product's failed build does not prevent another product's successful
release.

For each product, build jobs upload their outputs as workflow artifacts.
One publishing job collects them, assembles the complete update manifest,
and uploads the downloads to a draft release for the exact tag. Only after
every required target passes validation does it publish that release and
promote its feed. Parallel jobs do not independently overwrite the manifest
or publish incomplete releases.

**`updates.epicenter.so` serves per-product update manifests; GitHub Releases
serves the versioned downloads.**

A release is a published version with its notes and downloads. An update is
the transition from an installed version to a newer release. The subdomain
uses `updates` because installed applications read it to discover that
transition. Human-facing download and release-note links point to each
product's GitHub release. A separate `releases.epicenter.so` site is not
required.

Each product's stable feed has a fixed HTTPS address:

```txt
https://updates.epicenter.so/epicenter/stable.json
https://updates.epicenter.so/todos/stable.json
https://updates.epicenter.so/whispering/stable.json
```

These addresses are the hosting contract to implement, not live endpoints.
Create a product's feed when its independently installable release exists.
Each feed serves a complete Tauri update manifest for that product, including
its version and the URL and signature of each supported target's updater
artifact. Download URLs name the exact GitHub release tag. Installers meet
their platform's distribution signing requirements; updater artifacts also
carry the signatures checked by the product's configured updater public key.

**Each independently installed product keeps its own updater signing key
pair across releases.**

The private key stays in the release system's secrets, and the public key
ships inside the installed product. Each release signs its updater artifacts
with that product's existing private key, so installed versions can verify
the next update with the public key they already contain. A version bump or
release tag does not generate a new key pair. Deliberate key rotation needs
a migration path for installed clients and is separate from routine releases.

Updater signing keys are distinct from platform distribution certificates
and optional Git tag signing. Apps bundled with Epicenter use Epicenter's
signed update as part of that installation; they do not use a standalone
product's updater key or feed.

The client reads only its own product's feed. Neither clients nor generated
artifact URLs use GitHub's repository-wide `releases/latest` address: that
release might belong to another product. The feed is a hosted JSON document
and needs no runtime release-selection API. Additional channels can receive
separate feeds when a product actually supports them.

Feed promotion replaces the complete document after the release's downloads
are available. Serialize promotion per product and channel and reject an
older version replacing a newer one, so an earlier build finishing late
cannot move the feed backward. A failed build or publication leaves the feed
unchanged. Published tags and their downloads are retained without replacing
their bytes. Recovery for already-updated clients uses a higher patch version;
pointing the feed at an older version is not an automatic downgrade mechanism.

**Hosted browser apps deploy independently of desktop releases.**

A browser app's URL serves its deployed web build; its deployment does not
replace an installed desktop app. The production workflow's existing
Landing and API deployments remain separate from these desktop release
workflows. This decision does not add hosted deployments for other apps,
source installation, an app catalog, or independently downloaded pages
inside Epicenter.

## Consequences

- A shared-code change can update its app consumers in one commit while
  product releases proceed on different dates.
- Each standalone product adds a release workflow, signing configuration,
  platform verification, and update feed. Shared build machinery reduces
  repetition but does not remove those distribution responsibilities.
- An Epicenter user receives bundled app changes through one application
  update. Someone using only a standalone product downloads only that
  product's update.
- Supporting both distributions adds packaging checks and compatibility
  work for versions that can open the same data. Independent cadence does
  not promise that an older reader understands every newer file format.
- GitHub hosts the large downloads. Epicenter operates the small feed host
  and its publication credentials without needing an app registry or a
  separate repository for each release stream.

## Considered alternatives

- **One repository per app.** Adds shared-package publication and upgrade
  coordination. Reconsider when separate ownership or access requirements
  justify that cost, rather than to obtain independent releases.
- **One ecosystem version and release containing every app's installer.**
  Couples unrelated product releases and their publication failures.
- **GitHub's repository-wide latest release as every updater endpoint.**
  Selects across products and can point a client at the wrong release.
- **Independent updates for pages inside Epicenter.** Requires a downloaded
  app lifecycle and compatibility with the host's native API, beyond the
  bundled-app distribution model.

## References

- [GitHub Actions matrix jobs](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations) documents parallel job variants and concurrency limits.
- [Tauri release action](https://github.com/tauri-apps/tauri-action) documents selecting a project with `projectPath`, targeting a release, and using an explicit tag in updater download URLs.
- [Tauri updater](https://v2.tauri.app/plugin/updater/) documents static manifests, target-specific URLs, and signatures.
- [GitHub release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release) defines the latest release at repository scope.
