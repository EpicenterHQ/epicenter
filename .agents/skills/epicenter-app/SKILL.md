---
name: epicenter-app
description: "Make or change an Epicenter app: its data, actions, UI, code/data container, and private root history. Use when asked to build a personal app, change Capture, Reading, Tasks, or Vocab, set up an Epicenter, copy or share app code, or adapt code from another app on the computer that runs epicenter serve."
---

# Epicenter apps

An Epicenter is a marked folder with one private Git repository. Its apps
live in `apps/<app>/`: `code/` is an ordinary Bun project and sibling `data/`
holds records and settings. The source and live Epicenter use this layout
(ADR-0910, Accepted). Inspect an existing app before editing it.

`epicenter` selects the nearest marked ancestor of the current folder, then
`EPICENTER_ROOT`, then `~/Epicenter`; a temporary Epicenter for testing stays
apart from the person's own this way. `epicenter serve` listens only on this
computer and offers MCP at `/` and each UI at `/<app>/`, on the marker's `port`
or 4747 when absent. Other devices reach it through the owner's private network,
such as `tailscale serve`.

```txt
<Epicenter>/                    one private Git repository, one Bun workspace
  .gitignore  .gitattributes     local files/caches excluded; optional LFS rules
  EPICENTER.md  AGENTS.md
  package.json  bun.lock        the workspace and the Epicenter version; committed
  node_modules/                 one install for the command and every app, ignored
  apps/<app>/                   stable container: folder.path
    code/                       one package of the workspace
      epicenter.ts              data and actions
      epicenter.test.ts         action tests
      package.json              named for the app; actions' and UI's dependencies
      README.md
      ui/                       optional browser UI
        dist/                   generated, ignored
    data/                       records and settings
      tasks/<id>.md
    local/                      this computer only; made by the first write
      google.md
```

`new --from` copies committed code into a new container's `code/`, without
records, Git history, or a remote. It takes a folder in a Git checkout, written
as a path (`./shared/tasks`, `~/Code/apps/tasks`), or a folder on GitHub,
written `owner/repo/folder#ref` (`#ref` optional: branch, tag, or full commit).
For any other host, clone first and pass the folder. The folder may be a
repository root, a subfolder, or an app container's code subtree. Provenance is in
`code/SOURCE.md`. Later source changes are work for the app's owner; there is
no merge-based updater. A copied symlink stays a link, and one leading
outside `code/` breaks unless the receiving home has that file; `new` reports
it. Keep everything an app uses, its palette too, as files in `code/`.

Read `packages/app/README.md` and one existing app before starting. Tasks is
the smallest whole example. Keep private records out of code publication;
publishing needs a separate code-only history. `epicenter export` writes code
into a generated directory outside the private Epicenter; review, commit, and
push the publication's outer repository with Git.

The code travels through export; the records stay private. Someone taking the
app copies committed code without its records or private history. A private
origin can still back up the root, including all apps' records.

Before shaping a data key, decide where its truth is (`docs/vision.md`,
ADR-0896, ADR-0898), then copy the nearest example in `~/Epicenter/apps`:
Tasks for kept records, whose files are the truth; Mail for a service whose
records stay there, with the person's decisions kept in `data/` and applied
through an action; Messages for live records, asked each time. An item from
elsewhere moves into kept records by transfer: write it with its source id,
then close it at the source. Never keep two writable copies in
step, and never make one app import or call another. Anything under
"Not yet" or "Never" in `docs/vision.md` needs the owner's yes.

Change an app's code in its own `code/`. Keep experiments outside the live
Epicenter: a branch switch, stash, or reset there changes every running app's
code and records together. A change useful to another person is a code copy
for their agent to adapt, with any record repair explained beside it.

## Decide the files first

The files outlive every UI and agent, so their shape is the decision that
matters most. Declare them with `defineData` in `code/epicenter.ts` (or a
`data.ts` beside it), one key per kind of record under `data/`
(`packages/app/README.md`). A key without `.md` is a folder: `tasks` holds
`data/tasks/<id>.md`, one record per file, named by its id. A key ending in
`.md` is one file: `settings.md` is `data/settings.md`. Each key gives
`fields`, the front matter of each file, and may give a `description` of one
record. `data.tasks.actions('list', 'get', 'add', 'set', 'delete')` gives the
verbs it names and only those; a one-file key offers `get`, `set`, and
`delete`. An app with one key spreads its verbs at the top, so they are its
own (`epicenter tasks set`, MCP `tasks_set`); an app with several nests each
under its name (`epicenter mail proposals list`). A record's address is its
path: `data/tasks/2026-11-10T09-30-00-000Z-k3x9a2f8.md`. `defineData`
refuses a key that is not a name, a field named `path`, `body`, `id`, or
`edit`, and a `readOnly` field. No field has a `default`: a definition with
one is refused, so write the default where the value is read (`limit ?? 50`).

- Choose the id by how people and agents will name a file. `timeId()` suits
  things made in passing (Tasks and Writing name each new record with it). An
  id the caller gives suits things named by what they are (`data/words/<id>.md`
  for Vocab). An id is non-empty NFC text of at most 200 bytes, without `/`,
  `\`, control characters, a leading dot, or whitespace at either end. An id
  is the file name exactly: no method or generated verb changes it, and one
  that does not fit is `Refused` with the reason, so trim what a person typed
  before passing it. A generated `add` names the record with
  `timeId()` when `id` is left out. An action takes an id as `field.text()`;
  the handle refuses a bad one, quoting it, with the name to send instead.
- Write a day or a moment with `localDay()` or `localTime()` from
  `@epicenter/app`, in the time zone of the computer that runs the action,
  as `field.date` and `field.datetime` hold them; `toISOString()` gives UTC's
  day, which is the wrong one in the evening west of Greenwich.
- Derive a state from fields that already say it rather than storing it
  twice: Reading has no status, since `started` and `finished` say whether
  a book is to read, being read, or read.
- `list` returns one Result per file, bodies included. Put what a list or an
  agent needs at a glance in a field (a task's `title`); put prose in the
  body.
- Keep fields few. `set` merges as JSON Merge Patch does: `null` removes a
  field, so a field that may be absent needs no `null` in its type; a
  required field takes no `null`. A generated `set` requires at least one
  submitted field or body edit.
- When only the app's own actions may write a field (Vocab's schedule,
  Capture's `capturedAt`), leave the verb that would write it out of
  `actions(...)` and write the app's own action instead (Capture's `add`).
- Constrain text with `field.text({ pattern, description })`, the description
  reading after "must be" (Tasks' title: `one line, not blank, saying what to
  do`), so the generated `set` refuses what the app's own `add` would.
- `get(id)` gives `Ok(record)` when the file fits: its `path`, `id`, fields,
  and `body`. An absent switch reads as `false` and an absent list as `[]`. A
  missing file gives `Ok(undefined)` to the method and `Missing` to the
  generated action.
- A malformed file gives `Err(Misfit)`. Its error carries a path, the
  record's `id` in a folder key, and diagnostic lines. When the front matter is readable it also carries a
  partial `record` for repair. A computed write refuses before its callback runs.
  A direct patch can repair readable front matter if the whole result fits.
  Unreadable front matter needs a file edit.
- `field.list(item)` reads as `[]` when absent and is never needed from a
  caller. An action that cannot run without an item declares
  `field.list(item, { min: 1 })`: it is required, `--help` and the schema an
  agent receives say so, and an empty list is refused before `run`.
- The `set` verb sends what the caller last saw, since it cannot send a
  function: `id`, the fields, and `body` or `edit: { old, new }` to replace
  the passage `old` of the body. `old` must be non-empty and occur exactly
  once. One call is one write: when the passage is gone or appears twice, it
  is refused with `Changed` (`why` is `quote` or `twice`) and nothing is
  written, fields included. So a page that saves a record's
  fields and its notes sends one `set`. In code, `set` carries `body`, as
  data or from a function of the record.
- An app is `code/`, `data/` and `local/`. What is in `local/` stays on the
  computer that runs the app: the root `.gitignore` leaves it out of every
  commit, and `folder` makes a new file there `0600`. Git's ignore rules are
  the only guard, so never `git add -f` a file there. It holds plain files, not
  data keys: a token, a cache, a database. Keep a secret, such as a sign-in
  token, with `folder.write('local/google.md', token)` and read it with
  `folder.read('local/google.md')`, which gives `undefined` before sign-in.
  Use `folder.update` to compare the old token when refreshing it. No
  generated verb reaches `local/`, so no MCP client is handed the token. A
  fresh clone has no `local/`, so the person signs in again.
- The data keys are the contract between code and records. Reads tolerate
  disagreement: undeclared keys are kept by every write and left out of a
  read, and a missing optional field is no problem. Rename or tighten a field
  in two steps: change the code, then repair records with an action or agent.
  Run `epicenter check <app>` afterward to see any remaining file diagnostics.
  Commit code and repairs together.
  There is no global migration gate. Explain any repair when sharing code;
  another person's records change only when they run it.

## Write actions only for what the verbs cannot do

For Mail (ADR-0882), agents prepare and revise proposals. The person chooses
`apply` to approve a proposal or `change` to act on the messages displayed
in the reader. Exercise either write path only against fake Gmail as an agent.

`code/epicenter.ts` default-exports `defineApp({ description, data,
actions })`. The home is one Bun workspace and an app's code/ is one package
of it: `code/package.json` is named for the app, and the home has the one
`bun.lock` and the one `node_modules/`, at its top. An app's actions may
import anything its `package.json` names, plus Node's built-ins; declare
every package the app imports. Add one with `bun add <package>` in code/.
`@epicenter/app` comes from the home's `package.json`, which names the
version of Epicenter the home runs, and is never listed in the app's: a
second copy is refused when the app loads. A package nested inside an app,
such as `apps/films/code/render/` with its own `package.json`, gets its
packages only once its path is added by hand to `workspaces` in the home's
`package.json`. `bun install` at the top of the home installs its packages;
`epicenter init` runs it once, `epicenter new` prints it, and a call never
installs.
Restart `serve` after packages change, by stopping and starting it: an edit
to an app's own files shows on the next call, a changed package only after
the restart. Upgrade Epicenter by editing both versions in the home's `package.json`, then
running `bun install && bun run build` at the top: the two are released at
one version, and `epicenter` refuses to load apps while the home names two.
Write each action with `defineAction`, which types its
`run` from its `input`. Every action returns one Result. Return `Ok(value)`,
`Ok(undefined)` for no value, or the Result of another action or data
method. A tagged factory such as `ActionError.Missing({ path })` already
returns an Err. When continuing a calculation, use
`if (read.error !== null) return read` before reading `read.data`. Add an action when the caller cannot do the job with the
verbs: a rule on making a file (Tasks' `add` splits a title from its notes),
a rule across fields (Vocab's `review` scheduling), or a read shaped for a
screen (Capture's `recent`). Replace a verb by key, as in any object:
`{ ...data.words.actions('list', 'get', 'set'), add: learn }`. Inside `run`,
read and write through the key's methods, which name a record by its id and
take the change second (`data.words.get(word)`,
`data.words.set(word, { meaning, body })`, `data.words.update(word, change)`),
instead of parsing front matter again. A one-file key's methods take no id
(`data['settings.md'].get()`); it reads as `Ok(undefined)` before the first
write, has no `add`, and its `set` method or verb can create the file. For
other files, the imported `folder` supplies atomic writes and updates.
`data.words.pathOf(word)` gives a record's path; never build one by hand.
All writes stay pending until a commit records them.
`folder` refuses a write outside `data/` and `local/`.
Reads may reach the whole Epicenter, including another app's records by a
path like `../tasks/data/tasks/<id>.md`, using `node:fs` or a library.
Resolve that path from `folder.path`, which is the container. Change another
app's data through its actions so its rules check the write; this is guidance,
not enforced.

Give `run` a second argument, `update: Update<T>`, when a person watches it
work, such as a chat reply from a model, and call it with each piece. The
action returns one final Result, which must carry everything a caller that
did not listen needs. Serve runs the action to its end even when the page
closes, and keeps nothing about the call, so save what a reload must show
(the person's submitted input first, then completed output) in records.

Actions run inside `epicenter serve` itself, from the files as they are when
the call arrives, so an edit takes effect on the next call. The command line
sends its call to serve too: `epicenter <app> <action>` is refused with exit 2
while serve is stopped, and never runs the action itself. Never call
`process.exit`, `process.chdir`, or set `process.env` in an action: each
reaches every app `serve` runs.

Writes to one app run at once: a phone, an agent, and the command line can
all call the app at the same moment, and an agent may edit its files
directly. A value computed from `get` and written with `set` is last write
wins: a change made between them is lost. Compute it inside `update`. Its
callback receives the fitting record, or `undefined` for an absent file, and
returns `Ok(patch)` or a tagged Err; from `undefined` it creates the file. No
other write to the file runs between its read and its write. Vocab's
`review` schedules a word this way, so two reviews at once both count.
The patch can carry a new `body`, so Reading's `start` makes a book or starts it in one `update`,
never `get` then `add`, which two calls at once would race.

```ts
return data.words.update(word, (found) =>
  found ? Ok({ reps: (found.reps ?? 0) + 1 }) : ActionError.Missing({ path: data.words.pathOf(word) }),
);
```

Use `folder.update(path, change)` for a raw text change. It passes the current
text, or `undefined` when the file is absent. Either way, keep `change` a pure function of what it is
given. A data callback returns a tagged
Err to decline or `Ok({})` to leave an existing file alone. A raw folder
callback returns the new text.

```ts
await folder.update('data/2026.csv', (text = 'day,minutes\n') => `${text}${day},${minutes}\n`);
```

Use `folder.edit(path, decide)` for a raw text change that may decline. Return
`Err(reason)`, `Ok({ value })` to preserve the file, or `Ok({ value, text })`
to replace it. The result carries the value from the winning attempt. `set` given fields writes
the values it is given, and `folder.write` is for a file whose whole content
the action decides: for both, the last write wins.

The generated verbs take a record's `id` flat, beside the other fields. On the
command line an action's input is one JSON object, the same one MCP takes:
`epicenter vocab set '{"id":"serendipity","meaning":"a lucky find"}'`.
For text a person wrote, pipe it with `- <<'EOF'`, which has no quoting to get
wrong; `epicenter <app> <action> --help` lists the keys. An action you write
chooses its own input, and should take what its caller knows: Vocab's `review`
takes `{ word, grade }`, giving
`epicenter vocab review '{"word":"你好","grade":"good"}'`.

Annotate honestly. Annotations are hints an MCP client reads to decide how
careful to be, and nothing enforces them, so mark an action read-only only
when it changes nothing. Declare `mcp: false` on an action an agent should not
be offered as a tool, such as sending as the owner; the CLI and HTTP still run
it, so it is not a wall. Actions make no commits, and the root ignore rules
keep local files out.

Write last. Nothing locks a call, so fetch from a service, call a model, or
compute first, then write: a slow step then never leaves a file half done.
When the person's input is the only copy, keep it: Zhongwen's `practice
reply` saves the learner's turn, then asks the model, and adds the tutor's
turn only when it is whole. Codex's voice reply keeps the recording in
`local/` only when transcription fails.

The outside world is the action's to handle. Epicenter promises one thing
about the home's files, that one process writes them, and nothing about a
service, a model or a browser. It has no time limit, retry or stop for an
action, and adds none: the action is ordinary code, and its author decides.

- Give every outside call a time limit. Pass `AbortSignal.timeout(ms)` to the
  request, sized for the caller: seconds for a button, hours for a download. A
  client that retries does so inside that signal, so no call waits forever.
- Answer what is known. A request that times out after it left may have
  worked: say it was not confirmed, not that it failed. A long action that
  stops at its own limit with its progress saved returns `Ok` with a field
  saying it is unfinished. `ActionError.Unreachable` is what a caller gets
  when it could not reach `serve`, so do not use it for that.
- Write what a page must show later. A page that reloads, another device and
  a routine see neither the updates nor the answer of a call they did not
  make. Progress worth showing goes in a file with the time it was written.
  Do not write that something is running: after a restart it is false.
- Share as little as possible. Two calls of one action both run. Give each
  its own record id, temporary folder or browser tab, and none has to wait.

Epicenter runs actions and serves pages. Git stores the home, and Epicenter
does not wrap Git: no `epicenter` command commits or pushes. After direct
edits, make a named commit with Git, such as
`git add -A && git commit -m "<what changed>"`. A home commits itself between
named commits with two files of its own, which `epicenter init` writes into a
new home. `routines/checkpoint.md`:

```yaml
---
cron: "*/5 * * * *"
run: ["/usr/bin/lockf", "-t", "0", ".git/checkpoint.lock", "sh", "scripts/checkpoint.sh"]
---
Commit everything pending and push to the backup.
```

`scripts/checkpoint.sh`, executable:

```sh
#!/bin/sh
set -eu
for s in MERGE_HEAD REVERT_HEAD rebase-merge rebase-apply CHERRY_PICK_HEAD; do
  [ -e ".git/$s" ] && { echo "merge or rebase underway" >&2; exit 0; }
done
git add -A
if git ls-files -s | grep -q '^160000'; then
  echo "a nested Git repository is staged; remove its .git" >&2; exit 1
fi
git diff --cached --quiet || git commit -qm "${1:-checkpoint}"
git remote get-url origin >/dev/null 2>&1 || exit 0
GIT_TERMINAL_PROMPT=0 git push -q origin HEAD
```

Serve starts the routine every five minutes, with the home as the working
directory. `/usr/bin/lockf` is macOS; on Linux start `run` with
`"flock", "-n", ".git/checkpoint.lock"` instead. Without the routine, nothing
is committed or pushed on its own. The branch and index are shared: the script
commits staged work along with everything else, and it samples files, not
intent, so it can capture a partial edit or part of a running action. Make a
named commit before a risky change.

A routine's `run` is a program and its arguments. An argument may be a JSON
value, which reaches the command as one word of JSON text:
`run: ["epicenter", "flights", "daily", "run", {"recheck": false}]`.

`epicenter` on its own shows each routine with its next occurrence and its
command as a line to copy into a terminal, how long
ago the last commit was, how many files are uncommitted, how many commits are
not on origin, and any nested Git repository under `apps/`.

The root origin is optional and private. It receives all apps' records. The
script never pulls, merges, rebases, or force-pushes, and a failed push leaves
commits local for the next run. Git's ignore rules alone keep local
credentials out, so never force-add them.
Never run `git clean -x` in the Epicenter: it deletes local credentials.

To recover, inspect Git history, then restore selected paths from the root:

```sh
git log --oneline -- apps/<app>/
git restore --source=<commit> -- apps/<app>/code/    # code only
git restore --source=<commit> -- apps/<app>/data/    # records only
```

A whole `apps/<app>/` restore reverts both and deletes tracked files added
later. Inspect the root `MIGRATION.md` and the commit tree first. Commits from
before a move into `apps/<app>/` use the old paths. An imported per-app commit
can hold only code or only records: restore its code or data prefix, not the
whole app. History retained only in archive refs is outside `main`; fetch it
explicitly into a separate recovery checkout. Keep the live home on its
current branch.

When recovering a bad write, inspect history and restore the relevant known
version rather than retype its previous content, then record the repair in a
named commit so history says what happened. A field change and its record
repair belong together. Restoring only code or only data can leave the
declaration and records disagreeing. Run `epicenter check <app>` and inspect
the diagnostics for the affected paths. Make a named commit before
risky work so the original files remain recoverable.

## Build the UI as a client

Add `code/ui/` when the app needs a browser view. The app owns its colors:
keep them in a `theme.css` under `ui/`, copied from a sibling app rather than
linked, and change the copy freely. Tasks maps its palette to Tailwind
utilities. Fonts, layout, and components
belong to the app.

For a Svelte UI like Tasks, copy its `ui/build.ts`, `ui/svelte-plugin.ts`, and
the components the view uses. Copy `bunfig.toml` with the build: `peer = false`
keeps a peer named `bun` from shadowing Bun. Keep component source editable in
`src/lib/components/ui/` alongside `components.json` in `ui/` and `src/lib/utils.ts`.
The UI calls Epicenter through `@epicenter/app/client`. Declare other imported
packages in `code/package.json` with versions resolvable from npm.

Build paths are relative to code/. Component paths starting with src/ or
static/ are relative to code/ui/.

The app builds its own UI: its `code/package.json` has a `build` script that
writes `ui/dist/`, and `serve` serves `ui/dist/` as it is and never builds. A
plain page needs one line: `"build": "bun build ui/index.html --outdir ui/dist"`.
The build writes relative URLs and is never told where it is served, and
`@epicenter/app/client` comes from the home's install; never list
`@epicenter/app` in the app. `bun add` in `code/` installs a package, then
restart `serve`.

After any change under `ui/`, run `bun run build` in `code/`, read its errors,
and fix them before saying the page changed: an unbuilt edit does not show.
After upgrading Epicenter, run `bun run build` at the top of the home, which
builds every app against the new client. Never
commit `ui/dist/`. The UI owns unfinished input and local interaction state.
Actions own stored records; the UI shows what serve answers and sends what the
person submits.

`src/lib/app.ts` is the one place the UI names the app's actions. It calls
`connect<typeof tasksApp>()` from `@epicenter/app/client`, importing the app
as a type (`import type tasksApp from '../../../epicenter.js'`), and lists what the
pages watch and what they change with Wellcrafted (see `query-layer`):

```ts
const app = connect<typeof tasksApp>();
export const reads = resultQueries(['tasks'], { list: app.list, get: app.get });
export const writes = resultMutations(['tasks'], { add: app.add, set: app.set });
```

A page that reopens cannot rejoin a call. It shows what the app's records
say, so an action whose work outlasts the page writes its progress and its
outcome as records. An action that must not run twice takes an id the page
makes in its input and uses it as the record's id, so calling again with
the same id is safe. See the app package README for updates and the call
route.

On the wire, the host answers with `{ data, error }`. For a failure,
`error.kind` records what happened to this invocation (ADR-0926).
The browser client unwraps a `returned` reason with its public fields intact.
A `fault` becomes `Threw` and can carry a tagged exception in `thrown`.
A `refused` call becomes `Refused` before the action runs. Actions can use the
shared `ActionError` factories from `@epicenter/app`.

Match a browser error by its name and subject. A `Missing` for a dependency
cannot tell the page whether its displayed record still exists. An action
can make a write and then return an error. When saving is uncertain, keep
the submitted text and reread the record before clearing the draft.

Build the layout's QueryClient in the UI's own `src/lib/query-client.ts`
using its own `@tanstack/svelte-query` so the bundle carries one copy.
Check the helper's export in the app you copy. Provide the client through
`<QueryClientProvider>` and apply the invalidation rule from `query-layer`.
Pages read with `createQuery(() => reads.get({ id }))` and write with
`createMutation(() => writes.set)`. Use the server app's action types, for
example `ActionInput<typeof tasksApp.actions.set>` and
`ActionOutput<typeof tasksApp.actions.get>`.

An action that sends updates takes `onUpdate` after its input, to show its
work as it comes: `app.chat.say({ message }, { onUpdate: (token) => (draft += token) })`
resolves with the same Result once the reply is whole. Pass it where the page
keeps its draft, and make that call the mutation's function, so every read
still refreshes once it returns. Closing the view stops it listening; the
action runs on. A call cut off before its answer resolves to `Unreachable`:
reread the record before deciding what happened.

- Route a record by its id, which every row carries: the page is at
  `#/words/<id>`, the id URL-encoded, and calls `get({ id })` with the id
  from its route. Write no code that builds paths; show a record's name from
  its read (`row.id`).
- In a list, show a file's `Misfit` beside the other rows. Use its partial
  record for a repair form when present. Keep the fitting records usable.

- It is a phone Home Screen app first: safe-area insets, 44 px targets, 16 px
  inputs so iOS does not zoom, light and dark from the system.
- Send `set` only the fields being submitted, and `null` for one emptied.
  Do not spread an entire cached record into a field update. Comparing with
  cached data can avoid a request; it cannot establish what is currently saved.
  Submitting a title must not also write back a stale completion status from
  the cached record. Skip `set` when there are no submitted fields or body
  edits. The generated action returns `Refused` for an empty change.
  An unchanged-looking value may still be an intentional
  submission.
- When draft, recovery, or workflow promises are unsettled, use
  [product-collapse](../product-collapse/SKILL.md) to choose the behavior.
  For settled behavior, choose each input's owner with
  [input ownership](../svelte/references/input-ownership.md).
  Writes also arrive from other tabs, agents, and the command line; blocking
  local edits while pending prevents only this page's overlap.
- Use `set` with its quoted base (`edit: { old: base, new: draft }`, beside
  any fields) when the app promises conflict detection. On `Changed`, reread and preserve the submitted text
  while resolving the conflict. When last-write-wins is accepted, use the app's
  replacement action without adding rebasing or a recovery queue.
- Show a write before it lands from the mutations still pending:
  `useMutationState({ filters: { mutationKey: writes.set.mutationKey, status:
  'pending' } })` (Tasks' done, Vocab's review queue, Capture's adds). When the
  write settles, the refreshed read takes over. Say a failed write in a toast
  with `error.message`.
- Save on blur, on a pause, or on an explicit action, never on each keystroke.
  The home's commits sample those files later; a call is not a commit boundary.

### A draft over query data

For an explicit-save form whose live preview reads unfinished input, keep the
draft over the query's data so a refresh never overwrites typing. This view is
keyed by the record's id and receives a successfully read file; `Textarea`
and `Preview` are the app's components:

```svelte
<script lang="ts">
  let { file }: { file: { body: string } } = $props();
  let draft = $state<string>();
</script>

<Textarea
  aria-label="Notes"
  bind:value={() => draft ?? file.body, (value) => (draft = value)}
/>
<Preview text={draft ?? file.body} />
```

The preview gives this draft a live reader. Native controls remain the default
for input read only at submission. Use `??` here because an empty string is
real input. This example shows rendering and input ownership, not the whole
save handler. For conflict detection, capture the quoted base when editing
begins rather than replace it from a later refetch. Capture that base, the
submitted text, and record identity before async work.

Clear the draft only when saving is confirmed and completion still owns the
same record, editing session, and draft, or disable editing while saving.
Matching text alone is insufficient when the control can disappear or the
selection can change. An older save must not erase newer typing. Keep failed
or uncertain input for retry or deliberate discard, following
[input ownership](../svelte/references/input-ownership.md#explicit-submission).
An immediate editor that already owns accepted typing needs no second draft.

### Fields, body, and conflict responses

For a form that saves fields and a body together, send one generated `set`
with the record's `id`, submitted fields, and
`edit: { old: base, new: draft }`. The `set` verb checks the passage before
writing the file. If another writer changed the passage, the entire edit
returns `Changed`. A workflow that deliberately makes separate writes
must account for each completed write when a later one fails.

Two earlier app designs illustrate different responses to a body conflict:

- Capture's thoughts reapplied a small change against the newly read body.
  Use that response when the change can be reapplied without discarding the
  other writer's work.
- Tasks' "Keep mine" kept what was typed, said it was not saved, and let the
  person deliberately save over the other version. Use that response when
  choosing which content to keep belongs to the person.

These are strategy examples, not claims about those apps' current controls.
For `Changed`, first match its path to the requested record, reread, and
preserve the submitted text while resolving the conflict. A dependency can
report `Changed` for another path. Neither an error name nor cache invalidation
alone confirms what persisted. When last-write-wins is the agreed behavior,
use the replacement action rather than add conflict machinery by default.

## Verify without touching the person's data

Never run anything against the real `~/Epicenter` until the person asks.
Use a temporary home and a committed source. `new --from` copies code,
creates empty sibling data/, and prints `Run: cd <home> && bun install && bun
run build`; run it and read its errors. Uncommitted edits
are not copied. To test them, commit in a disposable copy outside the live
Epicenter, without changing the live branch or index.

```sh
bun test ./epicenter.test.ts                # from code/: actions over memory
source_path=/absolute/path/to/source        # choose a repository or subfolder
test_home=$(mktemp -d)
printf '[user]\n\tname = Test\n\temail = test@example.com\n' > "$test_home/.gitconfig"
HOME="$test_home" epicenter init "$test_home/Epicenter" --port 4799
cd "$test_home/Epicenter"
HOME="$test_home" epicenter new example --from "$source_path"
bun install && bun run build
HOME="$test_home" epicenter example --help
HOME="$test_home" epicenter serve               # drive /example/ on port 4799
```

Only serve runs an action, so keep that `serve` running, in the background or
another terminal, while you call `epicenter example <action>` in the temporary
home. Give the temporary home a port the real one does not use.

In the monorepo, the source CLI is `bun <repo>/packages/cli/src/bin.ts`.
The temporary Git configuration isolates identity and signing settings.
Run `bun run typecheck` and action tests from code/, where package.json lives.
Run tests one file or package at a time.

## Put an app in the person's Epicenter

Only when the person asks, on the computer that runs `epicenter serve`:

- `epicenter new <app> --from <folder | owner/repo/folder#ref>` takes committed code into
  apps/<app>/code/ and creates empty data/. It names the copy's package.json
  for the app, leaves out a copied bun.lock and any @epicenter/app entry, and prints
  the one command to run next: `cd <home> && bun install && bun run build`.
- To adapt later code, inspect a committed copy in a temporary home, then
  change the existing app's code/ deliberately. Preserve data/ beside it and
  repair records after changing fields. There is no automatic later merge.
  Inspect the source commit recorded in `code/SOURCE.md`, compare incoming
  code outside the live Epicenter, and test compatibility with the existing
  records before a named commit. A refreshed publication does not update
  apps people have already copied. Bring contributions back into the maintained
  app before refreshing an export, which would overwrite edits made in the
  generated directory.
- Back up the root to one optional private origin. The home's checkpoint
  script commits all pending files and pushes only there. Restore with one root clone
  and `bun install` at its top, then recreate what each app kept in `local/`.
- Sharing code requires a separate code-only history, deliberately made and
  reviewed for private content. Never publish the private root history.
  Make or clone that code-only repository outside the private Epicenter:
  a Git repository inside it makes the home's checkpoint script refuse.
  Use `epicenter export` for the generated code directory, then review, commit,
  and push the outer repository with Git. Recipients can read its history and
  notes as well as its code: keep private record content out of those messages,
  notes, and source files. Never publish the private root history.
- Run from inside the app's Epicenter. Another person's Epicenter is a
  different folder with its own port.

A running serve loads edited code on the next call. It serves code/ui/dist/
as the app's last `bun run build` left it.

### Export code for sharing

Keep the publication repository and its handwritten files outside the generated
directory. For one app:

```sh
epicenter export tasks ~/Code/shared-tasks/code
```

```text
shared-tasks/
  .git/          publication history
  README.md      publication notes
  code/          generated and replaced by export
    .epicenter-export.json
    epicenter.ts
```

Export copies code from the last commit and commits nothing. When an app's
`code/` has uncommitted changes it refuses: commit them with Git, then export.
It excludes records, local files, dependencies, builds, provenance, and private
history. It does not publish the exported code.

The command owns and replaces the generated directory, including edits and
extra files inside it. A destination must be new, empty, or carry the matching
export marker; Git metadata inside it is refused. Review and commit the exported
files in the outer publication repository before someone copies that version.
Exporting files does not commit them to the publication repository.

To publish several apps, `epicenter export --all ~/Code/shared-apps/apps`
generates one child per committed app under `apps/`. A recipient can copy one
published app with
`epicenter new tasks --from OWNER/shared-apps/apps/tasks`,
replacing `OWNER` with the publication owner's username. See
[the CLI's export contract](../../../packages/cli/README.md#export-app-code)
for destination rules and symlinks.
