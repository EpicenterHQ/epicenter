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
  <a href="#try-the-cli">Try the CLI</a> |
  <a href="#how-it-works">How it works</a> |
  <a href="#status">Status</a> |
  <a href="#trust-boundaries">Trust</a> |
  <a href="#repo-map">Repo map</a> |
  <a href="#development">Development</a> |
  <a href="#license">License</a>
</p>

---

## Try the CLI

Epicenter needs [Bun](https://bun.sh) and Git; an AI account is not required.
Make `~/Epicenter` as
[Make an Epicenter](packages/app/src/command/README.md#make-an-epicenter)
says, then write a one-file notes app and call it from the terminal, as
[Try an app](packages/app/src/command/README.md#try-an-app) shows. This
repository ships no apps, so the first one is yours.

For CLI commands, MCP setup, and keeping `serve` running in the background, see
[the CLI guide](packages/app/src/command/README.md).

## How it works

`~/Epicenter` is on a computer you control and keep on: the
home. It holds a folder per app in `apps/`. Each app has a `code/epicenter.ts`
that declares its data and actions, an optional UI under `code/ui/`,
and a sibling `data/` folder of Markdown files you can read. One private Git
repository holds the home, and you commit code and records together when you choose.

```ts
import { defineAction, defineApp, defineData, field, timeId } from '@epicenter/app';

export default defineApp(({ folder }) => {
  const data = defineData(folder, {
    notes: { description: 'note', fields: { source: field.text({ optional: true }) } },
  });
  const add = defineAction({
    description: 'Save a note',
    input: { body: field.text(), source: field.text({ optional: true }) },
    run: ({ body, source }) => data.notes.create(timeId(), { body, source }),
  });
  return {
    description: 'Notes I want to keep',
    data,
    actions: { ...data.notes.actions('list'), add },
  };
});
```

The `epicenter` command runs an app's actions on the home. Actions change files;
Git records them when you commit:

```sh
epicenter notes add '{"body":"Call the bank","source":"Voicemail"}'
epicenter notes list --json
epicenter serve
```

`epicenter serve` offers every app's actions over MCP, and each app's UI at
`/apps/<app>/`, on the home. It listens only there; your private network, such as
Tailscale, brings your other devices in. Nothing syncs and no one signs in:
your phone, your laptop, and your agents reach the one copy on the home, and
keep nothing of their own. The home's optional `origin` is its backup remote.

Software that works without an Epicenter is an outside app: Gmail, Todoist,
Whispering. An inside app brings its data in through actions. Mail pulls a copy
of your mailbox to the home, and an agent changes Gmail only through a proposal
you apply.

[The vision](docs/vision.md) | [The `epicenter` command](packages/app/src/command/README.md) | [What an app imports](packages/app/README.md)

## Status

The CLI developer preview is one package, `@epicenter/app`, which a home
depends on: a home is one Bun workspace, and its `package.json` names the
version it runs. Each app is ordinary editable source.
`serve` is one process; keep it running as you would any program.

The author's inside apps (Capture, Mail, Messages, Reading, Tasks, and Zhongwen)
run on their home, outside this runtime source repository. Each app has
`apps/<app>/code/` and sibling `data/` in the home's one private Git
repository. Its owner commits code and records together; actions make no
commits. App publication copies only code into a separate
history ([ADR-0910](docs/adr/0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md)).

Whispering, an outside app, runs in a browser tab and as a desktop app, and
needs no Epicenter. The hosted API is retired for now
([ADR-0970](docs/adr/0970-the-hosted-api-is-retired.md)).

The folder sync product that came before is retired
([ADR-0899](docs/adr/0899-the-folder-sync-product-is-retired.md)). Some of its
code stays here while Whispering imports it.

## Trust boundaries

Your data is on the home, and whoever can read the home can read it.

| Where | Who can read it |
| --- | --- |
| A home you own | You, and whatever you let reach it: devices on your tailnet, agents you give a shell. |
| A home you rent | You and its provider, which can read the disk, sign-in files in `local/` included. |
| Your other devices | Only what a UI or agent fetches while it reaches the home. They keep no copy. |
| The home's private `origin` backup | Whoever hosts the backup repository can read all included apps and records. Nothing is pushed until you add an origin. |
| A service an inside app pulls from | The service already holds that data. Mail's Google sign-in is a file in Mail's `local/` on the home, and never leaves it. |

`serve` signs no one in and listens only on the home, so which other devices
reach it is your private network's decision. See the
[trust model](docs/trust-model.md) for the details.

## Repo map

### Apps

Applications under `apps/` are outside apps
([apps/README.md](apps/README.md)).

| App | What it is |
| --- | --- |
| [Whispering](apps/whispering) | Voice recorder and speech-to-text, in a browser tab or as a desktop app. Recordings, transcripts, and settings are files in a folder. |
| [Landing](apps/landing) | The website at epicenter.so. |

### Packages

| Package | What it is |
| --- | --- |
| [`@epicenter/app`](packages/app) | What an app's `epicenter.ts` imports (`defineApp`, `defineData`, `defineAction`, fields, `folderOnDisk`), the client a UI calls actions with, and the `epicenter` command, which runs each app's actions as commands and MCP tools and serves UIs. A home depends on it and runs it with Bun. Git stores the home, one private root repository, and the command does not wrap it. Published. |
| [`@epicenter/ui`](packages/ui) | Shared Svelte components. |
| [`@epicenter/ai`](packages/ai) | Whispering's transcription models: every source of models as an endpoint, one OpenAI-compatible transcription client, and the model picker. |

Whispering's own packages are under
[apps/whispering/packages/](apps/whispering/packages).

## Architecture

```txt
~/Epicenter                    on the home
  EPICENTER.md                 marks the folder as an Epicenter
  AGENTS.md                    sent to every MCP client as instructions
  apps/<app>/
    code/epicenter.ts          data and actions
    code/ui/                   the UI's source, built into code/ui/dist/
    data/                      the app's records in the private root history

packages/app                   what epicenter.ts imports
packages/app/src/command       epicenter: runs actions, serve, check
```

[The vision](docs/vision.md) | [Trust model](docs/trust-model.md)

## Development

Use Bun in this repo.

```bash
git clone https://github.com/EpicenterHQ/epicenter.git
cd epicenter
bun install
```

Every app starts from the repo root. `bun dev:<app>` runs that app's dev server, and `bun run` with no arguments lists every target.

| Command | Starts | App port |
| --- | --- | --- |
| `bun dev:whispering` | Whispering in a browser tab | 1420 |
| `bun dev:landing` | Landing site | 4321 |

Rust is needed for Whispering's desktop build.

`bun run check` is the gate. It runs lint, typecheck, every workspace test, and the structural checks, and it is the same gate CI runs, so a green local run predicts a green pull request. Formatting is handled separately by the autofix workflow.

```bash
bun run check
```

Run the pieces on their own while you work:

```bash
bun run format          # rewrite formatting (CI autofixes this for you)
bun run lint            # fix lint findings
bun run typecheck
bun run test
bun run check          # the whole merge gate: the above plus doc paths, catalog pins, API paths, UI boundary, boot purity, vocabulary
```

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
