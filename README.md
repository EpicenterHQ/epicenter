<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>One local-first Epicenter for every app you trust.</strong></p>
  <p align="center">Your apps share a complete record replica on your devices. Lenses give each app typed tables, values, documents, and blobs without creating another data silo.</p>
  <p align="center">Start with <a href="https://whispering.epicenter.so">Whispering in the browser</a>, or run it as a native surface inside <a href="apps/epicenter">Epicenter</a>.</p>
  <p align="center">Run the apps freely under AGPL-3.0; build on the developer toolkit freely under MIT. <a href="#license">What that means</a>.</p>
</p>

<p align="center">
  <a href="https://github.com/EpicenterHQ/epicenter" target="_blank">
    <img alt="GitHub stars" src="https://img.shields.io/github/stars/EpicenterHQ/epicenter?style=flat-square" />
  </a>
  <a href="#license">
    <img alt="Apps license: AGPL-3.0" src="https://img.shields.io/badge/apps-AGPL--3.0-blue?style=flat-square" />
  </a>
  <a href="#license">
    <img alt="Toolkit license: MIT" src="https://img.shields.io/badge/toolkit-MIT-brightgreen?style=flat-square" />
  </a>
  <a href="https://go.epicenter.so/discord" target="_blank">
    <img alt="Discord" src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=flat-square&logo=discord&logoColor=white" />
  </a>
</p>

<p align="center">
  <a href="#whispering">Whispering</a> |
  <a href="#build-with-the-toolkit">Toolkit</a> |
  <a href="#how-it-works">How It Works</a> |
  <a href="#status">Status</a> |
  <a href="#trust-boundaries">Trust</a> |
  <a href="#repo-map">Repo Map</a> |
  <a href="#development">Development</a> |
  <a href="#license">License</a>
</p>

---

## Whispering

[Whispering](apps/whispering) is a speech-to-text SPA with two hosts. Open the [hosted browser app](https://whispering.epicenter.so), or run the same source as a native surface inside [Epicenter](apps/epicenter).

Press record, speak, optionally transform the transcript, and copy or deliver the result. Both hosts support cloud providers and self-hosted endpoints. Epicenter adds system-global shortcuts, native paste delivery, and local GGUF transcription.

[Open Whispering](https://whispering.epicenter.so) | [Read the app architecture](apps/whispering)

## Build With The Toolkit

The developer toolkit is MIT: build anything on it, including closed-source and commercial products, and you own what you build, with no obligation back to Epicenter. Its embeddable roots are [`@epicenter/data`](packages/data), [`@epicenter/document-sync`](packages/document-sync), [`@epicenter/agent`](packages/agent), [`@epicenter/ui`](packages/ui), [`@epicenter/sync`](packages/sync), [`@epicenter/sqlite`](packages/sqlite), and [`@epicenter/row-sync`](packages/row-sync). They are pre-1.0 and tuned for our own apps, so treat them as fork-and-own rather than a stability-guaranteed SDK for now.

The hard problem with local-first apps is synchronization. [`@epicenter/data`](packages/data) answers it with one record protocol and complete local replicas. Every durable record has scalar JSON and may own one bounded Yjs 14 document plus one immutable blob. Applications contribute pure Lenses that interpret portions of the same Epicenter as typed tables and values; a Lens does not create another database or synchronization scope.

```typescript
import { defineLens, defineTable } from '@epicenter/data/record';
import { field } from '@epicenter/field';

const notes = defineTable({
  title: 'Notes',
  fields: {
    title: field.string(),
    pinned: field.boolean(),
  },
  optional: [],
});

export const notesLens = defineLens({
  namespace: 'com.example.notes',
  title: 'Notes',
  description: 'Notes and their collaborative bodies.',
  collections: { notes },
});
```

[Read the data package docs](packages/data/README.md) | [Understand One Epicenter and Lenses](docs/architecture/one-epicenter-namespaces-and-lenses.md)

## How It Works

One person has one Epicenter: one logical body of records replicated in full at
each browser, desktop, or trusted server boundary. Applications contribute
pure Lenses that interpret durable namespaces. A Lens adds names, schemas, and
typed operations; it does not create another database or synchronization
scope.

```txt
Whispering Lens ---\
Honeycrisp Lens ----+--> complete local replica --> trusted authority
Home Lens ----------/          |                         |
                               |                         +-- ordered facts
                               +-- scalar records        +-- documents
                               +-- Yjs documents         `-- blobs
                               `-- immutable blobs
```

Every record is addressed by `{ namespace, collection, recordKey }`. Its scalar
JSON changes through four ordinary operations and may own one bounded Yjs
document plus one immutable blob. Writes become durable locally before remote
settlement. The runtime retains and retries every authority obligation after a
restart.

```txt
typed application
  -> Lens table or value operation
  -> local record owner
  -> durable pending obligation
  -> authority fact
  -> every attached replica catches up
```

Applications receive no SQL connection to the live store. Epicenter Home owns
typed live browsing and captures inert, point-in-time SQLite artifacts for ad
hoc queries. Portable Backup and Restore are separate custody operations; an
inspection snapshot can never be applied to live data.

Matter is intentionally different. It edits user-owned Markdown folders
directly and keeps a disposable SQLite query mirror. It does not turn those
folders into Epicenter record namespaces.

## Status

Whispering is independently deployable as a browser SPA and is also mounted inside the Epicenter desktop host. Epicenter is the only native runtime; Whispering no longer ships a standalone desktop shell.

Whispering and Honeycrisp now bind their Lenses to the same Epicenter record owner. [Matter](apps/matter) is an early app for user-owned Markdown folders: it edits ordinary Markdown directly and keeps `matter.sqlite` as a query mirror. Other app folders are public research and prototypes.

The record protocol, replica and authority owners, document and blob
foundations, Lens API, retained caller migration, and deletion of the old
Workspace path have landed on the active greenfield line. Home snapshot
capture, portable Backup and Restore, and the Proposal prototype remain active
implementation waves until their recognition tests pass.

## Trust Boundaries

Pick the trust model you want.

| Path | What leaves your device |
| --- | --- |
| Whispering in Epicenter with local GGUF transcription | Audio stays on your device. Transcripts and settings use Epicenter's local desktop storage. |
| Whispering with a cloud transcription provider | Audio goes from your device to the provider you choose. Epicenter servers are not in that transcription path. |
| Whispering transformations | Transcript text goes to the LLM provider you choose when you enable that step. |
| Hosted Epicenter API or sync | Record, document, and blob updates, account/session data, and enabled hosted feature requests go to Epicenter servers. |
| Self-hosted deployable | You control the server, secrets, deployment, and infrastructure boundary. |

Signed-in synchronization sends record facts, Yjs document updates, and blob bytes to a trusted authority that can read them. On hosted Epicenter the authority is ours, so that data sits inside our trust boundary; self-hosting puts it on infrastructure you control, so Epicenter never holds it. See the [trust model](docs/trust-model.md) for details.

The detailed privacy notes for Whispering live in [apps/whispering](apps/whispering).

## Repo Map

### Product Surfaces

| Surface | Status | Notes |
| --- | --- | --- |
| [Whispering](apps/whispering) | Browser and Epicenter surface | One speech-to-text SPA with browser-safe providers and Epicenter-only native capabilities. |
| [Epicenter](apps/epicenter) | Desktop host | The only Tauri runtime. Serves trusted app surfaces, including Whispering, under one native shell. |
| [Matter](apps/matter) | WIP product work | Typed grid for user-owned Markdown folders. It edits ordinary `.md` files directly; `matter.sqlite` is a disposable query mirror. |
| [API](apps/api) | Hosted infrastructure | Personal cloud Worker for hosted Epicenter services. Includes hosted-only billing and dashboard code. |
| [Self-host](apps/self-host) | Reference deployable | Community-supported single-partition instance without hosted billing. |
| Other app folders | Research and prototypes | Useful history and experiments, not the current product lineup. |

### Packages

These packages carry the main architecture.

| Package | Role | License |
| --- | --- | --- |
| [`@epicenter/data`](packages/data) | Record protocol, complete local replicas, pure Lenses, row documents, immutable blobs, and browser, Bun, and desktop owners. | MIT |
| [`@epicenter/document-sync`](packages/document-sync) | Bounded row-document publication and realtime synchronization. | MIT |
| [`@epicenter/agent`](packages/agent) | Agent loop and tool-catalog composition over application capabilities. | MIT |
| [`@epicenter/row-sync`](packages/row-sync) | Portable scalar row protocol, admission, deterministic field folding, and exact-retry digests. It owns no authority database. | MIT |
| [`@epicenter/sqlite`](packages/sqlite) | Neutral embedded-SQLite driver and Browser, Bun, and Durable Object adapters. It owns no product schema. | MIT |
| [`@epicenter/sync`](packages/sync) | Yjs document protocol encoding and provider behavior, separate from scalar row synchronization. | MIT |
| [`@epicenter/ui`](packages/ui) | Shared Svelte component library used by multiple app surfaces. | MIT |
| [`@epicenter/server`](packages/server) | Shared Hono server library composed by the hosted API and self-host reference deployable. | AGPL-3.0-or-later |
| [`@epicenter/cli`](packages/cli) | The `epicenter` command and local or hosted API workflows. | AGPL-3.0-or-later |

## Architecture

The server side is split into one shared library and two deployable folders:

```txt
packages/server
  shared Hono library
  route composition for auth, sessions, rooms, assets, and provider-backed APIs

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

Every app starts from the repo root. `bun dev:<app>` runs every process the app needs; for apps that talk to the hosted API, that includes the API worker on `localhost:8787`. `bun dev:<app>:ui` runs the app's frontend alone when that split exists, and `bun dev:api` runs just the backend. Bare `bun dev` is the current default workflow (API and Whispering), and `bun run` with no arguments lists every target.

| Command | Starts | App port |
| --- | --- | --- |
| `bun dev:api` | Hosted API worker alone | 8787 |
| `bun dev:api-dashboard` | API + dashboard UI | 5178 |
| `bun dev:honeycrisp` | API + Honeycrisp desktop | 5175 |
| `bun dev:whispering` | API + hosted Whispering browser app | 1420 |
| `bun dev:epicenter` | Epicenter desktop host, including Whispering | Tauri window |
| `bun dev:landing` | Landing site, standalone | 4321 |
| `bun dev:matter` | Matter desktop, standalone | 5180 |
| `bun dev:posthog-reverse-proxy` | PostHog reverse proxy Worker | wrangler default |
| `bun dev:self-host` | Self-host server (needs `INSTANCE_TOKEN`) | 8787 |

The API needs local Postgres and Infisical; see [apps/api/README.md](apps/api/README.md). Rust is needed for Tauri apps such as Epicenter, Matter, and Honeycrisp. Local Books and Local Mail run their own multi-process dev flows; their READMEs document them.

Useful checks:

```bash
bun run typecheck
bun run test
bun run check
```

## Design Notes

Implementation specs and design notes live in [specs/](specs). Start with [docs/README.md](docs/README.md) and [specs/README.md](specs/README.md).

## Contributing

Contributions are welcome. Good entry points are docs, Whispering fixes, local-first infrastructure, Svelte interfaces, and small changes that make the repo easier to understand.

[Read the Contributing Guide](CONTRIBUTING.md)

Contributors coordinate in [Discord](https://go.epicenter.so/discord).

## License

Epicenter uses a two-tier split by how you use the code:

- [MIT](licenses/LICENSE-MIT) for code you build with: the toolkit roots (`@epicenter/data`, `@epicenter/document-sync`, `@epicenter/agent`, `@epicenter/ui`, `@epicenter/sync`, `@epicenter/sqlite`, `@epicenter/row-sync`) and the toolkit-internal contracts they carry (`@epicenter/identity`, `@epicenter/agent-protocol`, `@epicenter/encryption`, `@epicenter/field`, `@epicenter/chat`). Twelve packages today.
- [AGPL-3.0](licenses/LICENSE-AGPL-3.0) or later for code we ship or run: every app, the shared server library, the CLI, and the rest of the internal packages.
- There is no proprietary tier today. Revenue is intended to come from hosting and services, not from selling closed licenses.

Every dependency of the toolkit packages is MIT-compatible, enforced by `bun run check:licenses`. The license split follows the same broad pattern as Plausible and PostHog for hosted open-source services, and Yjs for MIT core libraries with copyleft server pieces.

See the root [LICENSE](LICENSE), [FINANCIAL_SUSTAINABILITY.md](FINANCIAL_SUSTAINABILITY.md), and the [licensing strategy](docs/licensing/licensing-strategy.md) for the full model.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>One local-first Epicenter. Typed apps, complete replicas, open source.</sub>
</p>
