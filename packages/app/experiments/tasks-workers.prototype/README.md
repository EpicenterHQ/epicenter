# Tasks on Workers: disposable prototype

This prototype tests whether an agent can edit a real Tasks app's Svelte UI and
TypeScript actions, build both inside Cloudflare Workers, and keep the published
version working when the next build fails. It uses a copied app and synthetic
records. It never opens the person's actual Tasks data.

The platform owns the compiler pipeline. An app supplies source files and uses
Worker-compatible JavaScript dependencies. It cannot supply a shell command,
install an operating-system package, or start a persistent process.

```text
raw Svelte + TypeScript edits
             |
       source in SQLite
             |
  fresh compiler Worker per build
  Svelte + esbuild WASM + Tailwind
             |
    import/startup smoke check
             |
  publish UI + actions + assets together
             |
  browser UI -> dynamic action Worker -> Markdown in SQLite
```

A Durable Object owns the source, Markdown files, build records, and one active
revision pointer. The compiler runs in a separate disposable dynamic Worker.
The active pointer changes in the same SQLite transaction that stores a
successful build. A compile or startup failure leaves that pointer alone.
Calls carry their UI revision in the URL; stale pages receive 409 and must reload.

## Run

This is a standalone Bun package with its own dependency lock. From this folder:

```sh
bun install --frozen-lockfile
```

Set a random `ADMIN_TOKEN` in a local `.dev.vars` file. In another terminal, export
the same value as `TASKS_PROTOTYPE_TOKEN`. Keep both out of version control.

```sh
bun run dev
```

Then, in that other terminal:

```sh
bun run prove http://localhost:8799
```

The proof uploads raw app and dependency source, builds V1, exercises the actual
collection actions, edits the visible Svelte heading and the add action, builds
V2, tests the app during compilation, then breaks Svelte and TypeScript. It checks
that the published bundle, static assets, actions, and stored Markdown survive.
It restores the source to the working V2 but retains the failed build records.
Proof JSON is written separately for local and hosted runs.

For browser verification after the proof:

```sh
bun x playwright install chromium
bun run prove:browser http://localhost:8799
```

`CHROMIUM_EXECUTABLE` can point to an existing Chromium executable. The browser
proof adds a synthetic task through the UI, opens it, completes it, reloads it,
captures desktop/mobile screenshots, and deletes its synthetic record.

`bun run build:platform` bundles the **fixed platform compiler**, without reading
the Tasks fixture. It does not compile the application. The source uploader
imports no compiler. Svelte compilation, TypeScript bundling, CSS generation,
and action execution happen in Workers.

## Hosted proof

The scratch deployment is `epicenter-tasks-workers-prototype`, under Epicenter's
Cloudflare account. The endpoint requires a bearer token or prototype session
cookie. The only public endpoint is `/health`.

To reproduce on another account, edit `name` and `account_id` in `wrangler.jsonc`,
authenticate Wrangler, provision its `ADMIN_TOKEN` secret, then run `bun run deploy`
and pass the resulting URL to the proof commands. The platform compiler artifact
is bundled locally at platform deployment, just as any platform Worker is; app
edits are compiled remotely.

Customers need an Epicenter login, while Epicenter operates the Cloudflare
account and provisioning credentials. This demo uses one app owner. A product
would map an authenticated customer/app ID to an object and pass only that app's
storage capability into its action Worker. No customer Cloudflare token is
needed. Cloudflare documents both dynamic custom bindings and deployment on a
platform customer's behalf:

- [Dynamic Worker bindings](https://developers.cloudflare.com/dynamic-workers/usage/bindings/)
- [Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/how-workers-for-platforms-works/)

## What this establishes

The fixture contains the installed Tasks application's actual UI and action
source, plus a snapshot of `@epicenter/app`. The runtime snapshot has one Workers
adaptation: its fallback AbortController is created inside a call instead of at
module initialization. The action adapter supplies a YAML implementation for the
runtime's `Bun.YAML.parse` call. SQL-backed folder methods preserve Markdown text;
there is no Linux filesystem.

The build uses Cloudflare's experimental `@cloudflare/worker-bundler`, with a
custom resolver and Svelte plugin. This requires its explicitly unstable esbuild
plugin escape hatch. Dependencies are supplied as raw installed package files;
this does not prove package installation or arbitrary lifecycle scripts in
Workers. Tailwind uses its JavaScript compiler and a simple source-token scan,
rather than its native scanner. Svelte compilation strips types; this demo does
not perform TypeScript semantic checking of app edits.

The first version put the compiler inside the app's Durable Object. A first
hosted build worked, but a second exhausted its isolate's memory. A fresh compiler
Worker per build fixed the repeated-build case and kept compilation separate
from serving. Local success alone did not reveal that limit. See `NOTES.md` and
the hosted proof JSON for the measured result.

This is a feasibility proof, not a hosted service: it has one shared demo secret,
no tenant authorization system, billing, editor, npm installer, scheduling,
streaming/cancellation adapter, R2 attachments, migrations, or Git history. Its
folder adapter handles text only. Dynamic actions have network egress disabled.
An action exception may leave writes it already made; only publishing the code
revision is atomic. Production would also need quotas, build lifecycle records,
and app-origin isolation before accepting code from mutually untrusted people.
