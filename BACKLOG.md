# Backlog

## Establish hosted erasure before external onboarding

- Desired result: Attribute every hosted allocation to its account and locally
  verify an operator-run procedure that retires access and removes owned data.
- Grounding: Account deletion currently refuses before destructive work. Empty
  API namespaces were observed on 2026-09-08, but complete allocation ownership
  and an operator deletion procedure remain unbuilt. See
  [ADR-0360](docs/adr/0360-defer-automated-hosted-account-deletion.md).
- Revisit when: Preparing to onboard external users. Automated retries and a
  self-service endpoint stay deferred until the product needs them or operator
  deletion becomes recurring work. Self-hosted reset is outside this scope.

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
  says Epicenter ships as one signed Tauri application, while
  `apps/epicenter/src-tauri/tauri.conf.json` still sets `"signingIdentity": "-"`.
- Revisit when: Before the first macOS build is distributed outside the
  development team.

## Re-earn a headless Epicenter runner

- Desired result: If a person needs Epicenter data to stay live on a machine
  with no open window (a homelab box, a build agent, an always-on anchor),
  offer one runner that opens a replica, joins sync, and stays alive, without
  reintroducing a mount, a lease, or a folder-shaped root.
- Grounding: `@epicenter/cli` did this as `epicenter up`, with `down`,
  `status`, and `logs` managing the process through pid metadata and OS
  signals, plus a resident folder watcher that kept a project directory and the
  replica in step. It was deleted in
  [commit 946064c1](https://github.com/EpicenterHQ/epicenter/commit/946064c128)
  because every verb read `@epicenter/workspace`, whose mount and daemon model
  ADR-0166 replaced. Treat that implementation as evidence of the process
  lifecycle problems already solved (lease claiming, pid liveness, log
  rotation, signal handling, debounced filesystem events), not as code to
  restore.
- Revisit when: A real always-on deployment needs data resident without a
  window, or the anchor role in ADR-0068 gets built.

## Re-earn a machine session and a file-for-URL command

- Desired result: Let a headless or scripted context authenticate to Epicenter
  and exchange a large local file for a durable URL, without shipping a whole
  CLI to do it.
- Grounding: `epicenter auth` held a machine session and `epicenter blobs`
  traded a file for an opaque-id S3 URL. The commands went with the CLI in
  [commit 946064c1](https://github.com/EpicenterHQ/epicenter/commit/946064c128);
  the auth machinery under them followed, because nothing but a terminal ever
  called it. What that machinery provided, as history rather than a
  compatibility commitment:
  - Terminal OAuth login. `loginWithOob` ran one out-of-band authorization-code
    + PKCE exchange against the same `/auth/oauth2/token` endpoint the browser
    uses. A dedicated `epicenter-cli` public client redirected to an
    Epicenter-owned `/cli-callback` page that rendered a one-time code for the
    user to paste back into the terminal.
  - Persisted machine sessions. One `PersistedAuth` cell per API target at
    `<dataDir>/auth/<host>.json`, mode `0o600`, refusing to load a file whose
    permissions were wider. `createMachineAuthClient` booted a daemon from that
    cell with a launcher that errored rather than prompting, and `status`
    reported `'unverified'` offline so a cached identity still printed.
  - A headless credential fork. `resolveMachineAuthClient` chose between a
    static self-host bearer (`EPICENTER_TOKEN`, or `EPICENTER_TOKEN_FILE` to
    keep the secret out of the process environment) and the persisted OAuth
    cell, so one entry point served both deployment kinds.
  The blob half is also superseded in shape:
  [ADR-0173](docs/adr/0173-each-row-owns-at-most-one-write-once-immutable-blob.md)
  makes a blob a row-owned write-once slot addressed by row, not an opaque id,
  so any replacement addresses a row rather than minting a BlobId.
  Authentication is now owned entirely by the apps, and there is no headless
  login workflow. Any future headless tool should be designed around a concrete
  workflow and re-derive its credential story from that, treating the above as
  inspiration rather than a target to restore.
- Revisit when: A scripted or agent workflow needs to authenticate or publish
  bytes from outside an app window.

## Re-earn typed markdown pages with user-defined types

- Desired result: A knowledge base whose pages carry a worldview-neutral core
  plus user-defined, schema-bearing types, so a page can be both prose and a
  typed record.
- Grounding: `apps/wiki` proved this as a headless vertical slice: an ECS-style
  page and tag model, a lens that classified stored rows as match, missing, or
  excess against a declared schema, a markdown codec, and a hand-written SQLite
  projection. It never had a UI and never ran as an application, and was deleted
  in
  [commit b32125ed](https://github.com/EpicenterHQ/epicenter/commit/b32125ed0a).
  The lens classification idea is the durable part and already informs Matter's
  handling of absent versus null frontmatter. The settled rejection is worth
  keeping too: a tag is not a page.
- Revisit when: Matter or another surface needs user-defined types over
  markdown, rather than one fixed frontmatter schema.

## Re-earn a file-and-folder view over Epicenter data

- Desired result: Let an application present collaborative data as familiar
  files and directories, with `mkdir`, `writeFile`, `mv`, `rm`, and `stat`,
  instead of raw rows.
- Grounding: `@epicenter/filesystem` did this over root-Yjs workspace data:
  file metadata in a table, each file's body in its own document, plus a path
  index and a name-collision policy. It reached zero callers and was deleted in
  [commit 97cf845f](https://github.com/EpicenterHQ/epicenter/commit/97cf845f20).
  The path index and naming rules are the non-obvious parts worth re-reading;
  the Yjs coupling is not.
- Revisit when: An application genuinely needs a hierarchical file abstraction
  that the row and document model cannot express directly.

## Revoke the `epicenter-cli` OAuth client row in each deployed database

- Desired result: No deployment still advertises a registered OAuth client for
  the deleted CLI.
- Grounding: The [removed OAuth seed](https://github.com/EpicenterHQ/epicenter/blob/f59fc1e19f/apps/api/scripts/seed-oauth-clients.ts) only upserts the clients
  it knows about; it never deletes. The `epicenter-cli` row seeded before that
  client was removed from `buildTrustedOAuthClients` therefore survives in every
  database that was seeded, still carrying its `/cli-callback` redirect URI. It
  no longer skips consent (it left `trustedOAuthClientIds`) and its redirect
  target now 404s, but it remains valid client metadata at `/authorize` and
  `/token`. The fix is one `DELETE FROM oauth_client WHERE client_id =
  'epicenter-cli'` per deployed database, or setting `disabled = true` to keep
  the row for audit. Deliberately not executed here: this is a production
  database mutation, not a code change.
  The direct-session implementation removes these registration surfaces for
  fresh deployments; it has not changed any deployed database.
- Revisit when: The next production deploy of `apps/api`, or sooner if an audit
  of registered OAuth clients is run.

## Deprecate the npm packages this repository no longer builds

- Desired result: Someone who installs `@epicenter/workspace`,
  `@epicenter/filesystem`, or `@epicenter/cli` learns the direction changed,
  without breaking any existing install.
- Grounding: All three remain published (`0.3.0`, `0.3.0`, and `0.1.0`) and
  keep resolving, but their source left the tree in commits `97cf845f`,
  `946064c1`, and `b9327963`. `npm deprecate <pkg>@"<=0.3.0" "<message>"` is
  reversible with an empty string and never blocks publishing a later version
  under the same name. Do not unpublish: that permanently burns the version
  number.
- Revisit when: Before the next npm release from this repository.
