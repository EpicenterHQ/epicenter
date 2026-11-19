# 0961. The command sends an action's input to serve, and serve alone reads it

- **Status:** Accepted
- **Date:** 2026-11-18
- **Amends:** [ADR-0936](0936-one-serve-per-home-runs-every-action.md) at what the command does before it sends a call, and at how a call names its Epicenter. The command no longer loads the app or checks the input; it names the action by its words and sends the input as typed, and serve reads it. Serve no longer stamps its root's path on every answer; the command sends its path on the request. That an action runs only in serve, and that serve refuses a call meant for another Epicenter, are unchanged.
- **Relates:** [ADR-0925](0925-an-actions-input-on-the-command-line-is-one-json-object.md) (the input is one JSON object), [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md) (an input is one JSON Schema), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (serve listens only on this computer), [ADR-0943](0943-epicenters-core-invariants.md) (rule 3: an action is described in plain JSON), [ADR-0956](0956-bare-epicenter-reports-apps-and-routines-and-git-reports-the-repository.md) (bare `epicenter` reads the apps itself), [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) (serve loads each app once), [ADR-0957](0957-home-is-retired-the-folder-is-your-epicenter-and-root-in-code.md) (the header is named `x-epicenter-root`).
- **Built:** `send.ts`, `serve.ts` and `cli.ts` in `packages/app/src/command`.
- **Amends:** [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) and [ADR-0927](0927-serve-listens-only-on-this-computer.md) at the port: `EPICENTER.md` must name `port`, and no port is assumed. See "The port is required" below.
- **Amended:** 2026-11-18: serve has no page at `/`, and `NotStarted` is `{ message, next? }`. See the two amendments below.
- **Amends:** [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md) at `NotStarted`'s causes.

## Context

`epicenter reading log '{"minutes":30}'` loads the app twice. The command
imports the Reading app's `code/epicenter.ts`, finds the action its words name,
checks the input, and prints help or a usage error. Then it sends the call to
serve, which loads the app and checks the input again (ADR-0936).

Two processes decide the same thing from two loads of the code. Under
ADR-0959 those loads differ after any edit: the command reads the files as
they are, and serve runs what it loaded at start. The command could accept an
input that serve refuses, or list an action serve does not have.

Rule 3 of ADR-0943 says an action is described in plain JSON. A program
that can read JSON needs none of the app's code to list actions or show an
input.

The command finds out whether the serve on its port belongs to its own
Epicenter from a header. Serve sets `x-epicenter-home` (`HOME_HEADER`) to
its root's real path on every answer (`serve.ts`), and the command and a
second `serve` compare it with their own.
Serve listens only on this computer (ADR-0927), but a phone or laptop reaches
it through the owner's private network, so every device that loads a page or
calls an action is shown a path such as `/Users/<account>/Epicenter`.
ADR-0957 renamed the header and left "a name or a hash" open.

## Decision

**A command that calls or describes an action loads no app code. It names
the action by its words and sends the input as typed, and serve alone reads
the input.**

- **A call.** The command reads its words without loading anything. An
  action has one name (ADR-0967), so the word after the app is the action,
  and after it comes at most one word, the input: `{...}`, or `-` to read it
  from stdin. More than one word after the action is refused by the
  command. It calls `POST /actions/<app>/<action>`, the request a page
  makes, with the input's text as the body: the typed text, stdin's text for `-`, or `{}`
  when there is none. Serve finds the action, reads and checks the input,
  runs it, and answers. "No such action" and "this input does not fit" are
  answers from serve, the same to a page, an agent and the command. They
  state the fact, and `next` may name a command to run, such as
  `epicenter <app>`. The command adds the terminal help: under "no such action" it lists the app's actions from the
  listing.
- **Help and listings.** `epicenter <app>`, `--help` on an action, and bare
  `epicenter` print from serve's listing. `--help` on an action the listing
  does not have answers as the command does for a call to one.
- **No command loads an app.** `check` once did, in its own process;
  ADR-0968 deleted it.

**Serve answers one JSON listing, and every view of the apps prints from
it.** `GET /actions/` (ADR-0967) answers each app's
description, its data keys, its problems and each action as the MCP tool
`serve` offers (`appListing` in `packages/app/src/command/apps.ts`).

| Reader | What it prints from the listing |
| --- | --- |
| MCP `tools/list` | each action not marked `mcp: false` |
| bare `epicenter` and `epicenter --json` | every app, its problems, and the routines |
| `epicenter <app>` and `--help` on an action | one app, or one action and its input |

**The command names its Epicenter on the request, and serve's answers name
none.**

- The command sends `x-epicenter-root` with its root's real path,
  percent-encoded, on every request it makes. The request goes to
  `127.0.0.1`, so the path never leaves the computer.
- Serve compares that header, when present, with its own root. When they
  differ it answers `409` with the body `This call is for another
  Epicenter`, which does not name its root. A request without the header,
  from a page or an MCP client, is not compared.
- That `409` is the one way the command and serve tell Epicenters apart.
  The command's refusal for it names the folder it took for its Epicenter
  and that folder's `EPICENTER.md`, which shows a stray marker below the
  real one. Any other answer that is not serve's is `Unreachable` with its
  status. A second `serve` probes nothing: it cannot bind a port in use, and
  says the port is in use and where to set another. Serve once set
  `x-epicenter: 1` on every answer so a caller could tell its own serve, an
  older serve and another program apart; the owner removed that, the
  probes and the command's own size check (ADR-0959).
- An app's and a routine's problems are made once, when serve starts, and
  a path inside the Epicenter in them is written from its folder, such as
  `apps/<app>/code/x.ts`. Nothing else is rewritten: an action's own error
  message reaches its caller as the action wrote it, absolute paths
  included. The owner accepted that a message can show a path of this
  computer to the owner's own devices (ADR-0959).

## Consequences

- The command and serve cannot disagree about an app, because only serve has
  loaded it.
- Listing apps and reading help need serve running. With serve stopped, the
  command says so, as it does for a call today.
- Bare `epicenter` reports what serve loaded, not what is on disk. An app
  added since serve started appears after a restart.
- The command no longer imports `@epicenter/app` to read an app. It still
  shares the answer shape with serve.
- The MCP tool list, the listing and help cannot disagree,
  because they print one answer.
- No device on the private network learns the account name from a header.
  A command or serve from another Epicenter learns only that the port is
  taken by an Epicenter that is not its own.
- `reach` in `send.ts` reads the status, not a path; `rootHeaderValue`
  builds the request header.
- Deleted from `cli.ts`: the load, the input read and the help built from a
  loaded app. Serve has two ways in for an action, a call at
  `POST /actions/<app>/<action>` and MCP at `POST /`, and no request that
  takes a command's words.
- Stdin is the input and never a word, so text read for `-` cannot name an
  action.
- A word typed where the input goes is the input: `epicenter tasks add
  hello` answers that the input is not JSON.
- ADR-0956 is `Proposed` and says bare `epicenter` reads the apps itself. It
  is edited to match when this decision lands, not amended.

## Considered alternatives

- **Send the words as typed, and let serve match them.** The first build
  had `POST /<app>` take `{"words": [...]}` and match the longest run of
  them that names an action, with a `help` flag for an action's tool. It
  was a second request shape beside a page's, help could come from the
  listing instead, and the command put stdin's text among the words, so
  `printf all | epicenter notes archive -` ran `archive all`. Splitting
  needs no app loaded, because an action's words are names and an input
  never is.
- **Keep the command's own load.** Help and listings work with serve
  stopped. Two loads can disagree once serve loads at start.
- **Keep the command's load, and warn when the files are newer than serve.**
  Serve states when it loaded each app and the command compares. It reports
  the disagreement and keeps the second load that causes it. ADR-0959's
  changed-code line reports the same fact from serve, with no second load.
- **A listing per reader.** Each of the four readers builds its own view
  from the loaded apps, as `mcp.ts`, `serve.ts` and `listing.ts` did.
  Four builders can drift apart.
- **Stamp a hash of the root's path on each answer.** It hides the account
  name, but every device can still compare two Epicenters, and the command
  still needs the hash of its own path. Sending the path on a loopback
  request hides it from every device and needs no hash.
- **Stamp a name from `EPICENTER.md`.** A second setting beside the port,
  and two Epicenters given one name would accept each other's calls.
- **Let the command run an action when serve is down.** ADR-0936 and
  ADR-0943 refuse a second action runner.
- **No command for actions: use `curl` or MCP.** A call is one HTTP request.
  The command still earns its place by finding the port, naming the root so
  another Epicenter's serve refuses the call, and printing updates and the
  answer in the forms people and agents read.

## Amendment: the port is required

2026-11-18. The port is how a command finds its Epicenter's serve and the
only thing that tells two Epicenters on one computer apart. A default of 4747
let two markers with no `port` share one serve, which the 409 then had to
explain. `EPICENTER.md` must name `port`, a whole number from 1 to 65535; a
marker without one is refused by serve and by every command, naming the
file: `port is missing; name one in front matter, a line such as port: 4747
between two --- lines`.

## Amendment: serve has no page at `/`

The launcher page at `GET /` listed each app with a built
`code/ui/dist/index.html`, with its icon and description. Each view read
the disk once per app to find those files. The owner removed it: three
places already say what an Epicenter has.

- `epicenter` prints the listing, and `epicenter --json` gives it as JSON.
- `GET /actions/` is the listing as JSON.
- An app's page is at `/apps/<app>/`.

`/` answers only MCP's `POST`. Any other method gets 405 with
`Allow: POST`, as `/actions/<app>/<action>` does for a method other than
`POST`. MCP's `GET` for a server-sent stream already got 405, since serve
keeps no MCP session. Nothing redirects from `/`, and no page replaces it.
A bookmark of the root address now gets 405; bookmark an app's
`/apps/<app>/` instead. The launcher can be re-added from the listing.

## Amendment: `NotStarted` is `{ message, next? }`

ADR-0953 gave `NotStarted` four causes, `usage`, `app-problems`,
`internal` and `unavailable`, each with its own fields: `next` for `usage`
and `unavailable`, `app` and `problems` for `app-problems`. With the
command reading serve's answer instead of building its own, nothing read
them. The exit code reads only the name. The command and pages print
`message` and `next`. The only reader of `cause` was `checkAnswer`, which
checked each cause's fields and nothing else. The owner removed them.

- `ActionError.NotStarted` takes `{ message, next? }`. `NotStartedCause`
  is deleted.
- An app that does not load is refused with its name, then each problem on
  its own line, in `message`.
- `checkAnswer` checks that `next`, when present, is text.

"Did it begin?" is still one comparison, `name === 'NotStarted'`, and a
retry still waits on what the message names. A caller that must tell one
kind from another reads what it already has: a refused connection is the
command's own failed request, and a call to serve gets the same message a
person reads. A cause can be re-added when a reader branches on one.
`ActionError.Changed` keeps its own `cause`; it is a different error.

