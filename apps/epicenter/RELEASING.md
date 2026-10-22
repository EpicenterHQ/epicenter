# Epicenter desktop releases

Epicenter releases as one macOS application containing its CLI and bundled
app pages. Those pages can remain development builds while the distribution
path is exercised internally. No standalone product is released by these
workflows. A Git tag builds a draft; publishing the draft and advancing the
update feed is a separate operator action.

## Rehearse a packaged update locally

From the repository root:

```sh
bun run --cwd apps/epicenter release:rehearse "$PWD/.artifacts/epicenter-release-rehearsal"
```

This builds complete Epicenter 0.0.1 and 0.0.2 bundles from the checkout with
a temporary signing key. Tauri's real updater replaces the first bundle with
the second. The check compares the installed bundle to the built destination,
including its native executable, CLI, pages, and release receipt.

Add `--interactive` to launch the first packaged version and exercise **Check
for Updates...** in its app menu. Confirm Download, then use Epicenter's
application Quit confirmation to install and restart. Cancel leaves the
installed version unchanged. Quit the rehearsal app before pressing Return
in the terminal so the run can stop its local feed and remove temporary data.

The rehearsal uses a distinct application identifier and deep-link scheme,
temporary data and folder roots, and a loopback-only feed. It skips refreshing
the person's CLI command link. macOS paths are canonicalized before launch
because Tauri refuses executable paths containing symlinks. The retained
output is an ad-hoc-signed local build, not a notarized download for other Macs.
It does not change the installed production app or publish anything.

## Configure distribution signing once

The signing key pair belongs to the Epicenter desktop product and persists
across releases. Provision its private key outside the repository, back it up,
and configure the GitHub repository with these values:

| Value | Location | Purpose |
| --- | --- | --- |
| `EPICENTER_UPDATER_PRIVATE_KEY` | Actions secret | Private updater key, separate from the legacy generic Tauri key |
| `EPICENTER_UPDATER_PRIVATE_KEY_PASSWORD` | Actions secret, if the key has a password | Decrypt the private key for signing |
| `EPICENTER_UPDATER_PUBLIC_KEY` | Actions variable | Public key embedded in every distributed Epicenter app |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Actions secrets | Import and select the distribution certificate |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Actions secrets | Apple notarization credentials |
| `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | Actions secrets | Deploy the static update feed |

Generate a key with the installed Tauri CLI's `signer generate` command, with
the output outside this checkout. Keep the same pair for future builds.
The private key and any password stay in secrets; the public key is not secret.
Configure the `epicenter-release` environment with required reviewers if the
repository needs review before the manual publication job can run.

Ordinary local builds have no public key configured and offer no signed
updates. The release builder requires the updater key and real Apple
credentials, embeds the public key and HTTPS endpoint, and verifies code
signing and notarization before collecting artifacts. It rejects an ad-hoc
identity for a distribution build. No release workflow generates or rotates
the persistent updater key.

## Build a draft

Set the version in Epicenter's package and Tauri configuration to the intended
semantic version, merge the checked source, and tag that commit with
`epicenter-vVERSION`, for example `epicenter-v0.0.1`. The release builder
requires the tag, app version, and package version to agree, and refuses
tracked source changes. The root monorepo version does not select Epicenter's
release version.

The **Build Epicenter release draft** workflow runs on that tag or a manual
dispatch naming an existing tag. Native Apple Silicon and Intel runners each
build their own CLI sidecar and full application, sign and notarize them, and
upload their outputs. One final job verifies both architectures, their version,
source commit, signatures, and required artifacts before creating the draft.
Retries can replace draft assets; a published release is not overwritten.

Each draft contains a DMG, signed updater archive, and signature for each
architecture, plus the assembled `stable.json`. URLs in that manifest name
the exact release tag. The build publishes no feed and sends no update to
existing installations. Review the bundled apps' readiness before publication.

## Publish and promote the feed

Run **Publish Epicenter release and update feed** with the completed draft's
tag. For the first deployment only, select `first_release` to allow bootstrapping
an unavailable feed host. An existing readable feed still requires a newer
version, even during bootstrap.

The job validates the selected manifest against the release assets and
signatures, compares it with the live feed, makes the draft public, checks
that its downloads are reachable, then deploys the complete JSON as static
assets at `https://updates.epicenter.so/epicenter/stable.json`. The static host
has no release-selection API. Its custom domain is provisioned by this
deployment, not by the ordinary Landing/API deployment workflow.

Draft builds and publication share Epicenter's release queue, so a draft retry
cannot change assets during publication. An older build cannot
replace a newer feed. If publication succeeds but feed deployment fails,
rerunning the same job can finish promotion without rebuilding or replacing
the release. An already-identical feed is a successful no-op. GitHub's
repository-wide latest release is left unchanged for legacy consumers.

The shared concurrency group uses [`queue: max`](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#concurrency)
to retain pending runs. Feed version checks enforce forward progress regardless
of the order queued runs start.

Epicenter verifies the artifact's signature and its signed version before
offering installation through the existing application Quit confirmation.
After confirmation, it installs the bundle and requests a restart through
Tauri's exit lifecycle, which finalizes native recording. It adds no updater
permission to a product page. A failed install leaves the app running and
shows an error. A publication failure leaves the previous feed available.

To recover an already-distributed version, publish a higher patch version with
the fix. Moving the feed to an older version does not downgrade installed apps.
Keep published tags and downloads intact.
