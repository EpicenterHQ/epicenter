# 0961. The command sends an action's words to serve, and serve alone reads them

- **Status:** Proposed
- **Date:** 2026-11-18
- **Amends:** [ADR-0936](0936-one-serve-per-home-runs-every-action.md) at what the command does before it sends a call, and at how a call names its Epicenter. The command no longer loads the app, finds the action or checks the input; serve does. Serve no longer stamps its root's path on every answer; the command sends its path on the request. That an action runs only in serve, and that serve refuses a call meant for another Epicenter, are unchanged.
- **Relates:** [ADR-0925](0925-an-actions-input-on-the-command-line-is-one-json-object.md) (the input is one JSON object), [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md) (an input is one JSON Schema), [ADR-0927](0927-serve-listens-only-on-this-computer.md) (serve listens only on this computer), [ADR-0943](0943-epicenters-core-invariants.md) (rule 3: an action is described in plain JSON), [ADR-0956](0956-bare-epicenter-reports-apps-and-routines-and-git-reports-the-repository.md) (bare `epicenter` reads the apps itself), [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) (serve loads each app once), [ADR-0957](0957-home-is-retired-the-folder-is-your-epicenter-and-root-in-code.md) (the header is named `x-epicenter-root`).
- **Unbuilt:** All of it. `packages/cli/src/cli.ts` loads the app, matches the words, reads the input and prints help before it calls serve. Serve has no HTTP request that takes the words as typed or answers an action's help; its only listing is the MCP tool list. Serve still sets `x-epicenter-home` to its root's path on every answer (`HOME_HEADER` in `packages/cli/src/serve-call.ts`, set in `packages/cli/src/http.ts`). The first thing to exist is `GET /` answering the listing as JSON.

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
Epicenter from a header. Serve sets `x-epicenter-home` (`HOME_HEADER` in
`packages/cli/src/serve-call.ts`) to its root's real path on every answer
(`http.ts`), and the command and a second `serve` compare it with their own.
Serve listens only on this computer (ADR-0927), but a phone or laptop reaches
it through the owner's private network, so every device that loads a page or
calls an action is shown a path such as `/Users/<account>/Epicenter`.
ADR-0957 renamed the header and left "a name or a hash" open.

## Decision

**A command that calls or describes an action loads no app code. It sends
the words and the input as typed, and serve answers.**

- **A call.** The command sends the app's name, the words after it, and the
  input. Serve finds the action, checks the input, runs it, and answers. "No
  such action" and "this input does not fit" are answers from serve.
- **Help and listings.** `epicenter <app>`, `--help` on an action, and bare
  `epicenter` ask serve and print its answer.
- **`check` loads apps itself.** It runs in its own process and imports each
  app as it is on disk. That makes it the way to try changed code before a
  restart. No other command loads an app.

**Serve answers one JSON listing, and every view of the apps prints from
it.** `GET /` with `accept: application/json` answers each app's
description, its data keys, its problems and each action as the MCP tool
`serve` offers (`actionTool` in `packages/cli/src/listing.ts`), with the
changed-code fields of ADR-0959.

| Reader | What it prints from the listing |
| --- | --- |
| MCP `tools/list` | each action not marked `mcp: false` |
| the launcher page, `GET /` as HTML | each app with a UI |
| bare `epicenter` and `epicenter --json` | every app and its problems |
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
- Serve sets `x-epicenter: 1` on every answer and no path. A caller tells
  an Epicenter's serve from another program by that header alone.
- A second `serve` whose port is taken probes the same way: `OPTIONS /` with
  its own `x-epicenter-root`. A `409` means another Epicenter's serve holds
  the port, any other answer with `x-epicenter: 1` means its own serve is
  already running, and an answer without it means another program.

## Consequences

- The command and serve cannot disagree about an app, because only serve has
  loaded it.
- Listing apps and reading help need serve running. With serve stopped, the
  command says so, as it does for a call today.
- Bare `epicenter` reports what serve loaded, not what is on disk. An app
  added since serve started appears after a restart.
- The command no longer imports `@epicenter/app` to read an app. It still
  shares the answer shape with serve.
- The MCP tool list, the launcher, the listing and help cannot disagree,
  because they print one answer.
- No device on the private network learns the account name from a header.
  A command or serve from another Epicenter learns only that the port is
  taken by an Epicenter that is not its own.
- `whoAnswers` and `sendToServe` in `serve-call.ts` read `x-epicenter` and
  the status, not a path; `homeName` is used only to build the request
  header.
- Deleted from `cli.ts`: the load, the match, the input read and the help
  printing for an app. Those move behind serve's requests; the code that
  matches words and checks input stays, in serve.
- ADR-0956 is `Proposed` and says bare `epicenter` reads the apps itself. It
  is edited to match when this decision lands, not amended.

## Considered alternatives

- **Keep the command's own load.** Help and listings work with serve
  stopped. Two loads can disagree once serve loads at start.
- **Keep the command's load, and warn when the files are newer than serve.**
  Serve states when it loaded each app and the command compares. It reports
  the disagreement and keeps the second load that causes it. ADR-0959's
  changed-code line reports the same fact from serve, with no second load.
- **A listing per reader.** Each of the four readers builds its own view
  from the loaded apps, as `mcp.ts`, `http.ts` and `listing.ts` do today.
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
