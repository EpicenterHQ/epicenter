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
Make `~/Epicenter` as [your Epicenter](packages/app/README.md#an-epicenter) shows: a
`package.json` that names the port, an `epicenter.ts`, and one app. Then run
`epicenter serve` there and call the app from the terminal. This repository
ships no apps, so the first one is yours.

For the command, MCP, and the routes serve answers, see
[the command and serve](packages/app/README.md#the-command-and-serve).

## How it works

`~/Epicenter` is your Epicenter, on a computer you control and keep on. It is one
private Git repository and one program: its root `epicenter.ts` declares the
records and composes the apps. Records are Markdown files you can read in the
root `data/`, each app's code is in `apps/`, and caches are in the root
`local/`, which Git ignores. You commit code and records together when you
choose.

[Your Epicenter](packages/app/README.md#an-epicenter) shows the files and a complete app:
one `epicenter.ts` that declares the records, and one function per app that
returns its actions.

`epicenter serve` imports your Epicenter's program once and runs every action; restart it
after changing code. The `epicenter` command sends each call to it. Actions
change files; Git records them when you commit:

```sh
epicenter serve
epicenter writing add '{"body":"Fares drop in late March"}'
```

`epicenter serve` offers every app's actions over MCP on your computer. It listens
only there; your private network, such as Tailscale, brings your other devices
in. Nothing syncs and no one signs in: your phone, your laptop, and your agents
reach the one copy on your computer, and keep nothing of their own. Your
Epicenter's optional `origin` is its backup remote. Routines and an app's page in a browser
are [not built yet](packages/app/README.md#not-built-yet).

Software that works without an Epicenter is an outside app: Gmail, Todoist,
Whispering. An inside app brings its data in through actions. The author's
Mail app pulls a copy of your mailbox to your computer, and an agent changes Gmail
only through a proposal you apply.

[The vision](docs/vision.md) | [What your Epicenter imports, and the `epicenter` command](packages/app/README.md)

## Status

The CLI developer preview is one package, `@epicenter/app`, which your Epicenter
depends on: an Epicenter is one Bun workspace, and its `package.json` names the
version it runs. Each app is ordinary editable source.
`serve` is one process; keep it running as you would any program.

The author's inside apps (Capture, Mail, Messages, Reading, Tasks, and Zhongwen)
run on their computer, outside this runtime source repository. Their code is in
the Epicenter's `apps/` and their records in its root `data/`, in its one
private Git repository. Its owner commits code and records together; actions
make no commits. No command copies an app in or out.

Whispering, an outside app, runs in a browser tab and as a desktop app, and
needs no Epicenter. The hosted API is retired for now.

The folder sync product that came before is retired. Some of its
code stays here while Whispering imports it.

## Trust boundaries

Your data is on your computer, and whoever can read it there can read it.

| Where | Who can read it |
| --- | --- |
| A computer you own | You, and whatever you let reach it: devices on your tailnet, agents you give a shell. |
| A rented computer | You and its provider, which can read the disk, sign-in files in `local/` included. |
| Your other devices | Only what an agent fetches while it reaches your computer. They keep no copy. |
| Your Epicenter's private `origin` backup | Whoever hosts the backup repository can read every committed app and record. Nothing is pushed until you add an origin. |
| A service an inside app pulls from | The service already holds that data. Mail's Google sign-in is a file in your Epicenter's `local/`, and never leaves it. |

`serve` signs no one in and listens only on your computer, so which other devices
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
| [`@epicenter/app`](packages/app) | What your Epicenter's `epicenter.ts` imports (`defineData`, `defineAction`, `defineEpicenter`, fields), the client a page calls actions with, and the `epicenter` command, which serves every action to the command line and MCP. Your Epicenter depends on it and runs it with Bun. Git stores your Epicenter, one private root repository, and the command does not wrap it. Set up to publish; not on npm yet. |
| [`@epicenter/ui`](packages/ui) | Shared Svelte components. |
| [`@epicenter/ai`](packages/ai) | Whispering's transcription models: every source of models as an endpoint, one OpenAI-compatible transcription client, and the model picker. |

Whispering's own packages are under
[apps/whispering/packages/](apps/whispering/packages).

## Architecture

```txt
~/Epicenter                    your Epicenter, on your computer
  package.json                 its "epicenter" key marks the folder and names the port
  epicenter.ts                 the program: data keys, and the apps composed from them
  AGENTS.md                    sent to every MCP client as instructions
  apps/<app>/                  an app's code: a function of your Epicenter's data
  data/<key>/<id>.md           the records, in the private root history
  local/                       caches and sign-ins, ignored by Git

packages/app                   what epicenter.ts imports
packages/app/src/command       epicenter: serve, MCP, and calls to serve
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

Each area's rules live in a `## Decisions` section of its README, beside the code they govern. [docs/history.md](docs/history.md) logs what Epicenter tried, kept, and turned down, and why. The old decision records are in the `adr-archive` Git tag. Specs in [specs/](specs) are in-flight design scaffolding rather than current truth. Start with [docs/README.md](docs/README.md).

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
