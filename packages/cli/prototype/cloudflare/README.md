# Hosted Tasks with Epicenter sign-in: experiment

This experiment gives each signed-in person a private hosted Tasks app. They can
edit its Svelte UI and TypeScript actions, publish a working build, and approve
an agent to do selected work. Cloudflare runs the app without a container or a
computer the person maintains.

The account integration is implemented and tested locally. The existing public
scratch deployment still runs the earlier shared-key proof. Do not describe that
deployment as the account-backed service. The production API configuration points
to a retired database, and the user has confirmed that the old PlanetScale
connections are retired too. Live sign-in requires a current account database and
an explicit upgrade of the older deployed API; neither has been changed here.

## One home, two kinds of code

```text
Trusted Epicenter home dashboard             Agent with approved OAuth token
  sign-in / editor / activity / grants                    |
                 |                                       |
                 +------------ API /homes ---------------+
                               token audience + scope
                                         |
                              private service binding
                                         |
                              home for this principal
                              Durable Object + SQLite
                              source / data / builds / runs
                                         |
                              isolated compiler and
                              action Dynamic Workers

Editable Svelte UI, sandboxed inside dashboard
  only receives a channel for this app's action calls
  receives no account or agent credential
```

Sign-in identifies the person. The API derives the home from the configured
identity authority and that person's account id. A query, path, or identity header
cannot choose another person's home. Two people use the same platform deployment
and have separate objects, source, records, and run histories. They need an
Epicenter account, not a Cloudflare account.

The dashboard is fixed platform code. It captures an `Account` from the existing
`@epicenter/account` browser OAuth client and uses `Account.fetch`. The API checks
opaque tokens against Postgres on each request. It accepts neither a Better Auth
session cookie nor the earlier prototype key as a home-resource credential.
The app's source cannot modify the dashboard or the API's authorization policy.

The editable app runs in an opaque-origin sandboxed frame without same-origin
permission. Its CSS, fonts, and JavaScript come from the selected published build.
A MessageChannel streams run requests and responses through the captured Account.
The parent admits only versioned action routes for that frame. The frame cannot
read the dashboard's DOM or storage, edit source, build, or create agent grants.
The frame's CSP restricts HTTP requests. This does not promise a separate browser
renderer process or block every browser network API. Separate content origins remain a requirement to assess before a
public arbitrary-code offering. The copied Tasks app uses system theme
without a persistent browser theme setting because this sandbox has no localStorage.

Each Dynamic Worker execution cache key includes the home object id as well as
the published revision. Sharing a starter revision therefore does not share
mutable JavaScript module state between people. Action Workers receive only
run-fenced file and progress capabilities, with network egress disabled.

## Agent access reuses OAuth

The new `so.epicenter.home.agent` client uses Epicenter's existing device approval
flow. It has no refresh grant and cannot request `offline_access`. Each approval
produces an access token that expires after eight hours. The dashboard shows the
credential once and can revoke that token without signing the person out.

| Scope | Operations |
| --- | --- |
| `home:read` | Read source, build status, published preview, records, run status, and event replay |
| `home:source` | Save source drafts |
| `home:build` | Provision the person's home; compile and publish a valid build |
| `home:run` | Start actions with their initial result stream, and cancel runs |
| `home:manage` | List and revoke agent credentials; dashboard only |

These scopes cover this home, which currently contains only Tasks. They do not
restrict individual action names or individual records. Publishing edited code
lets an agent change what the app does when someone next uses it. Approve source
editing without publishing when you want to review the draft yourself.

Grant listing returns metadata without token values or hashes. Agent access survives browser sign-out until expiry or revocation. Revocation
deletes only the requesting person's token for this agent client. It blocks the next
request; an already admitted action may still finish. Existing browser, native,
and CLI registrations receive no new resources or scopes. The self-hosted Bun API
does not register hosted clients or expose the home gateway.

An agent sends its token to `https://api.epicenter.so/homes`, for example:

```http
GET /homes/admin/source?path=epicenter.ts
Authorization: Bearer <approved agent access token>
```

To save a draft, send `POST /homes/admin/source` with
`{"files":{"epicenter.ts":"..."}}`. Build with `POST /homes/admin/build` and a JSON
body of `{}`. Run an action with `POST /homes/.runs/tasks/<action>/<new-run-id>` and
its JSON input. With `home:read`, observe with `GET .../<run-id>/events`; cancel with
`POST .../<run-id>/cancel`. Reuse a run id to observe or join that admission rather
than repeat its effects. These are HTTP operations, not a shell or SSH session.

## What SQLite owns

The home stores source files as path/text rows and data files as
path/text/version rows. Tasks records remain Markdown with front matter. These
are virtual files, not a mounted Linux filesystem. File versions survive deletion
so an old guarded edit cannot succeed after a path is recreated.

The starter object contains raw source, uploaded dependencies, a precompiled
Tasks bundle, and assets. Provisioning copies those into a new home in bounded
pages, excluding all task data and run history. It checks the starter version between pages and activates
the home only after the complete copy succeeds. It does not compile per
signup. This prototype copies roughly 22 MB of dependency source per home;
sharing immutable dependencies and large artifacts through R2 is a later storage
improvement. No R2 bucket is created by this experiment.

Postgres serves a different purpose: the existing Epicenter sign-in service stores
accounts, sessions, and OAuth tokens there. App records and builds do not depend
on Postgres. Hyperdrive only connects the API to that account database.

## Publishing and run lifetime

Draft edits do not change the live app. Svelte, esbuild WASM, and Tailwind compile
inside a fresh compiler Worker. A startup check loads the candidate action code.
Only a successful build atomically switches the active UI, actions, and assets.
A failed build records its diagnostic and keeps the last working version.

An admitted run pins its published code revision. It records acceptance, yields,
and its final 0.4 Result before sending events to observers. Closing a page stops
observation; the home owns execution through `ctx.waitUntil`. Reconnecting replays
the saved events. An explicit cancellation signals the action's `callSignal` and
fences later writes. A host interruption marks unfinished work interrupted without
starting it again. Previously written effects remain. Runs have a two-minute
cooperative limit and a maximum of sixteen concurrent runs.

The copied `fixture/app-runtime` is the real 0.4 client and action runtime, with
its fallback AbortController initialized during a call for Worker compatibility.
The frame transport supplies its fetch channel without changing that client.
The copied Tasks app adds a synthetic yielding review action for verification.
It does not read the live Tasks app or records on this computer.

## Verify locally

From the repository root, install this standalone package and build its platform
code. The authorization server's UI must be built too:

```sh
bun install --cwd packages/cli/prototype/cloudflare --frozen-lockfile
bun run --cwd packages/cli/prototype/cloudflare build:platform
bun run --cwd apps/api/ui build
bun run --cwd packages/cli/prototype/cloudflare prove:browser
```

The proof creates its own test credentials, isolated temporary Worker configs,
a disposable local Postgres cluster, and two local workerd processes. It exercises
real OAuth authorization, callback, device consent, scope checks, revocation, and the browser dashboard, then stops its processes and
database. It needs PostgreSQL utilities on PATH and Playwright Chromium.
`CHROMIUM_EXECUTABLE` selects an installed Chromium binary. Ports 8787 and 8799
must be free. A signed test session replaces only the external social-provider
sign-in; this does not prove Google sign-in against the deployed API.

To include all earlier 0.4 host protocol checks, including forced interruption:

```sh
HOSTED_PROOF_PROTOCOL=1 bun run --cwd packages/cli/prototype/cloudflare prove:browser
```

Results are recorded in `proof-hosted-local.json`, `proof-local.json`, and
`evidence/hosted-*.png`. `proof-cloudflare.json` and the earlier screenshots remain
historical evidence for the earlier deployed shared-key prototype.

The fixed platform shell is built at platform deployment. User app builds still
run in Workers. No user package installation scripts or lifecycle scripts execute.

## Deployment boundary

Normal API deployments leave this experiment off. To generate a separate opt-in
configuration without deploying anything, run:

```sh
bun apps/api/scripts/hosted-home-config.ts
```

The ignored `apps/api/wrangler.homes.generated.json` adds
`HOSTED_HOMES_EXPERIMENT=on` and the private home service binding. Turning the
experiment off closes its resource routes and removes its trust and audience
from the running server. If it has been offered to people, disable the two
registered OAuth clients as part of withdrawal; removing configuration alone
does not delete previously registered rows.

The candidate home Worker uses the existing scratch Worker name
`epicenter-tasks-workers-prototype`, its `TasksOwner` namespace, and its `LOADER`.
The earlier `tasks-proof` object remains untouched. Personal home objects use a
separate derived name, and the starter uses `hosted-starter-v1`.

The public Worker serves only the fixed dashboard, its callback and assets, and
health. A deployment credential can update the starter through
`/platform/template/admin/*`; it cannot directly select a person's home. That credential can change code
inherited by future homes and must be treated as a platform deployment secret. Only the API's
private service binding can call `HomeGateway.owner`.

Do not deploy the current API over the older live service without reviewing its
database schema and retained Durable Object classes. Do not delete the API,
legacy object namespaces, buckets, or retired database connections as part of
this experiment. The local proof does not need a production connection.

Schedules, attachments, arbitrary package installation, filesystem tools, SSH,
MCP discovery, billing, and production resource budgets are outside this proof.
The useful product tested here is one editable hosted app with durable actions
and scoped agent access. It is not a hosted Linux machine.
