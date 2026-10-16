<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>Local-first apps over files you own.</strong></p>
  <p align="center">An app's data is a folder of Markdown and JSON files with Git history beside it, whole on every device you use. It syncs over plain Git with a server you choose, and any editor, Git tool, or agent can work on the same files.</p>
  <p align="center"><a href="apps/todos">Todos</a>, <a href="apps/whispering">Whispering</a>, and <a href="apps/honeycrisp">Honeycrisp</a> are built on it today.</p>
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
  <a href="#the-folder">The Folder</a> |
  <a href="#status">Status</a> |
  <a href="#trust-boundaries">Trust</a> |
  <a href="#repo-map">Repo Map</a> |
  <a href="#development">Development</a> |
  <a href="#license">License</a>
</p>

---

## The Folder

A data folder is a directory: one Markdown file per row, `kv.json` for
settings, `epicenter.json` describing both, and Git history beside them. The
files are the data. There is no database behind them for an app to own.

```ts
import { defineFolder, defineTable, field, openFolder } from '@epicenter/folder';

const definition = defineFolder({
  kv: { theme: field.string() },
  tables: {
    todos: defineTable({ fields: { title: field.string(), done: field.boolean() } }),
  },
});

const { data: folder, error } = await openFolder({ id: 'so.epicenter.todos', definition });
if (error !== null) throw error;

const listed = await folder.tables.todos.list();   // one { stem, result } per row file
await folder.tables.todos.create({ fields: { title: 'Milk', done: false }, body: '' });
```

The same handle opens in a browser tab (the origin's private file system), a
desktop page (`~/Epicenter/<folder-id>/`, through the desktop shell), and a Bun
script (any directory), as
[ADR-0533](docs/adr/0533-one-folder-handle-opens-in-three-hosts-chosen-by-where-the-code-runs.md)
records. A folder syncs when a person syncs: it fetches and pushes plain Git, with
a token, to the remote in its own `remote.origin.url`
([ADR-0521](docs/adr/0521-a-folder-syncs-over-plain-git-with-a-token-to-a-server-the-person-chooses.md)).

[Read the folder API](packages/folder/README.md)

## Status

Apps run in the browser and as desktop apps, over folders. Todos opens at once
with no account and syncs through Connect; Whispering, Capture, Vocab, and
Honeycrisp keep their data in folders too. The Yjs store and its sync were
removed, with the Local Mail, Skills, and sync-lab apps built on them; Git
history keeps them for a return.

Matter, a typed grid over Markdown folders with its own schema and SQLite
mirror, was removed too; the Epicenter desktop app's Folders window edits data
folders instead. [Local Books](apps/local-books) is a headless mirror that
pulls a QuickBooks account into local SQLite and keeps its own format.

## Trust Boundaries

Pick the trust model you want.

| Path | What leaves your device |
| --- | --- |
| No remote | Nothing. The folder is complete on the device that holds it. |
| A Git remote you choose | The folder's files and history, to that server, when you sync. |
| Hosted Epicenter | Account and session data and any hosted feature you enable; your folder too, if Epicenter's server is its remote. |
| Self-hosted API | You control the server, secrets, deployment, and infrastructure boundary. |
| A provider an app calls | Whatever that app sends it: transcript text to an LLM, audio to a transcription provider. Epicenter servers are not in that path. |

Sync sends your files to the server in `remote.origin.url`, which can read them in plaintext. Choosing that server is choosing who can read your data. See the [trust model](docs/trust-model.md) for the details.

## Repo Map

### Apps

| App | Status | Notes |
| --- | --- | --- |
| [Honeycrisp](apps/honeycrisp) | Runs, development milestone | Markdown notes, installed in Epicenter or in a browser tab. Metadata stays in frontmatter, logical folders preserve note identity, and Git records saved files. |
| [Local Books](apps/local-books) | Runs, separately | Headless CLI mirror that pulls QuickBooks into local SQLite. |
| [API](apps/api) | Hosted infrastructure | Personal cloud Worker. Owns sign-in, hosted blobs, the AI gateways, hosted-only billing, and the dashboard. Self-host it on Bun with Postgres (`apps/api/server.ts`). |
| [Whispering](apps/whispering) | Runs, development milestone | Standalone desktop recorder. Recordings, transcripts, and settings are files in one Git-versioned folder. |
| [Todos](apps/todos) | Runs, development milestone | Opens at once over a folder; Connect sets its Git remote. |
| [Vocab](apps/vocab) | Runs, development | Words and chats in a folder, with AI over `@epicenter/ai`. |
| [Epicenter](apps/epicenter) | Runs, development | The desktop host for compiled and installed apps. |
| Other app folders | Research and prototypes | Useful history and experiments, not the current product lineup. |

### Packages

These packages carry the main architecture.

| Package | Role | License |
| --- | --- | --- |
| [`@epicenter/folder`](packages/folder) | The data folder: tables, `kv`, files, history, and Git sync, in a browser, a desktop page, or Bun. | AGPL-3.0-or-later |
| [`@epicenter/ai`](packages/ai) | Inference connections, the AI gateway client, and the inference picker. | AGPL-3.0-or-later |
| [`@epicenter/ui`](packages/ui) | Shared Svelte component library used by multiple apps. | AGPL-3.0-or-later |
| [`@epicenter/server`](packages/server) | Shared Hono server library composed by the API on Cloudflare Workers and on Bun. | AGPL-3.0-or-later |

## Architecture

The server side is split into one shared library and two deployable folders:

```txt
packages/server
  shared Hono library
  route composition for auth, sessions, blobs,
  and provider-backed inference and transcription

apps/api
  hosted personal Cloudflare Worker
  composes packages/server with a Better Auth principal resolver
  owns hosted-only dashboard and billing code
  server.ts runs the same composition on Bun with Postgres: the self-host path
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
| `bun dev:honeycrisp` | Honeycrisp in the browser, no API | 5175 |
| `bun dev:api` | Hosted API worker alone | 8787 |
| `bun dev:api-dashboard` | API + dashboard UI | 5178 |
| `bun dev:landing` | Landing site, standalone | 4321 |
| `bun dev:posthog-reverse-proxy` | PostHog reverse proxy Worker | wrangler default |

`bun dev:whispering` runs Whispering's page in a browser tab; on the desktop it, like Honeycrisp, is installed into Epicenter. `bun dev:todos`, `bun dev:vocab`, and `bun dev:epicenter` run those apps.

The API needs local Postgres and Infisical; see [apps/api/README.md](apps/api/README.md). Rust is needed for Tauri apps such as Epicenter. Local Books and Local Mail run their own multi-process dev flows; their READMEs document them.

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

One check sits outside the gate on purpose. `bun run check:doc-hygiene` flags specs and ADRs that time has made stale, so it belongs to review rather than to merge.

## Design Notes

Durable decisions and their reasoning live in [docs/adr/](docs/adr). Specs in [specs/](specs) are in-flight design scaffolding rather than current truth; when a spec and an ADR disagree, the ADR wins. Start with [docs/README.md](docs/README.md).

## Contributing

Contributions are welcome. Good entry points are docs, local-first infrastructure, Svelte interfaces, moving an app onto folders, and small changes that make the repo easier to understand.

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
  <sub>Your data outlives the app that wrote it. Local-first, open source, built on plain files and Git.</sub>
</p>
