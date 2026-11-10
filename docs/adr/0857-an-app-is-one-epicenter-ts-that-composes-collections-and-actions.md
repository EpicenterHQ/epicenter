# 0857. An app is one `epicenter.ts` that composes collections and actions

- **Status:** Proposed
- **Date:** 2026-11-08; rewritten 2026-11-10
- **Amends:** [ADR-0841](0841-an-app-is-a-folder-whose-epicenter-ts-defines-its-actions.md) at `defineApp`'s shape: an app composes collections and actions defined on their own, its actions nest under their words, and a run's folder reaches them without a context argument. [ADR-0845](0845-an-app-declares-collections-each-a-path-and-fields-which-the-hub-views.md) at a collection's path, which is a template with any number of placeholders, and its fields, which are the `field` helpers' JSON Schema.
- **Relates:** [ADR-0853](0853-collections-give-five-actions-and-programs-without-the-folder-ask-over-mcp.md) (collection verbs and the client), [ADR-0854](0854-an-apps-cache-is-the-files-it-gitignores.md) (`.cache/`), [ADR-0860](0860-an-interface-is-a-view-over-an-apps-actions-and-never-knows-where-they-run.md) (views), [ADR-0864](0864-epicenter-is-a-data-server-for-repositories-of-files-and-code-runs-where-its-owner-trusts-it.md) (where `epicenter.ts` runs), [ADR-0869](0869-a-body-is-changed-by-quoting-the-passage-it-replaces.md) (`edit`).
- **Unbuilt:** `sync` naming a file that two collections hold.

## Context

This record first moved an app's description and collections into an
`epicenter.json`, so a folder written by a program without code could still
declare its shape, and kept actions in `epicenter.ts`. Building Capture, Tasks,
and Vocab on it showed the cost: two files that had to agree, a JSON import
that TypeScript widens, collection handles in `run` that could not be typed
from the JSON, and a CLI that validated the declaration, then the code, then
the two against each other. No app without code was written; the program the
split served, Whispering, still keeps its own shapes.

The person and their agents write apps in TypeScript and run only code they
trust (ADR-0864). One file that TypeScript checks whole serves them better than
a declaration readable without code.

## Decision

**An app is a folder whose `epicenter.ts` default-exports `defineApp(...)`.
There is no `epicenter.json`.** A folder without `epicenter.ts` is not an app.

**Collections and actions are values, defined on their own and composed by
`defineApp`:**

```ts
const words = defineCollection({
  path: 'words/{word}.md',
  fields: { meaning: field.text({ optional: true }) },
});

const learn = defineAction({
  description: 'Learn a word',
  input: { word: field.text(), meaning: field.text({ optional: true }) },
  run: ({ word, meaning }) => words.add({ word, meaning }),
});

export default defineApp({
  description: 'Words I am learning',
  collections: { words },
  actions: { ...words.actions(), add: learn },
});
```

- `defineCollection` returns what it was given, plus methods an action calls
  (`words.get(path)`) and `actions()`, which gives its verbs as actions.
- `defineAction` returns the action as a function of its input, carrying its
  description, input, `positional`, and `annotations`. It exists to type
  `run`'s input from `input`.
- `defineApp` returns what it was given. A collection's name is its key in
  `collections`. An action's words are its keys in `actions`: a key holds an
  action or a group of them, so `{ mail: { messages: { list } } }` is
  `mail messages list`. A later key replaces an earlier one, as in any object,
  and naming verbs gives fewer: `settings.actions('get', 'set')`.
- An app with one collection spreads its verbs at the top, so they are its own
  (`epicenter tasks add`); an app with several nests each under its name.

**A collection's `path` is a template.** A placeholder matches one path
segment; `{time}` is made by `add`, and every other placeholder is an input
`add` takes. A path with no placeholder is one file, with only `get`, `set`,
and `edit`. A list of templates holds files in several places, and `add` writes
to the first. A record's address is its path inside the app. A field marked
`readOnly` is written only by the app's own actions, through the collection's
methods; the exposed `add` and `set` leave it out.

**Whatever runs an action opens its run.** The runner calls
`inRun({ folder, secrets }, () => action(input))`; for the length of the call,
the app's collections and the imported `folder` and `secrets` reach that
folder and those secrets, however deep the code, through `AsyncLocalStorage`.
An action that calls another stays in the same run. Outside a run they throw,
so loading an app never touches its files. `epicenter` supplies one copy of
`@epicenter/app` to every `epicenter.ts`, so the runner and the app share the
run.

**A definition is checked when it is made.** Each `define*` throws, one problem
a line, for what its types cannot say: a path that is not a relative `.md`
template, a field its path already names, two collections that would hold one
file, a positional that is not a field, a key that is not a word. `epicenter`
lists an app whose `epicenter.ts` throws while loading with those lines as its
problems, and does not run it.

**A UI calls the same tree.** `connect<typeof app>('vocab')` gives
`vocab.add({ word })` and `vocab.review({ path, grade })`, typed by the app,
which the UI imports as a type only.

## Consequences

- An app is one file to read, and TypeScript checks a collection's fields
  against every action that uses them.
- `epicenter <app> --json` gives each collection's path and fields as JSON
  Schema, from the `field` helpers, and MCP's `tools/list` gives each action's
  input the same way, for any reader without a JavaScript runtime. `serve` still never imports an app: it lists through a
  child process.
- A folder written by a program without code, such as Whispering's, is an app
  only once someone writes its `epicenter.ts`; how Whispering's folder becomes
  one is open.
- A broken `epicenter.ts` shows the problems of the first `define*` that
  throws; fixing them shows the next.
- A collection's errors name its path, and its verbs' descriptions name its
  `description` or, without one, its path (`Every words/{word}.md file`), since
  a collection does not know its name.
- Verified 2026-11-10 (TypeScript 5.9.3): an action written inline in
  `defineApp`'s tree gets an untyped input (`implicitly has an 'any' type`);
  through `defineAction` its input is exact.

## Considered alternatives

- **`epicenter.json` for the description and collections, `epicenter.ts` for
  actions (this record's decision until 2026-11-10).** Two files that must
  agree, a JSON import TypeScript widens, and collection handles in `run` that
  could not be typed from the JSON.
- **Actions written inline in `defineApp`, or `defineApp` taking a function of
  its collections.** TypeScript cannot infer each action's input through the
  nested map; inputs come out untyped.
- **`run(input, context)`, the context passed by the runner.** Every helper an
  action calls needs the context passed on, and a collection defined at the top
  of the file cannot use it.
- **Actions flat by their words (`'words add': …`).** A CLI's index in the
  app's code: quoted keys, and a rule that one action's words may not start
  another's, which nesting makes impossible.
- **`defineApp` giving each collection its name, binding it after the fact.**
  A collection whose name changes when an app is made, and is rebound by a
  second app. Its path names it instead.
- **`problemsOf(app)` run by the CLI after loading.** A second pass over what
  each `define*` can check as it is made.
- **An action as `{ description, input, run }` called as `action.run(input)`.**
  The tree reads `app.actions.words.add.run(...)` where the command line reads
  `words add`.
