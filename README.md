<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>Where one person's software lives.</strong></p>
  <p align="center">Small apps keep what you make as plain files on one computer you control, and every device you own, and your agents, reach them there.</p>
  <p align="center"><a href="apps/whispering">Whispering</a>, desktop speech-to-text for macOS, Windows, and Linux, installs today.</p>
  <p align="center">Run it freely under AGPL-3.0-or-later. <a href="#license">What that means</a>.</p>
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
  <a href="#how-it-works">How it works</a> |
  <a href="#status">Status</a> |
  <a href="#trust-boundaries">Trust</a> |
  <a href="#repo-map">Repo map</a> |
  <a href="#development">Development</a> |
  <a href="#license">License</a>
</p>

---

## How it works

`~/Epicenter` is on a computer you control and keep on, owned or rented: the
home. It holds a folder per app in `apps/`. Each app is one `epicenter.ts` that
declares its collections and actions, an optional UI, and a `data/` folder of
Markdown files you can read, with its code and its data each in a Git
repository of its own.

```ts
import { defineApp, defineCollection, field } from '@epicenter/app';

const tasks = defineCollection({
  path: 'data/tasks/{time}.md',
  description: 'task',
  fields: { title: field.text(), done: field.boolean() },
});

export default defineApp({
  description: 'Things I mean to do',
  collections: { tasks },
  actions: tasks.actions(),
});
```

The `epicenter` command runs an app's actions on the home, and commits what
each one writes:

```sh
epicenter tasks add --title 'Call the bank'
epicenter tasks list --json
epicenter serve
```

`epicenter serve` offers every app's actions over MCP, and each app's UI at
`/<app>/`, to every device on your tailnet. Nothing syncs and no one signs in:
your phone, your laptop, and your agents reach the one copy on the home, and
keep nothing of their own. An app's optional `origin` is a push-only backup.

Software that works without an Epicenter is an outside app: Gmail, Todoist,
Whispering. An inside app brings its data in through actions. Mail pulls a copy
of your mailbox to the home, and an agent changes Gmail only through a proposal
you apply.

[The vision](docs/vision.md) | [The `epicenter` command](packages/cli/README.md) | [What an app imports](packages/app/README.md)

## Status

The `epicenter` command and `epicenter serve` run from this repository; the npm
release is decided and not built
([ADR-0892](docs/adr/0892-the-cli-releases-to-npm-and-whispering-8-is-a-new-install-with-its-own-update-address.md)).
`epicenter service install` keeps `serve` running as a macOS LaunchAgent; the
Linux job for a rented home and Epicenter for Mac are not built yet.

The author's inside apps (Capture, Mail, Messages, Reading, Tasks, and Vocab)
run on their home. They are not in this repository: each is a repository of its
own, taken with `epicenter new <app> --from <git url>`
([ADR-0877](docs/adr/0877-an-apps-code-and-its-data-are-two-repositories-and-sharing-an-app-shares-its-code.md)).

Whispering, an outside app, runs in a browser tab and as a desktop app, and
needs no Epicenter. Epicenter, the company, also hosts services: sign-in and
paid models (`apps/api`).

The folder sync product that came before is retired
([ADR-0899](docs/adr/0899-the-folder-sync-product-is-retired.md)). Some of its
code stays here while Whispering imports it.

## Trust boundaries

Your data is on the home, and whoever can read the home can read it.

| Where | Who can read it |
| --- | --- |
| A home you own | You, and whatever you let reach it: devices on your tailnet, agents you give a shell. |
| A home you rent | You and its provider, which can read the disk, `.local` sign-in files included. |
| Your other devices | Only what a UI or agent fetches while it reaches the home. They keep no copy. |
| An app's `origin` backup | Whoever hosts the backup repository. Nothing is pushed until you add one. |
| A service an inside app pulls from | The service already holds that data. Mail's Google sign-in is a `.local` file in Mail's folder on the home, and never leaves it. |
| Epicenter's hosted services | What you send them: a prompt or audio for a paid model, and your account. They hold no part of your Epicenter. |

`serve` signs no one in, so who reaches it is the tailnet's decision. See the
[trust model](docs/trust-model.md) for the details.

## Repo map

### Apps

Every app in this repository is an outside app
([apps/README.md](apps/README.md)).

| App | What it is |
| --- | --- |
| [Whispering](apps/whispering) | Voice recorder and speech-to-text, in a browser tab or as a desktop app. Recordings, transcripts, and settings are files in a folder. |
| [API](apps/api) | Epicenter's hosted services: sign-in, paid models, and hosted-only billing, on Cloudflare Workers. |
| [Landing](apps/landing) | The website at epicenter.so. |

### Packages

| Package | What it is |
| --- | --- |
| [`@epicenter/cli`](packages/cli) | The `epicenter` command: runs each app's actions as commands and MCP tools, commits what they write, serves UIs, and backs each app up. |
| [`@epicenter/app`](packages/app) | What an app's `epicenter.ts` imports: `defineApp`, `defineCollection`, `defineAction`, fields, `folder`, and the client a UI calls actions with. |
| [`@epicenter/ui`](packages/ui) | Shared Svelte components. |
| [`@epicenter/ai`](packages/ai) | Every source of models as an endpoint, one OpenAI-compatible client, the agent loop, and the model picker. |
| [`@epicenter/server`](packages/server) | The Hono library `apps/api` composes. |

Whispering's own packages, and the folder sync product's code it still imports
(`@epicenter/folder`, `@epicenter/definition`, `@epicenter/local`), are under
[packages/](packages).

## Architecture

```txt
~/Epicenter                    on the home
  EPICENTER.md                 marks the folder as an Epicenter
  AGENTS.md                    sent to every MCP client as instructions
  apps/<app>/
    epicenter.ts               collections and actions
    ui/                        the UI's source, built into ui/dist/
    data/                      the app's records, a repository of its own

packages/cli                   epicenter: runs actions, serve, snapshots, backup
packages/app                   what epicenter.ts imports
apps/api                       Epicenter's hosted services, an outside app from a home
```

[The vision](docs/vision.md) | [Trust model](docs/trust-model.md)

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

## Design notes

Durable decisions and their reasoning live in [docs/adr/](docs/adr). Specs in [specs/](specs) are in-flight design scaffolding rather than current truth; when a spec and an ADR disagree, the ADR wins. Start with [docs/README.md](docs/README.md).

## Contributing

Contributions are welcome. Good entry points are docs, the `epicenter` command, Svelte interfaces, Whispering, and small changes that make the repo easier to understand.

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
  <sub>Your data outlives the app that wrote it. Open source, on a computer you control, built on plain files, with its history in Git.</sub>
</p>
