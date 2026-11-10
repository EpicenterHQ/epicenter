# 0857. An app is one `epicenter.ts` that composes collections and actions

- **Status:** Proposed
- **Date:** 2026-11-08; rewritten 2026-11-10
- **Amended:** 2026-11-10, after an adversarial review: a read is checked by projection and says what does not fit in `problems`; collection methods take their verbs' object shapes, and many-file collections have `pathOf`; definitions check more; `defineApp` needs `collections` and `actions`; a read-only run refuses writes through `folder` and `secrets`; a thrown action's writes are committed; a UI's client must handle an uncommitted change. 2026-11-11, with ADR-0850: runs never commit, so a thrown action's writes are pending like any, collection writes go through `folder.update`, and the client has no uncommitted change to handle. 2026-11-11, with [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md): a run reaches `folder` only, since an app's secrets are `.local` files; a read-only run may write a `.local` path, and a `.local` collection's `actions()` throws. 2026-11-11, later: a collection's `path` is one template, and a list is refused; a second layout is a second collection.
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
  and `actions()`, which gives its verbs as actions. The methods take the
  verbs' object shapes: `words.get({ path })`, `words.add({ word, meaning })`,
  `words.set({ path, meaning })`, `words.edit({ path, old, new })`,
  `words.delete({ path })`, `words.list()`; a one-file collection has
  `get()`, `set(fields)`, and `edit({ old, new })`. A many-file collection
  also has `pathOf({ word })`, which fills its template with the checks
  `add` applies, so action code never builds a path by hand.
- `defineAction` returns the action as a function of its input, carrying its
  description, input, `positional`, and `annotations`. It exists to type
  `run`'s input from `input`. A direct call fills each field's default before
  `run`, as a call through the CLI or MCP does, and `run` returns a value
  JSON carries.
- `defineApp` checks what it was given and returns that same object. It
  needs `description`, `collections`, and `actions`, `{}` for none. A
  collection's name is its key in
  `collections`. An action's words are its keys in `actions`: a key holds an
  action or a group of them, so `{ mail: { messages: { list } } }` is
  `mail messages list`. A later key replaces an earlier one, as in any object,
  and naming verbs gives fewer: `settings.actions('get', 'set')`.
- An app with one collection spreads its verbs at the top, so they are its own
  (`epicenter tasks add`); an app with several nests each under its name.

**A collection's `path` is one template.** A placeholder matches one path
segment; `{time}` is made by `add`, and every other placeholder is an input
`add` takes. A path with no placeholder is one file, with only `get`, `set`,
and `edit`. Files in a second layout are a second collection, so which files
belong, what a read gives, where `add` writes, and how a record is addressed
each have one answer. A record's address is its path inside the app. A field marked
`readOnly` is written only by the app's own actions, through the collection's
methods; the exposed `add` and `set` leave it out, and when such a field is
required and has no default, `actions()` leaves out `add`.

**A read never trusts the file.** One check feeds `list`, `get`, the files
`add`, `set`, and `edit` return. Each declared field is its
value when it fits, else its default, else absent. `path`, the placeholders
its path holds (`word: '你好'`), and `body` come from the file after the
fields, so front matter never replaces them. A file that does not
fit carries `problems`, one line each, quoting the dropped value as JSON
(`due: "next week" is not a day`, `title is missing`); a file that fits has
no `problems` key. `get`, and the file each write returns, also carry `other`, the
front matter that is not a field's fitting value, when there is any. In the
types, a field with a default is required and every other field optional;
every placeholder is required. `path`, `body`, `problems`, `other`, `json`,
`help`, and `input` cannot name a field or a placeholder.

**The generated verbs address a record by its path.** A path is the one
address every collection has, so the verbs, written for the generic case, take
it. An action the author writes chooses its own input, and one people type
should take what they type: Vocab's `review` could take `{ word, grade }` and
call `words.pathOf({ word })`, giving `epicenter vocab review 你好 good`. This
settles addressing by placeholder as the author's choice, not a framework
feature; a UI routes by the whole path, URL-encoded.

**Whatever runs an action opens its run.** The runner calls
`inRun({ folder }, () => action(input))`; for the length of the call, the
app's collections and the imported `folder` reach that folder, however deep
the code, through `AsyncLocalStorage`.
An action that calls another stays in the same run. Outside a run they throw,
so loading an app never touches its files. `epicenter` supplies one copy of
`@epicenter/app` to every `epicenter.ts`, so the runner and the app share the
run.

**A definition is checked when it is made.** Each `define*` throws, one problem
a line, for what its types cannot say, and for a list of paths, which Bun
runs without checking types: a path that is not a relative `.md` template, or
whose first part is a placeholder, `ui`, `node_modules`, or starts with
`epicenter.`; a field its path already names; a reserved name; a
required field without a default in a one-file collection; two collections
that would hold one file; a positional that is not a field; a key that is not
a word, or is `then` at any depth. `epicenter` loads an app by calling
`defineApp` on its default export, and lists an app whose `epicenter.ts`
throws while loading, or whose export `defineApp` refuses, with those lines as
its problems, and does not run it.

**A read-only action cannot write through `folder`, except to a `.local`
path.** Its run, marked `readOnly`, is never logged or snapshotted, and
`folder.write`, `writeBytes`, `update`, and `delete` throw in it before doing
anything. A `.local` path is let through, since it is never in the app's
history, so a read-only action may refresh a token (ADR-0870). A raw
`node:fs` write or an outside service remains the author's promise.

**A UI calls the same tree.** `connect<typeof app>('vocab')` gives
`vocab.add({ word })` and `vocab.review({ path, grade })`, typed by the app,
which the UI imports as a type only, with returns in their JSON form. A call
resolves to what the action returned, whatever became of the snapshot after it
(ADR-0850). `ActionInput<A>` and `ActionOutput<A>` name an action's input and
output for a UI.

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
- A read's type tells the truth about a file written by hand: code that reads
  a field handles its absence, and a UI shows `problems` instead of crashing
  on a value it did not expect. The cost is optional fields where the
  declaration says required.
- Projection keeps one record shape for `list` and `get`, so a file that does
  not fit is still listed, edited, and fixed through the same verbs.
- What an action wrote before it threw is pending like any change, and the
  snapshot after the call names it (ADR-0850). Whether a failed action should
  be rolled back instead is open: ADR-0850 removed tracked writes, and raw
  `node:fs` writes bypass `folder`.
- A hand edit pending in the folder is taken by the next snapshot and listed
  as changed outside epicenter, not claimed by a call; a child killed before
  reporting leaves its writes for the next snapshot the same way (ADR-0850).
- Risks this record leaves open:
  - On a disk that ignores case, such as APFS, `words/Hello.md` and
    `words/hello.md` name one file under two addresses.
  - A value that does not fit appears twice on `get`: quoted in `problems`,
    raw in `other`.

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
- **`list` answering `{ rows, problems }`.** Splits a file from its own
  problems, and gives `list` a shape no other verb has.
- **A valid or invalid union per record.** Every reader branches before it can
  show a file, and an invalid file loses the fields that did fit.
- **Locking every action, read-only ones included.** Serializes reads behind
  writes for a guarantee the read-only run's refusals already give for writes
  through `folder`.
- **Rejecting the client's promise on an uncommitted change, or an
  `onUncommitted` handler every UI must give (this record until 2026-11-11).**
  The action ran, and a UI that retried a rejected call would run it twice;
  once a call never commits, the snapshot after it is the server's concern,
  and the app's status says when one failed.
- **Dropping undeclared front matter keys, with no `other`.** Hides what a
  person or another program wrote, which every write keeps.
- **Several templates per collection (this record until 2026-11-11).** Dropped
  again, as ADR-0845 first did, so membership, reading, creation, and
  addressing each get one answer, and no app needed two layouts.
- **Addressing by placeholder in the generated verbs (`get({ word })`).** A
  framework feature for one kind of template; a path addresses every
  collection, and an author's own action can take a placeholder and call
  `pathOf`.
