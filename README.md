<p align="center">
  <a href="https://epicenter.so">
    <img width="200" src="https://github.com/user-attachments/assets/9e210c52-2740-43b6-af3f-e6eaf4b5c397" alt="Epicenter">
  </a>
  <h1 align="center">Epicenter</h1>
  <p align="center"><strong>Where one person's software lives.</strong></p>
  <p align="center">Bring the parts of your life you want to keep into one folder on a computer you control. Use your own apps from your devices and agents, and keep the work in files you can take with you.</p>
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
Make `~/Epicenter` as [your Epicenter](packages/app/README.md#a-home) shows: a
`package.json` that names the port, an `epicenter.ts`, and one app. Then run
`epicenter serve` there and call the app from the terminal. This repository
ships no apps, so the first one is yours.

For the command, MCP, and the routes serve answers, see
[the command and serve](packages/app/README.md#the-command-and-serve).

## How it works

`~/Epicenter` is your Epicenter, on a computer you control and keep on. It is one
private Git repository and one program. The root `epicenter.ts` declares the
file-backed records and composes the apps, whose code lives in `apps/`. See
[where edits count](docs/vision.md#where-edits-count) for live records, exports,
and backups.

[Your Epicenter](packages/app/README.md#a-home) shows the files and a complete app:
one `epicenter.ts` that declares the records, and one function per app that
returns its actions.

`epicenter serve` imports your Epicenter's program once and runs every action; restart it
after changing code. The `epicenter` command sends each call to it.

```sh
epicenter serve
epicenter writing add '{"body":"Fares drop in late March"}'
```

`epicenter serve` offers actions over MCP and HTTP on your computer. Your
private network, such as Tailscale, brings your other devices in. Your
Epicenter can [schedule action calls](packages/app/README.md#scheduled-actions)
while `serve` is running.

An app is code in your Epicenter. Software that works without one is a
program, such as Whispering, or a service, such as Gmail or Todoist. An app
can work with their data through actions.

[The vision](docs/vision.md) | [What your Epicenter imports, and the `epicenter` command](packages/app/README.md)

## Status

The CLI developer preview is one package, `@epicenter/app`, which your Epicenter
depends on: an Epicenter is one Bun workspace, and its `package.json` names the
version it runs. Each app is ordinary editable source.
`serve` is one process; keep it running as you would any program.

The author's apps (including Capture, Mail, Messages, Notes, Tasks,
and Zhongwen) run in their own Epicenter, outside this runtime repository.

Whispering, a program, runs in a browser tab and as a desktop app, and
needs no Epicenter. The hosted API is retired for now.

The folder sync product that came before is retired. Some of its
code stays here while Whispering imports it.

Anyone who can reach your Epicenter's computer can do everything in it.
[Who can read your files](docs/vision.md#who-can-read-your-files) says what
that means for teams, rented computers, and backups.

## Repo map

### Apps

Applications under `apps/` are programs that work without an Epicenter.

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
  AGENTS.md                    instructions for agents working in the folder
  apps/<app>/                  an app's code: a function of your Epicenter's data
  data/<key>/<id>.md           the records, in the private root history
  .epicenter/                  this computer's caches, sign-ins and app state, ignored by Git

packages/app                   what epicenter.ts imports
packages/app/src/command       epicenter: serve, MCP, and calls to serve
```

[The vision](docs/vision.md)

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
bun run check          # the whole merge gate: the above plus unused code (knip), doc paths, catalog pins, UI boundary, boot purity
```

## Design notes

Each area's rules live in a `## Decisions` section of its README, beside the code they govern. [docs/history.md](docs/history.md) logs what Epicenter tried, kept, and turned down, and why. The old decision records are in the `adr-archive` Git tag. Specs in [specs/](specs) are in-flight design scaffolding rather than current truth. Start with [the vision](docs/vision.md).

## Contributing

Contributions are welcome. Good entry points are docs, the `epicenter` command, Svelte interfaces, Whispering, and small changes that make the repo easier to understand.

[Read the Contributing Guide](CONTRIBUTING.md)

Contributors coordinate in [Discord](https://go.epicenter.so/discord).

## License

Epicenter is free and open source under the
[AGPL-3.0-or-later](licenses/LICENSE-AGPL-3.0). Use it, change it, and run it
for yourself however you like. If you share it with others, whether you give it
away, sell it, or run it as a service for them, you share your source under the
same license, so improvements come back to everyone. Contributions come in
under that license too, with no CLA. Versions published under MIT before
2026-08 stay MIT for those versions ([LICENSE](LICENSE)).

If you or your team want a hand setting it up or building your apps, I offer
paid support, and that's how the project keeps going. Get in touch below.

---

<p align="center">
  <strong>Contact:</strong> <a href="mailto:github@bradenwong.com">github@bradenwong.com</a> | <a href="https://go.epicenter.so/discord">Discord</a> | <a href="https://twitter.com/braden_wong_">@braden_wong_</a>
</p>

<p align="center">
  <sub>Your data outlives the app that wrote it. Open source, on a computer you control, built on plain files, with its history in Git.</sub>
</p>
