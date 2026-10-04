# Backlog

## Remove Local Mail's headless continuous watcher

- Desired result: Remove `local-mail sync --watch` so the open desktop app is
  the only continuous synchronization owner while one-shot `sync` remains
  available for explicit freshness.
- Grounding:
  [ADR-0116](docs/adr/0116-local-mail-is-desktop-first-one-bun-engine-no-background-mail-service.md)
  says Local Mail does not update automatically while the app is closed.
- Revisit when: Local Mail next changes its CLI or synchronization lifecycle.

## Make Sign in with Apple a supported product path

- Desired result: Expose and support Sign in with Apple wherever Epicenter
  presents its supported account sign-in and linking providers.
- Grounding: The server already contains optional Apple provider configuration,
  but the current product UI has no corresponding entry point.
- Revisit when: Epicenter next changes authentication providers or account
  linking.

## Add human-reviewed LLM cleanup to Local Mail

- Desired result: Let an LLM propose precise groups of low-value Gmail messages,
  require review of the exact messages, and move only the approved batch to
  recoverable Gmail Trash.
- Grounding: Local Mail already treats Gmail as the source of truth and requires
  human-meaningful state to round-trip through Gmail.
- Revisit when: Local Mail next expands its triage or agent-assisted workflows.

## Add Outlook as a standalone Local Mail provider

- Desired result: Support one Outlook account and an Outlook-only inbox through
  Microsoft Graph before introducing a combined Gmail and Outlook inbox.
- Grounding: Keep provider identity explicit and provider storage and actions
  separate so a combined inbox remains possible without forcing either provider
  into the other's model.
- Revisit when: Local Mail next expands beyond Gmail.

## Publish the installed-app SDK

- Desired result: Publish `@epicenter/lens` together with its public dependent
  package closure when Epicenter is ready to support third-party app developers.
- Grounding:
  [ADR-0186](docs/adr/0186-an-app-reaches-epicenter-through-one-bundled-mit-client-it-installs-itself.md)
  defines the eventual public package boundary; until launch, the packages stay
  publish-ready but are not released to npm.
- Revisit when: Third-party apps can be built and installed from repositories
  outside the Epicenter monorepo.

## Add TikTok Direct Post

- Desired result: Let a signed-in Epicenter user connect TikTok creator
  accounts as publishing destinations and make one explicit post consent create
  at most one TikTok post.
- Grounding: The unmerged implementation and its review corrections are
  preserved at
  [commit 51335f22ec](https://github.com/EpicenterHQ/epicenter/commit/51335f22ec188c8fb1d4903d3d40ef2cd936cf0f)
  on `codex/tiktok-direct-post`; treat it as implementation evidence to port
  onto future `main`, not as current product behavior.
- Revisit when: TikTok publishing becomes a product priority and Epicenter is
  ready to support TikTok's API access and compliance obligations.

## Complete Whispering's local transcription handoff

- Desired result: When local transcription is unavailable, explain the
  on-device path, open Epicenter Home to choose or download a model, offer cloud
  transcription as the secondary path, and show the normal recorder once ready.
- Grounding: Epicenter Home already owns local model administration under
  [ADR-0180](docs/adr/0180-epicenter-has-one-host-owned-active-local-transcription-model.md);
  Whispering already receives derived readiness and a focused Home navigation
  action under
  [ADR-0181](docs/adr/0181-every-app-receives-one-portable-epicenter-capability-handle.md).
- Revisit when: Whispering's first-run or unavailable-transcription surface is
  next changed.

## Ship a trusted Epicenter macOS application

- Desired result: Publish an Epicenter DMG whose application and bundled Bun
  sidecar are Developer ID signed, notarized, stapled, and accepted by
  Gatekeeper.
- Grounding:
  [ADR-0118](docs/adr/0118-epicenter-is-one-trusted-bun-hosted-spa-origin.md)
  says Epicenter ships as one signed Tauri application, while the current Tauri
  configuration uses an ad-hoc signing identity.
- Revisit when: Before the first macOS build is distributed outside the
  development team.
