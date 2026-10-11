[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/epicenterhq-epicenter-badge.png)](https://mseep.ai/app/epicenterhq-epicenter)

<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>Local-first apps over a store you own.</strong></p>
  <p align="center">An app's whole data set is one CRDT document on your machine, complete enough to work with the network off. Sign in on a second device and the two converge. No server holds the only copy, and no app owns your storage.</p>
  <p align="center"><a href="apps/honeycrisp">Honeycrisp</a>, a local-first notes app, is the app built on it today.</p>
  <p align="center">Run the apps freely under AGPL-3.0-or-later. <a href="#license">What that means</a>.</p>
</p>

<p align="center">
  <a href="https://github.com/EpicenterHQ/epicenter" target="_blank">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/EpicenterHQ/epicenter?style=flat-square" />
  </a>
  <a href="#license">
    <img alt="Apps license: AGPL-3.0" src="https://img.shields.io/badge/apps-AGPL--3.0-blue?style=flat-square" />
  </a>
  <a href="#license">
    <img alt="Packages license: AGPL-3.0-or-later" src="https://img.shields.io/badge/packages-AGPL--3.0--or--later-blue?style=flat-square" />
  </a>
  <a href="https://go.epicenter.so/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="#the-store">The Store</a> |
  <a href="#status">Status</a> |
  <a href="#trust-boundaries">Trust</a> |
  <a href="#repo-map">Repo Map</a> |
  <a href="#development">Development</a> |
  <a href="#license">License</a>
</p>

---

## The Store

The hard problem with local-first apps is synchronization. If each device has
its own SQLite file, how do you keep them in sync?

Epicenter's answer: **a database is one Yjs document, replayed in full before
any handle exists, and the surface over it is synchronous.** A read is a
property access, not a round trip, so nothing is awaited and nothing needs cache
invalidation or race protection. The rich half is in there too: a row's node is
a nested type on the row, not a second document with an address of its own.

```typescript
import { openDatabase } from '@epicenter/data/browser';
import { defineData, defineTable, field, plainText } from '@epicenter/data/definition';

const notesDefinition = defineData({
	id: 'com.example.notes',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			pinned: field.boolean(),
			folderId: field.nullable(field.string()),
			content: plainText(),
		}),
	},
});

// Opening is the asynchronous boundary; reads and writes are synchronous.
const { data, error } = await openDatabase(notesDefinition, { generation: 1 });
if (error !== null) throw error;

const note = data.tables.notes.create({ title: 'Hello', pinned: false, folderId: null });

const listed = data.tables.notes.rows;             // synchronous flat rows
const stop = data.tables.notes.subscribe(() => { /* re-read rows */ });
```

A *data definition* is one application's declaration of its durable data: pure
JSON field descriptors, no storage and no lifecycle of its own. It is
release-local and never migrates your data. A row it cannot read is reported
beside the rows it can, with the reason and the raw values intact, and an
ordinary write repairs it.

The node at `content` merges per character. Declare its codec with
`content: plainText()` and reach it with `data.tables.notes.get(note.id)?.content`;
Epicenter never looks inside. The database document's `kv`/`tables:<name>` shape
is recorded in
[ADR-0257](docs/adr/0257-the-application-document-has-named-kv-and-table-roots.md)
and its collapse to one document in
[ADR-0295](docs/adr/0295-a-database-is-one-yjs-document-and-a-row-holds-its-rich-content.md).

Sync is one Cloudflare Durable Object per (account, application). Being signed
in on two devices is the entire sharing model: nothing is paired, invited, or
approved.

[Read the data package docs](packages/data/README.md) | [What it replaced, and why](docs/the-store-and-what-it-replaced.md)

## Status

There is one runtime: a desktop SPA in a WebView, over a store the client owns.
A host serves bundles and brokers credentials; it owns no application data. A
hosted web runtime with a host-owned replica is refused, and so are third-party
installed apps, for now.

[Honeycrisp](apps/honeycrisp) is the app running on the store, and its
README is the worked example.

Whispering, vocab, skills, and the Epicenter host now compile against the store.
The superseded data stack was deleted before they were migrated, deliberately,
so old data is not imported into the new model.

[Matter](apps/matter) edits user-owned Markdown folders directly and keeps a
disposable `matter.sqlite` query mirror beside them. [Local
Books](apps/local-books) and [Local Mail](apps/local-mail) are headless mirrors
that pull a hosted account into local SQLite. Those three do not use the store.

## Trust Boundaries

Pick the trust model you want.

| Path | What leaves your device |
| --- | --- |
| Signed out | Nothing. The store is complete on the machine it opened on, and every read comes from a document already in memory. |
| Signed in | Your application's document, as opaque update bytes, to one authority per account. |
| Hosted Epicenter | That authority is ours, along with account and session data and any hosted feature you enable. |
| Self-hosted instance | You control the server, secrets, deployment, and infrastructure boundary. |
| A provider an app calls | Whatever that app sends it: transcript text to an LLM, audio to a transcription provider. Epicenter servers are not in that path. |

Signed-in sync sends your data to a trusted server that reads it in plaintext. On hosted Epicenter the authority is ours, so that data sits inside our trust boundary; self-hosting puts it on infrastructure you control, so Epicenter never holds it. See the [trust model](docs/trust-model.md) for the details, including where this is heading with the anchor.

## Repo Map

### Apps

| App | Status | Notes |
| --- | --- | --- |
| [Honeycrisp](apps/honeycrisp) | Runs on the store | Local-first notes. Folders and notes are rows; a note's body is the node on its row. |
| [Matter](apps/matter) | Runs, separately | Typed grid over user-owned Markdown folders. It edits ordinary `.md` files directly; `matter.sqlite` is a disposable query mirror. |
| [Local Books](apps/local-books), [Local Mail](apps/local-mail) | Run, separately | Headless CLI mirrors that pull QuickBooks and Gmail into local SQLite. |
| [API](apps/api) | Hosted infrastructure | Personal cloud Worker. Owns the store authority binding, hosted-only billing, and the dashboard. |
| [Self-host](apps/self-host) | Reference deployable | Community-supported single-partition instance without hosted billing. |
| [Whispering](apps/whispering), [vocab](apps/vocab), [skills](apps/skills), [Epicenter](apps/epicenter) | Compile | Migrated onto the store. |
| Other app folders | Research and prototypes | Useful history and experiments, not the current product lineup. |

### Packages

These packages carry the main architecture.

| Package | Role | License |
| --- | --- | --- |
| [`@epicenter/data`](packages/data) | The store: one Yjs document per application, a synchronous surface over it, and the transport that carries it. | AGPL-3.0-or-later |
| [`@epicenter/data/definition`](packages/data/src/definition) | The inert data-definition vocabulary: JSON field descriptors, row addresses, and nonconformance. | AGPL-3.0-or-later |
| [`@epicenter/sqlite`](packages/sqlite) | Neutral embedded-SQLite driver with Browser, Bun, and Durable Object adapters. It owns no product schema. | AGPL-3.0-or-later |
| [`@epicenter/sync`](packages/sync) | The WebSocket subprotocol vocabulary both halves of a handshake must agree on. | AGPL-3.0-or-later |
| [`@epicenter/ui`](packages/ui) | Shared Svelte component library used by multiple apps. | AGPL-3.0-or-later |
| [`@epicenter/server`](packages/server) | Shared Hono server library composed by the hosted API and the self-host reference deployable. | AGPL-3.0-or-later |

## Architecture

The server side is split into one shared library and two deployable folders:

```txt
packages/server
  shared Hono library
  route composition for auth, sessions, store sync, blobs,
  and provider-backed inference and transcription

apps/api
  hosted personal Cloudflare Worker
  composes packages/server with a Better Auth principal resolver
  owns hosted-only dashboard and billing code

apps/self-host
  self-hosted single-partition instance reference deployable
  composes packages/server with the instance principal resolver
  community-supported
  no hosted billing surface
```

[Full architecture walkthrough](docs/architecture.md) | [Trust model](docs/trust-model.md)

## Development

Use Bun in this repo.

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
```

Every app starts from the repo root. `bun dev:<app>` runs every process the app needs; for apps that talk to the hosted API, that includes the API worker on `localhost:8787`. `bun dev:<app>:ui` runs the app's frontend alone when that split exists, and `bun dev:api` runs just the backend. Bare `bun dev` is `bun dev:honeycrisp`, and `bun run` with no arguments lists every target.

| Command | Starts | App port |
| --- | --- | --- |
| `bun dev:honeycrisp` | API + Honeycrisp desktop | 5175 |
| `bun dev:honeycrisp:ui` | Honeycrisp in the browser, no API or Tauri shell | 5175 |
| `bun dev:api` | Hosted API worker alone | 8787 |
| `bun dev:api-dashboard` | API + dashboard UI | 5178 |
| `bun dev:landing` | Landing site, standalone | 4321 |
| `bun dev:matter` | Matter desktop, standalone | 5180 |
| `bun dev:posthog-reverse-proxy` | PostHog reverse proxy Worker | wrangler default |
| `bun dev:self-host` | Self-host server (needs `INSTANCE_TOKEN`) | 8787 |

`bun dev:whispering`, `bun dev:vocab`, `bun dev:skills`, and `bun dev:epicenter` still exist, and those apps compile against the store.

The API needs local Postgres and Infisical; see [apps/api/README.md](apps/api/README.md). Rust is needed for Tauri apps such as Honeycrisp and Matter. Local Books and Local Mail run their own multi-process dev flows; their READMEs document them.

`bun run check` is the gate. It runs lint, typecheck, every workspace test, and the structural checks, and it is the same gate CI runs, so a green local run predicts a green pull request. Formatting is handled separately by the autofix workflow.

```bash
bun run check
```

Run the pieces on their own while you work:

```bash
bun run format          # rewrite formatting (CI autofixes this for you)
bun run lint:check
bun run typecheck
bun run test
bun run check:structure # doc paths, catalog pins, API paths, licenses, UI boundary, boot purity
```

Two checks sit outside the gate on purpose. `bun run check:doc-hygiene` flags specs and ADRs that time has made stale, so it belongs to review rather than to merge. `bun run smoke:local` boots the API against local services.

## Design Notes

Durable decisions and their reasoning live in [docs/adr/](docs/adr). Specs in [specs/](specs) are in-flight design scaffolding rather than current truth; when a spec and an ADR disagree, the ADR wins. Start with [docs/README.md](docs/README.md).

## Contributing

Contributions are welcome. Good entry points are docs, local-first infrastructure, Svelte interfaces, migrating a broken app onto the store, and small changes that make the repo easier to understand.

[Read the Contributing Guide](CONTRIBUTING.md)

Contributors coordinate in [Discord](https://go.epicenter.so/discord).

## License

Everything is [AGPL-3.0-or-later](licenses/LICENSE-AGPL-3.0). An MIT toolkit
tier existed until 2026-08 and was dissolved; versions already published under
MIT stay MIT for those versions.

See the root [LICENSE](LICENSE), [FINANCIAL_SUSTAINABILITY.md](FINANCIAL_SUSTAINABILITY.md), and the [licensing strategy](docs/licensing/licensing-strategy.md) for the full model.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>Your data outlives the app that wrote it. Local-first, open source, built on Yjs.</sub>
</p>
