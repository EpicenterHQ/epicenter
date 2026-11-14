<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>Local-first apps over files you own.</strong></p>
  <p align="center">Apps keep their data as ordinary Markdown and JSON files in a folder on your computer, and sync it with an Epicenter server, hosted or self-hosted. An editor, Git tool, or agent can open the same files.</p>
  <p align="center"><a href="apps/whispering">Whispering</a> is built on it today.</p>
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

Epicenter is your folders, and apps are lenses. Every directory directly inside
`~/Epicenter` is a folder; an optional `epicenter.json` gives it a title and a
contract. `@epicenter/folder` opens an app's folder as the typed client its file
contract derives: items are Markdown files at the contract's paths, and the
contract's schemas interpret them. Opening needs no account, remote, or
declaration file. A desktop app or a Bun script opens a directory; in a browser
the folder is the signed-in account's folder on the server.

```ts
import { openFolder } from '@epicenter/folder';
import { directory } from '@epicenter/folder/node';

const folder = openFolder(todos, directory('/Users/me/Epicenter/todos'));
await folder.todos.set({ id: 'milk' }, { title: 'Milk', done: false });
```

A write never fails: the folder keeps it, in order, until it lands. Sync is
separate from opening, and nothing syncs these folders while the folder sync
product waits
([ADR-0840](docs/adr/0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md)).

[Read the folder API](packages/folder/README.md)

## Status

Whispering runs in the browser and as a desktop app. The `epicenter` command
runs apps: each is a folder in `~/Epicenter` whose `epicenter.ts` defines its
actions, and each action is a commit in that folder's repository.
Most of the rest of this repository is the folder sync product, which waits
([ADR-0840](docs/adr/0840-epicenter-is-where-one-persons-software-lives-and-the-folder-sync-product-waits.md)).
Honeycrisp, Local Books, and the PostHog proxy left the tree in
[ADR-0902](docs/adr/0902-this-repositorys-outside-apps-stay-in-apps.md);
the tag `before-0891-layout` keeps them.

## Trust Boundaries

Pick the trust model you want.

| Path | What leaves your device |
| --- | --- |
| No sync | Nothing. The folder is complete on the device that holds it. |
| Hosted Epicenter | Account and session data and any hosted feature you enable; your folder too, when you sync it. |
| Self-hosted API | You control the server, secrets, deployment, and infrastructure boundary. Your folder goes only there. |
| A provider an app calls | Whatever that app sends it: transcript text to an LLM, audio to a transcription provider. Epicenter servers are not in that path. |

A folder syncs only with an Epicenter server, which can read its files in plaintext. Choosing that server is choosing who can read your data. See the [trust model](docs/trust-model.md) for the details.

## Repo Map

### Apps

| App | Status | Notes |
| --- | --- | --- |
| [API](apps/api) | Hosted infrastructure | Personal cloud Worker. Owns sign-in, each folder's ledger, the AI gateways, hosted-only billing, and the dashboard. Self-host it on Bun with Postgres (`apps/api/server.ts`). |
| [Whispering](apps/whispering) | Runs, development milestone | Voice recorder in a browser tab. Recordings, transcripts, and settings are files in a folder. |
| Capture, Reading, Tasks, Vocab | Runs, on `epicenter serve` | Apps in `~/Epicenter`, each its own code repository with its records in a data repository inside it: actions in one `epicenter.ts`, and a UI served at `/<app>/`. Not in this repository ([ADR-0877](docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)). |
| [Landing](apps/landing) | Deployed | The website at epicenter.so. |

### Packages

These packages carry the main architecture.

| Package | Role | License |
| --- | --- | --- |
| [`@epicenter/folder`](packages/folder) | A folder: its collections and files, opened in a browser, a desktop page, or Bun, and synced with its ledger on the server. | AGPL-3.0-or-later |
| [`@epicenter/app`](packages/app) | What an app's `epicenter.ts` imports: `defineApp`, fields, and the places an action receives. | AGPL-3.0-or-later |
| [`@epicenter/cli`](packages/cli) | The `epicenter` command: runs each app's actions as commands and MCP tools, commits what they change, and syncs app repositories. | AGPL-3.0-or-later |
| [`@epicenter/definition`](packages/definition) | A folder's contract, the front-matter and merge rules, and the names a site derives. | AGPL-3.0-or-later |
| [`@epicenter/ai`](packages/ai) | Every source of models as an endpoint, one OpenAI-compatible client, the agent loop, and the model picker. | AGPL-3.0-or-later |
| [`@epicenter/ui`](packages/ui) | Shared Svelte component library used by multiple apps. | AGPL-3.0-or-later |
| [`@epicenter/server`](packages/server) | Shared Hono server library composed by the API on Cloudflare Workers and on Bun. | AGPL-3.0-or-later |

## Architecture

The server side is split into one shared library and two deployable folders:

```txt
packages/server
  shared Hono library
  route composition for auth, sessions, folders (each a ledger
  of changes in Postgres), and provider-backed inference
  and transcription

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

Every app starts from the repo root. `bun dev:<app>` runs every process the app needs; for apps that talk to the hosted API, that includes the API worker on `localhost:8787`. `bun dev:<app>:ui` runs the app's frontend alone when that split exists, and `bun dev:api` runs just the backend. Bare `bun dev` is `bun dev:whispering`, and `bun run` with no arguments lists every target.

| Command | Starts | App port |
| --- | --- | --- |
| `bun dev:api` | Hosted API worker alone | 8787 |
| `bun dev:api-dashboard` | API + dashboard UI | 5178 |
| `bun dev:landing` | Landing site, standalone | 4321 |

`bun dev:whispering` runs Whispering in a browser tab.

The API needs local Postgres and Infisical; see [apps/api/README.md](apps/api/README.md). Rust is needed for Whispering's desktop build.

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
bun run check:structure # doc paths, catalog pins, API paths, UI boundary, boot purity, vocabulary, state paths
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
  <sub>Your data outlives the app that wrote it. Local-first, open source, built on plain files, with a history you can take with you as Git.</sub>
</p>
