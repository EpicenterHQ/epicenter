# 0970. An Epicenter is one program, composed in its root `epicenter.ts`

- **Status:** Proposed
- **Date:** 2026-11-18
- **Supersedes:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md): an app is no longer a folder that serve discovers; it is a module the root `epicenter.ts` imports.
- **Amends:** [ADR-0910](0910-an-epicenter-is-one-private-repository-and-each-app-keeps-its-code-beside-its-data.md) at its layout: `apps/<app>/code/`, `apps/<app>/data/` and `apps/<app>/local/` become `apps/<app>/`, the home's `data/` and the home's `local/`. One private repository, checkpoints and recovery stay.
- **Amends:** [ADR-0876](0876-an-apps-records-live-under-data-and-everything-else-in-it-is-code.md) and [ADR-0933](0933-an-apps-data-is-top-level-folders-of-markdown-records-and-single-markdown-files.md) at whose `data/`: records live under the home's `data/`, not an app's. Data keys stay folders of Markdown records and single Markdown files, and a write outside `data/` is still refused.
- **Amends:** [ADR-0937](0937-everything-periodic-is-a-routine-file-with-a-cron-schedule.md) at "a file in `routines/`": a routine is an entry in `epicenter.ts`. The cron expression, `Bun.cron.parse`, and serve's once-a-minute check stay.
- **Amends:** [ADR-0959](0959-serve-loads-each-app-once-and-an-apps-code-changes-when-serve-restarts.md) at "each app inside its own guard": serve imports one module, and the whole program loads or none of it does.
- **Amends:** [ADR-0942](0942-a-home-is-one-bun-workspace-and-epicenter-is-a-dependency-of-it.md) at `"workspaces": ["apps/*/code"]`: a home has one `package.json` and no workspace members.
- **Relates:** [ADR-0868](0868-an-epicenter-is-any-folder-that-says-it-is-one-and-a-computer-runs-as-many-as-it-has.md) and [ADR-0965](0965-the-command-finds-its-epicenter-by-walking-up-and-serve-starts-in-its-folder.md) (Proposed; each is edited to name `epicenter.ts` as the marker when 0970 is accepted), [ADR-0960](0960-an-app-is-a-function-of-its-folder-and-a-call-has-no-hidden-context.md) (Proposed; an app becomes a function of the handles `epicenter.ts` passes it), [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (`local/` never leaves its computer), [ADR-0967](0967-serve-keeps-action-calls-outside-an-apps-address-which-is-apps-name.md) (an app's address is its name, now its key in `apps`).
- **Unbuilt:** all of it. `@epicenter/app` exports no `defineEpicenter`, and serve discovers `apps/*/code/epicenter.ts` in `packages/app/src/command/apps.ts`.

## Context

An Epicenter today is a folder of app containers. Serve reads `apps/`, and
each folder there is an app named by the folder, whose
`code/epicenter.ts` default-exports `defineApp(({ folder }) => ...)`. The
app's records sit beside its code:

```txt
~/Epicenter/
  EPICENTER.md            marker; front matter holds `port: 4747`
  AGENTS.md  package.json  bun.lock
  routines/
    flights-daily-research.md
  apps/
    reading/
      code/epicenter.ts   defineData(folder, { books: ... })
      data/books/*.md
      local/
    writing/
      code/  data/notes/  local/
```

Every record belongs to the app whose container holds it. Three cases did
not fit:

- **Files with no app.** 415 articles moved out of this repository
  (PR #2734) had nowhere to go except `apps/docs-inbox/`, an app whose
  `epicenter.ts` declares no data key and no action. The files sit in its
  `data/` and no action can reach them.
- **Files two apps want.** A review that reads `notes` and `books` has to
  reach into two other containers, and nothing states what shape it
  expects there.
- **Files that outlive an app.** Deleting `apps/<app>` deletes its records
  (ADR-0910, Consequences).

Each app container was isolated because an app was treated as a unit
someone else might write. In a home, the owner and their agents write and
change all of the code. ADR-0910 rejected "apps as direct root children"
and "data inside code"; it did not consider records at the top of the home
beside `apps/`.

## Decision

**An Epicenter is one program. Its root `epicenter.ts` defines every data
key, composes every app, and lists every routine; serve runs that one
module.**

```txt
~/Epicenter/
  epicenter.ts            the program; also the marker the command walks up to
  AGENTS.md  package.json  bun.lock
  data/                   the person's records, plain Markdown
    notes/  books/  articles/
  apps/                   code only, imported by epicenter.ts
    reading/  index.ts  ui/
    writing/  index.ts  ui/
  local/                  this computer only, never committed
    mail/
```

```ts
// ~/Epicenter/epicenter.ts
import { defineData, defineEpicenter, field } from '@epicenter/app';
import { flights } from './apps/flights';
import { reading } from './apps/reading';
import { writing } from './apps/writing';

export default defineEpicenter(({ folder }) => {
  const data = defineData(folder, {
    notes: { fields: { kind: field.select(['thought', 'quote', 'link']) } },
    books: { fields: { title: field.text() } },
    ideas: { fields: { route: field.text() } },
  });

  const apps = {
    reading: reading({ folder, books: data.books, notes: data.notes }),
    writing: writing({ notes: data.notes }),
    flights: flights({ ideas: data.ideas }),
  };

  return {
    port: 4747,
    apps,
    routines: {
      'flights-daily-research': {
        cron: '0 8 * * *',
        run: () => apps.flights.daily({ recheck: false }),
      },
    },
  };
});
```

- **`epicenter.ts`** at the top of the home default-exports
  `defineEpicenter`. Its file name is the marker: the command walks up to the
  first folder holding `epicenter.ts`. `EPICENTER.md` is deleted, and its
  `port` is the `port` field.
- **`folder`** is the home. A write through it is refused outside `data/`,
  as an app's write is refused outside its own `data/` today.
- **A data key** is defined once, in `epicenter.ts`, and passed to every app
  that uses it. Two apps may receive the same key. `bun run typecheck` fails
  when an app expects a field the key does not define.
- **An app** is a module under `apps/<name>/`, a function from the handles
  it receives to `{ description, actions }`. Its name is its key in `apps`,
  which is the name a person types (`epicenter reading list`) and the MCP
  tool prefix (`reading_list`). A folder under `apps/` that `epicenter.ts`
  does not import does not run.
- **A routine** is an entry in `routines`: a `cron` expression read by
  `Bun.cron.parse` in the home computer's local time, and a `run` function
  that calls an action. Serve checks once a minute and runs each routine
  whose schedule had an occurrence since its previous check; an occurrence
  while serve is stopped does not run. Only serve schedules routines: a
  test, the typecheck or a command that imports `epicenter.ts` starts no
  timer. The `routines/` folder is deleted.
- **Loading.** Serve imports `epicenter.ts` once, when it starts. A module
  that throws, or a `defineEpicenter` that refuses what it was given,
  leaves serve answering with that one problem and no apps. The home's
  restart command in `AGENTS.md` runs `bun run typecheck` before it stops
  serve.
- **`local/`** holds what each app keeps on this computer, under
  `local/<app>/`. It is ignored by Git, as each app's `local/` is today.
- **One `package.json`** names `@epicenter/app` and every app's
  dependencies. An app has no `package.json` of its own.

## Consequences

- Deleted from `packages/app/src/command/`: discovering `apps/*/code/`, the
  per-app load guard and its problem lines, reading and checking
  `routines/*.md`, and finding `EPICENTER.md`.
- A file with no app is a folder in `data/`. `data/articles/` needs no
  `epicenter.ts` entry until an app reads it.
- Deleting an app is deleting `apps/<app>/` and its lines in `epicenter.ts`.
  Its records stay in `data/`.
- An app copied into another home is not self-contained: it names the data
  keys and fields it expects, and the receiving `epicenter.ts` defines them.
  Copying an app can no longer copy anyone's records.
- Installing an app is two edits: its folder under `apps/`, and its import
  and handles in `epicenter.ts`.
- One broken import stops every app. Today a broken app is listed and the
  others answer. A routine misspelling an action, or calling it with the
  wrong input, is a type error, not a problem serve finds at start.
- A routine can no longer be added or removed without editing code.
- Migrating a home is one commit: each `apps/<app>/data/*` moves to
  `data/`, each `apps/<app>/code/*` moves up one level, each
  `routines/*.md` becomes an entry, and each app's `defineData` call moves
  into `epicenter.ts`.

## Considered alternatives

- **Records under each app (today).** Files with no app, or with two, have
  no place.
- **Top-level `data/`, with each app declaring what it writes and serve
  refusing two writers of one folder.** A runtime rule for code one person
  owns; the typecheck already says which apps use which key.
- **Shared data keys in `data.ts`, apps still discovered under `apps/`.**
  Keeps per-app isolation and discovery, and still needs a second place
  that says what runs.
- **Routines as cron jobs outside the home** (crontab or launchd calling
  `epicenter flights daily`). The schedule leaves the home's history, is set
  up again on each computer, and still needs serve running.
- **No routines.** The one running routine, `flights-daily-research`, would
  need a scheduler outside the home.
- **A restart that keeps the old program until the new one loads.**
  ADR-0959 makes restart a stop so two serves never run at once; the
  typecheck before restart catches what loading would.
