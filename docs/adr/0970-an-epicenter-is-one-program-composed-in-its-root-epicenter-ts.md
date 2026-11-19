# 0970. An Epicenter is one program, composed in its root `epicenter.ts`

- **Status:** Proposed
- **Date:** 2026-11-18
- **Supersedes:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md): an app is no longer a folder serve discovers; it is a function the root `epicenter.ts` calls.
- **Supersedes:** [ADR-0935](0935-a-keys-generated-actions-are-its-handles-verbs-named-by-the-app.md): a data key generates no actions; every action is written with `defineAction`.
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) at its layout: `apps/<app>/code/`, `apps/<app>/data/` and `apps/<app>/local/` become `apps/<app>/`, the home's `data/` and the home's `local/`. One private repository, checkpoints and recovery stay.
- **Amends:** [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) and [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md) at whose `data/`: records live under the home's `data/`. A write outside `data/` is still refused.
- **Amends:** [ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md) at "a file in `routines/`": when routines return, a routine is an entry in `epicenter.ts` naming an action and its input.
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) at `"workspaces": ["apps/*/code"]`: the home's `package.json` names every app's dependencies, and only a package that needs isolated dependencies keeps a workspace.
- **Amends:** [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) at "each app inside its own guard": serve imports one module, and the whole program loads or none of it does.
- **Relates:** [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md), [ADR-0965](0965-the-command-finds-its-epicenter-by-walking-up-and-serve-starts-in-its-folder.md), [ADR-0944](0944-an-app-builds-its-own-ui-and-serve-only-serves-it.md) and [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (Proposed; each is edited to match when 0970 is accepted), [ADR-0945](0945-an-app-may-answer-web-requests-at-its-address-with-fetch.md) (`fetch` returns later), [ADR-0967](0967-serve-keeps-action-calls-outside-an-apps-address-which-is-apps-name.md) (the action route stays), [ADR-0968](0968-each-thing-is-checked-once-where-it-can-change-and-epicenter-check-is-deleted.md) (no `epicenter check` returns).
- **Unbuilt:** all of it. `@epicenter/app` exports no `defineEpicenter`, `defineData` takes a `Folder` rather than a path, and serve discovers `apps/*/code/epicenter.ts` in `packages/app/src/command/apps.ts`.

## Context

An Epicenter today is a folder of app containers. Serve reads `apps/`, and
each folder there is an app named by the folder, whose `code/epicenter.ts`
default-exports `defineApp(({ folder }) => ...)`. The app's records sit
beside its code, and each data key generates actions an app spreads into
its own (`...data.watches.actions('list', 'get')`, ADR-0935):

```txt
~/Epicenter/
  EPICENTER.md            marker; front matter holds `port: 4747`
  AGENTS.md  package.json  bun.lock
  routines/
    flights-daily-research.md
  apps/
    flights/
      code/epicenter.ts   defineData(folder, { watches, checks })
      data/watches/  data/checks/
      local/settings.md  local/flighty.json
    writing/
      code/  data/notes/  local/
```

Every record belongs to the app whose container holds it. Three cases did
not fit:

- **Files with no app.** 415 articles moved out of this repository
  (PR #2734) had nowhere to go except `apps/docs-inbox/`, an app whose
  `epicenter.ts` declares no data key and no action.
- **Files two apps want.** A review that reads `notes` and `books` reaches
  into two other containers, and nothing states what shape it expects.
- **Files that outlive an app.** Deleting `apps/<app>` deletes its records
  (ADR-0910, Consequences).

The containers isolate apps as if each were written by a stranger. In a
home, the owner and their agents write all of the code, and
`bun run typecheck` can check the agreement between apps. ADR-0910
rejected "apps as direct root children" and "data inside code"; it did
not consider records at the top of the home beside `apps/`.

## Decision

**An Epicenter is one program. Its root `epicenter.ts` opens the home's
records once as `data` and passes `data` to every app; serve imports that
one module.**

```txt
~/Epicenter/
  package.json            "epicenter": { "port": 4747 }; this file is the marker
  epicenter.ts            the program serve imports
  AGENTS.md  bun.lock  .env
  data/                   the person's records, plain Markdown
    watches/  checks/  notes/  articles/
  apps/                   code only
    flights/  index.ts
    writing/  index.ts
  local/                  this computer only, ignored by Git
```

```ts
// ~/Epicenter/epicenter.ts
import { defineData, defineEpicenter, field } from '@epicenter/app';
import { flights } from './apps/flights';
import { writing } from './apps/writing';

export const data = defineData(import.meta.dir, {
  watches: { description: 'trip idea', fields: { /* ... */ } },
  checks:  { description: 'research result', fields: { watch: field.ref('watches') } },
  notes:   { description: 'writing note', fields: { /* ... */ } },
});
export type Data = typeof data;

export default defineEpicenter({
  apps: { flights: flights(data), writing: writing(data) },
});
```

```ts
// ~/Epicenter/apps/flights/index.ts
import { defineAction, field } from '@epicenter/app';
import type { Data } from '../../epicenter';

export function flights({ watches, checks }: Data) {
  const ideas = defineAction({
    description: 'Every trip idea, with its latest research',
    input: {},
    run: async () => { /* watches.list() joined with checks.list() */ },
  });
  const idea = defineAction({
    description: 'One trip idea',
    input: { id: field.text() },
    run: ({ id }) => watches.get(id),
  });
  const daily = defineAction({
    description: 'Research due trip ideas',
    input: { recheck: field.boolean({ optional: true }) },
    run: async ({ recheck = false }) => { /* reads watches, writes checks */ },
  });
  return { description: 'Trip ideas and daily fare research', actions: { ideas, idea, daily } };
}
```

- **The marker** is the first `package.json`, walking up, with an
  `"epicenter"` key. The command reads `port` from it without importing
  app code. `EPICENTER.md` is deleted.
- **`data`** is a typed handle over the folders under `data/`:
  `defineData(import.meta.dir, spec)` gives one handle per key, with
  `list`, `get`, `create`, `patch`, `edit` and `delete`, and does no file
  IO until a method is called. `data.watches` reads and writes
  `data/watches/<id>.md`. One call defines every key, so a `field.ref` may
  name any key. A handle generates no actions.
- **An app** is a function of `Data` returning `{ description, actions }`.
  It destructures the keys it uses. `bun run typecheck` fails when it uses
  a field its key lacks. An app's name is its key in `apps`: the command
  word (`epicenter flights daily`), the MCP tool prefix (`flights_daily`)
  and the route (`/actions/flights/daily`). `defineEpicenter` refuses a
  name that is not lowercase letters, digits and dashes, and refuses
  `serve`. A folder under `apps/` that `epicenter.ts` does not call does
  not run.
- **Every action is written with `defineAction`.** Nothing is reachable
  from the command, MCP or a page unless an action exposes it. Code shared
  by two apps is an ordinary exported function that takes `Data`, and a
  rule every caller must follow lives in that function.
- **`.env`** holds secrets and this computer's settings, read through
  `process.env`. **`local/`** holds caches an app can rebuild, as plain
  files. The root `.gitignore` lists `/local/`.
- **Serve** walks up to the marker, reads the port, imports `epicenter.ts`
  once, and listens on loopback. Every request passes the guards (tunnel,
  Host, Origin, `Sec-Fetch-Site`) and then reaches one of three routes:
  - `POST /actions/<app>/<action>` checks the input, runs the action, and
    answers JSON lines: `{"update": ...}` for each update, then
    `{"answer": {data, error}}`.
  - `POST /` is MCP, with one tool per action.
  - `GET /actions/` lists every app, action, description and input schema.

  A module that throws, or a `defineEpicenter` that refuses what it was
  given, leaves serve answering that one problem with no apps.
- **The command** runs no app code. `epicenter <app> <action> [input]`
  posts to serve and prints the answer, and `epicenter` prints the
  listing.
- **`connect<typeof home>()`** from `@epicenter/app/client`, where `home`
  is `epicenter.ts`'s default export imported as a type, gives a page one
  function per action at `epicenter.<app>.<action>(input, { onUpdate })`.
  Each posts to `/actions/<app>/<action>` and resolves to a Wellcrafted
  Result.
- **Restart.** The home's `AGENTS.md` restart command runs
  `bun run typecheck && bun -e "await import('./epicenter.ts')"` and stops
  serve only when both succeed.
- **Tests** rebind data to a temporary folder:
  `defineData(tmp, data)` takes an existing `data` as its spec and must
  include every key its refs name. A test calls the app function with the
  rebound handles.

### Later additions

Each is added when the first app needs it, in this shape:

| Field | Shape | Added when |
| --- | --- | --- |
| `routines` on `defineEpicenter` | `{ '<name>': { cron, action, input } }`; serve checks once a minute and runs a due routine through the action route's runner, so it is logged and listed | flights' daily research moves over |
| `ui` on an app | a folder path; serve answers a `GET` under `/apps/<app>/` with a file from it, refusing dot names and anything that resolves outside it | the first rebuilt app has a page |
| `fetch` on an app | a web-standard `(Request) => Response`; serve strips `/apps/<app>`, replaces `X-Forwarded-Prefix`, and calls it for what `ui` does not answer | an app needs OAuth, a feed or a webhook |

## Consequences

- Deleted from `@epicenter/app`: app discovery and the per-app load guard
  in `command/apps.ts`, `defineApp`, a key's generated actions
  (`data-actions.ts` and `actions(...)` on a handle), routine files in
  `command/routines.ts`, reading `EPICENTER.md` in `command/root.ts`, and
  `uiFile` in `command/serve.ts` until `ui` returns. `folderOnDisk` stays
  internal to `defineData`.
- Added: `defineEpicenter`, `defineData` taking a path, and `connect`
  typed by the home with property access.
- A file with no app is a folder in `data/`, reachable by an agent on the
  computer and by nothing remote until an action reads it.
- Every operation a page, the command or an agent can call is an action
  someone wrote with its own description. Exposing a record operation
  costs about four lines.
- Deleting an app is deleting `apps/<app>/` and its line in
  `epicenter.ts`; its records stay.
- One broken import or one throwing definition stops every app, and every
  test that imports the root. The restart command catches both before the
  running serve stops.
- An app is not self-contained: its type names one home's `Data`. Copying
  it cannot copy records. Installing it is its folder and one line in
  `epicenter.ts`.
- Migrating the person's home takes several days, with flights and vault
  last: eleven apps become functions of `Data`, each writes the actions it
  used to generate, about forty tests rebind their data, `local/` files
  move under `local/<app>/` or into `.env`, and vault's folder tree moves
  under `data/vault/`, which separates its `tasks/` from the tasks app's.

## Considered alternatives

- **Records under each app (today).** Files with no app, or with two, have
  no place.
- **A top-level `data/` with each app declaring what it writes, and serve
  refusing two writers.** A runtime rule for code one person owns.
- **Data keys in `data.ts`, apps still discovered under `apps/`.** Two
  places say what runs.
- **Each app passed only the keys it uses (`Pick<Data, ...>`).** Wiring in
  `epicenter.ts` that the app's own destructuring already states.
- **Generated record verbs, per app (`watches.actions(...)`) or for every
  key at the home (`epicenter watches list`).** A second way to make an
  action, a reserved name or a second route, and generic tool descriptions
  for agents.
- **Passing apps a folder handle.** Secrets fit `.env`, and caches fit
  plain files under `local/`.
- **Passing one app another app's action.** A shared function carries the
  rule, and a direct action call skips the input check serve makes.
- **The port in `epicenter.ts`.** Every command would import every app to
  find serve.
- **A routine as a closure.** Serve could not name its action, log its
  run, or list it.
- **The data definitions written as JSON.** An imported JSON file widens
  `select` values to `string` and loses optional fields, so the handles
  lose their types.
- **Hono RPC or Elysia Eden as the page client.** Their types come from a
  route chain, and actions are one generic route; both answer a
  `Response`, losing the Result and the update stream.
- **Routines as crontab or launchd jobs.** The schedule leaves the home's
  history and needs setting up on each computer.
