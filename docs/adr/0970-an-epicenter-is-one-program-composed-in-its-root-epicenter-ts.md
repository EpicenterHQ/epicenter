# 0970. An Epicenter is one program, composed in its root `epicenter.ts`

- **Status:** Proposed
- **Date:** 2026-11-18
- **Supersedes:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md): an app is no longer a folder serve discovers; it is a function the root `epicenter.ts` calls.
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) at its layout: `apps/<app>/code/`, `apps/<app>/data/` and `apps/<app>/local/` become `apps/<app>/`, the home's `data/` and the home's `local/<app>/`. One private repository, checkpoints and recovery stay.
- **Amends:** [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) and [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md) at whose `data/`: records live under the home's `data/`. A write outside `data/` is still refused.
- **Amends:** [ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md) at "a file in `routines/`": a routine is an entry in `epicenter.ts` naming an action and its input. The cron expression, `Bun.cron.parse` and serve's once-a-minute check stay.
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) at `"workspaces": ["apps/*/code"]`: the home's `package.json` names every app's dependencies, and only a package that needs isolated dependencies keeps a workspace.
- **Amends:** [ADR-0945](0945-an-app-may-answer-web-requests-at-its-address-with-fetch.md) at "the request arrives as the browser sent it": serve strips `/apps/<app>` and sets `X-Forwarded-Prefix`.
- **Amends:** [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) at "each app inside its own guard": serve imports one module, and the whole program loads or none of it does.
- **Relates:** [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md), [ADR-0965](0965-the-command-finds-its-epicenter-by-walking-up-and-serve-starts-in-its-folder.md) and [ADR-0944](0944-an-app-builds-its-own-ui-and-serve-only-serves-it.md) (Proposed; each is edited for the marker and for `ui(dir)` when 0970 is accepted), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (Proposed; an app becomes a function of the handles it is passed), [ADR-0968](0968-each-thing-is-checked-once-where-it-can-change-and-epicenter-check-is-deleted.md) (no `epicenter check` returns).
- **Unbuilt:** all of it. `@epicenter/app` exports no `defineEpicenter` or `ui`, and serve discovers `apps/*/code/epicenter.ts` in `packages/app/src/command/apps.ts`.

## Context

An Epicenter today is a folder of app containers. Serve reads `apps/`, and
each folder there is an app named by the folder, whose `code/epicenter.ts`
default-exports `defineApp(({ folder }) => ...)`. The app's records sit
beside its code:

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

**An Epicenter is one program. Its root `epicenter.ts` defines every data
key once, calls every app with the handles it needs, and names every
routine; serve imports that one module.**

```txt
~/Epicenter/
  package.json            "epicenter": { "port": 4747 }; this file is the marker
  epicenter.ts            the program serve imports
  AGENTS.md  bun.lock
  data/                   the person's records, plain Markdown
    watches/  checks/  notes/  articles/
  apps/                   code only
    flights/  index.ts  ui/
    writing/  index.ts  ui/
  local/                  this computer only, ignored by Git
    flights/  settings.md  flighty.json
```

```ts
// ~/Epicenter/epicenter.ts
import { defineData, defineEpicenter, field, folderOnDisk } from '@epicenter/app';
import { flights } from './apps/flights';
import { writing } from './apps/writing';

const home = folderOnDisk(import.meta.dir);

export const data = defineData(home, {
  watches: { description: 'trip idea (watch)', fields: { /* ... */ } },
  checks:  { description: 'dated research result', fields: { watch: field.ref('watches'), /* ... */ } },
  notes:   { description: 'writing note', fields: { /* ... */ } },
});
export type Data = typeof data;

const writingApp = writing({ notes: data.notes });
const flightsApp = flights({
  watches: data.watches,
  checks: data.checks,
  folder: home,                     // for local/flights/settings.md and flighty.json
  saveNote: writingApp.actions.add,
});

export default defineEpicenter({
  data,
  apps: { flights: flightsApp, writing: writingApp },
  routines: {
    'flights-daily-research': {
      cron: '0 8 * * *',
      action: flightsApp.actions.daily,
      input: { recheck: false },
    },
  },
});
```

```ts
// ~/Epicenter/apps/flights/index.ts
import { join } from 'node:path';
import { defineAction, field, ui, type Folder } from '@epicenter/app';
import { Hono } from 'hono';
import type { Data } from '../../epicenter';
import type { writing } from '../writing';

type Needs = Pick<Data, 'watches' | 'checks'> & {
  folder: Folder;
  saveNote: ReturnType<typeof writing>['actions']['add'];
};

export function flights({ watches, checks, folder, saveNote }: Needs) {
  const daily = defineAction({ /* reads and writes local/flights/ through `folder` */ });
  const page = ui(join(import.meta.dir, 'ui/dist'));
  const web = new Hono()
    .get('/feed.xml', async (c) => c.body(await feedOf(checks)))
    .all('*', (c) => page(c.req.raw));
  return {
    description: 'Trip ideas, daily research and read-only Flighty flights',
    actions: { 'create-watch': createWatch, daily },
    fetch: web.fetch,
  };
}
```

- **The marker** is the first `package.json`, walking up, that has an
  `"epicenter"` key. Its `port` is read without importing any app code.
  `EPICENTER.md` is deleted. A stray `epicenter.ts` in a subfolder is not
  a marker.
- **`epicenter.ts`** default-exports `defineEpicenter({ data, apps,
  routines })`. Importing it binds no port and starts no timer; app code
  starts no timer at its top level either.
- **A data key** is defined once, in the one `defineData` call, so a
  `field.ref` may name any key. Two apps may receive the same handle.
  `bun run typecheck` fails when an app expects a field its handle lacks.
- **An app** is a function from the handles it is passed to
  `{ description, actions, fetch? }`. Its name is its key in `apps`: the
  command word (`epicenter flights daily`) and the MCP prefix
  (`flights_daily`). `defineEpicenter` refuses a name that is not
  lowercase letters, digits and dashes, and refuses `serve`. A folder
  under `apps/` that `epicenter.ts` does not call does not run.
- **`local/`** is the one folder Git never sees: secrets, caches and this
  computer's settings, by convention under `local/<app>/`. No API names it.
  Today's `folderOnDisk` already treats the path: a new file under `local/`
  is `0600`, and the first write there writes `local/.gitignore`. An app
  that needs `local/` or files outside every data key is passed `home`.
- **A routine** names an action and its input. `defineEpicenter` maps each
  action to its `{ app, action }` name and refuses two routines or apps
  whose action is ambiguous. Serve checks once a minute and runs each
  routine whose schedule had an occurrence since its previous check,
  through `runAction`, so the run is logged, a throw becomes `Threw`, and
  the listing shows the routine's app, action, input and next occurrence.
- **An action checks its input on every call.** One checker lives in the
  action. Through serve, a misfit before dispatch answers `NotStarted`, as
  today. A direct call from another app answers `BadInput`, an error the
  calling action may handle or return; it is not reserved, so the outer
  call's record shows that the outer action ran. The checker refuses what
  `checkObject` refuses today and does not change the input.
- **`fetch`** is a web-standard `(Request) => Response`. Serve runs every
  guard first (tunnel, Host, Origin, `Sec-Fetch-Site`), keeps the redirect
  from `/apps/<app>` to `/apps/<app>/`, strips `/apps/<app>` from the
  path, deletes any incoming `X-Forwarded-Prefix` and sets its own, and
  keeps the method, query and body. Serve no longer serves `ui/dist/`.
- **`ui(dir)`** is today's `uiFile` code, exported from `@epicenter/app`:
  it refuses dot names and a file or a `dir` that resolves outside the
  app's folder, and sets the same cache headers.
- **Restart.** The home's `AGENTS.md` restart command runs
  `bun run typecheck && bun -e "await import('./epicenter.ts')"` and stops
  serve only when both succeed.
- **Tests** rebind data to a temporary folder:
  `defineData(folderOnDisk(tmp), data)` takes an existing `data` as its
  spec, and must include every key its refs name. A test calls the app
  function with those handles and never uses the default export.

## Consequences

- Deleted from `packages/app/src/command/`: app discovery and the per-app
  load guard in `apps.ts`, reading `routines/*.md` in `routines.ts`,
  reading `EPICENTER.md` in `root.ts`, and `uiFile` in `serve.ts`.
  `defineApp` is deleted, and an app no longer returns `data`; the listing
  shows the home's keys once.
- Added: `defineEpicenter`, `ui`, the `BadInput` error, prefix
  stripping, and the input checker moved from `command/input.ts` into the
  action. The library shrinks by a few hundred lines; the larger gain is
  fewer concepts.
- A file with no app is a folder in `data/`. Deleting an app is deleting
  `apps/<app>/` and its lines in `epicenter.ts`; its records stay.
- One broken import or one throwing definition stops every app, and every
  test that imports the root. The restart command catches both before the
  running serve stops.
- An app is not self-contained: it states the handles it needs as a type
  against one home's `Data`. Copying it can no longer copy records.
  Installing it is two edits, its folder and its lines in `epicenter.ts`.
- A routine cannot be added without editing code.
- Each app with a page gains a `fetch`, at least `fetch: ui(dir)`.
- Migrating the person's home takes several days, with flights and vault
  last. Eleven apps move from `defineApp(({ folder }) => ...)` to
  functions of handles, about forty tests rebind their data, and each
  app's `local/` files move to `local/<app>/` outside the migration
  commit, after `/local/` is in the root `.gitignore`. Vault's folder tree
  moves to `data/vault/` and is passed to vault as a subfolder, which also
  separates its `tasks/` from the tasks app's `data/tasks/`. Existing
  action names, such as flights' `create-watch`, stay.

## Considered alternatives

- **Records under each app (today).** Files with no app, or with two, have
  no place.
- **A top-level `data/` with each app declaring what it writes, and serve
  refusing two writers of one folder.** A runtime rule for code one person
  owns; the typecheck already says which apps use which key.
- **Data keys in `data.ts`, apps still discovered under `apps/`.** Two
  places say what runs.
- **Each app exporting the field lists it alone writes.** Keeps a copied
  app self-describing, at the cost of a key's definition living away from
  the one `defineData` call.
- **The port in `epicenter.ts`.** Every command would import every app to
  find serve, and a broken edit would stop commands while the running
  serve is healthy.
- **A routine as a closure (`run: () => ...`).** Serve could not name its
  action, log its run or record an `Err` it returned.
- **Passing each app its mount path.** Wiring in `epicenter.ts` for what
  `X-Forwarded-Prefix` already carries.
- **A home-level `fetch`.** No route needs it yet.
- **Routines as crontab or launchd jobs calling `epicenter`.** The schedule
  leaves the home's history, is set up again on each computer, and still
  needs serve running.
