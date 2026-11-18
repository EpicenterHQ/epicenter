# 0930. An action call is a function call, and serve keeps nothing about it

- **Status:** Accepted
- **Date:** 2026-11-16
- **Supersedes:** [ADR-0915](0915-serve-owns-a-pages-runs-and-a-file-input-is-a-temporary-upload.md) (serve-owned runs and temporary file uploads) and [ADR-0917](0917-a-pages-calls-are-serve-owned-runs-and-observing-is-not-cancelling.md) (every page call is a durable run), once accepted.
- **Amends:** [ADR-0926](0926-a-collections-methods-return-results-and-a-file-that-is-not-a-record-is-an-error.md) on HTTP and replay: its answer table stands, and its `/.runs/` routes, admission header, replay and `runs.start(...).result()` go. [ADR-0883](0883-an-epicenter-is-its-git-repositories-and-serve-and-its-host-keeps-runs-and-guards-them.md) on serve keeping runs: serve keeps none. [ADR-0879](0879-an-action-may-yield-values-while-it-runs-and-only-its-return-is-the-answer.md) on how an action reports: `run` takes an `update` function in place of being an `async function*`, and the CLI may show updates. Its rule that only the return is the answer stands.
- **Amends also:** [ADR-0914](0914-action-errors-share-one-contract-and-the-envelope-records-execution.md) on `Stopped`: nothing stops an action from outside, so the kind goes.
- **Amended by:** [ADR-0953](0953-an-actions-answer-is-data-or-error-and-its-input-is-one-json-schema.md) on the answer frame: `{"answer": ...}` carries the plain `{ data, error }`, and a refusal before the action runs is `NotStarted`. [ADR-0966](0966-serve-keeps-action-calls-outside-an-apps-address-which-is-apps-name.md) on the routes: an action call is `POST /actions/<app>/<word>/<word>`, and the UI is at `/apps/<app>/`.
- **Relates:** [ADR-0850](0850-an-action-changes-files-and-whoever-knows-the-intent-commits-them.md) (no app lock), [ADR-0938](0938-an-action-says-whether-agents-are-offered-it.md) (`mcp: false`; no private input), [ADR-0936](0936-one-serve-per-home-runs-every-action.md) (one process runs actions).

## Context

ADR-0915 and ADR-0917 made every page call a run that serve owns. Serve
writes the run to SQLite before answering, gives it an id, keeps its events
for 24 hours, and replays them to any page that attaches. The page keeps a
receipt in localStorage so it can find the run after a reload. Files arrive
first as temporary uploads, by PUT, and the call refers to them. The reason
was that a page could lose its connection after an action changed files, and
calling again might repeat the change.

That machinery is about 2,100 lines across `runs.ts`, `run-store.ts` and
`run-client.ts`, plus admission, a 512 MiB space budget, observer and
concurrency limits, a cancel route, and an upload lifetime. It answers a
question an Epicenter mostly does not ask. One person owns the home, and
every app is their own trusted code. The things they need to see later are
already records: a synced mailbox, a fare search, a chat reply. A run
history in a store outside the repository is a second, disposable copy of
what the records say, and it disappears in 24 hours anyway.

The apps that use runs bear this out. They use `runs.start` so a long job
keeps going when the page closes, and so the page can show it again after a
reload. Serve finishing the action does the first. Rereading a status
record does the second, and it survives a restart of serve, which a run in
SQLite marked `interrupted` does not.

## Decision

An action is a function: JSON in, optional updates while it runs, JSON out.
Serve calls it and forgets it.

```ts
// mail/code/epicenter.ts
sync: defineAction({
  description: 'Copy new mail from Gmail',
  input: { account: field.text() },
  async run({ account }, update: Update<Progress>) {
    update({ account, phase: 'starting' });
    return Ok(await fill(account, update)); // fill is a plain async function
  },
}),

// any caller, in the home or in a page
await sync({ account }, { onUpdate: (progress) => show(progress) });
```

- **An action reports by calling `update`.** `run` receives its input and a
  second argument, `update`, a function that takes one value that survives
  JSON and returns nothing. `run` is never an `async function*`. The action
  annotates the argument as `Update<T>`, exported by `@epicenter/app`, and
  that `T` is the type of every caller's `onUpdate`; an action that leaves the
  argument out sends no updates and its callers take no `onUpdate`. A helper
  that reports takes `update` as an ordinary parameter, as it takes a signal,
  so it stays a plain async function and can report from inside
  `Promise.all` or an event listener. `runYielding`, `drain` and the
  generator form of `defineAction` are removed, and `ActionYield` becomes
  `ActionUpdate`.
- **Every caller calls the same way, and any of them may listen.** In the
  home, `action(input, { onUpdate })`. In a page, the client from `connect()`
  takes the same two arguments. The CLI writes each update to stderr as one
  line of JSON and the answer to stdout, as now. MCP sends the tool result
  alone. A caller that passes no `onUpdate` loses nothing: an update reports,
  and is never a fact the caller acts on, such as "accepted". A page shows
  the right thing after the call ends if every update was lost.
- **One route per action.** `POST /<app>/<action>` takes the input as a JSON
  body and answers an NDJSON stream: `{"update": value}` for each update, then
  `{"answer": ...}` with the ADR-0926 answer. A stream that ends without an
  `answer` line was cut off, and its outcome is unknown; a caller rereads the
  record. A refusal before the action runs is that answer alone, as the
  body of a 400, whatever was refused. `GET /<app>/...` serves the app's UI, where it
  is today. `POST /` is MCP, which calls the
  same function in serve. The CLI sends its call to this route and never runs
  an action itself (ADR-0936).
- **The home always finishes what it starts.** A client that disconnects
  stops reading; the action runs to its end. Nothing aborts it from outside.
  `update` returns at once and never throws: what a listener returns is not
  awaited and what it throws is dropped, so neither a slow client nor a lost
  connection reaches the action. HTTP buffers updates for a slow client, in
  order, because an update can be a piece of text that the next one extends,
  and discards them once the client is gone.
- **Serve keeps nothing about calls.** There are no run ids, run store,
  replay, receipts, attach, admission header, cancel route, observer limit
  or space budget. `runs.start`, `runs.attach`, `runs.pending`,
  `isRemembered`, `callId()` and `callSignal()` are removed.
- **Long work is an action that runs long, and what it leaves is data.**
  Epicenter has no lock, no "is it running" question and no stop. Two calls
  of the same action both run. An action that can run long sets its own
  deadline, and it ends by itself or when serve restarts. What a page shows
  after a reload comes from the app's own records: the data the work has made
  so far (Mail's copied messages, a saved learner turn), and an outcome
  record written when the work ends. An app that wants other tabs to see
  that work is running writes its own status file while it runs and deletes
  it at the end. Epicenter gives that file no heartbeat or schema.
- **Nothing a call holds blocks another call.** One process runs every
  action (ADR-0936) and an app has no lock, so a long action can write as it
  goes while another call of its app reads or writes.
- **Epicenter does not make a repeated call safe.** A caller whose stream was
  cut rereads the record. An action that must not run twice takes an id in
  its input, as an app's own rule: it names the record with it, where adding
  a file that is already there fails, or hands it to an outside service as
  its key. Codex's `clientUserMessageId` is the pattern.
- **Bytes are text.** `field.file` and uploads are removed. A small file is a
  base64 string in an ordinary text field, declared with JSON Schema
  `contentEncoding: "base64"` and `contentMediaType`, so the CLI and MCP can
  send it too. The CLI reads an input that large from stdin. The input limit
  rises from 1 MiB to 25 MiB. A file worth keeping, or too large for that,
  reaches the app's `data` folder another way (Taildrop, a syncer, a copy)
  and an action files it there.

The author's surface is `defineApp`, the app's data declaration
(`defineData`), `defineAction` (whose `run` may call `update`),
`Update`, `field.*` and `folder`. A routine runs a command on a schedule. When that command
calls an action, it is one more caller (ADR-0936), and what the routine
keeps about its attempts is scheduling, not a record of calls.

## Consequences

- A page reload loses the updates of a call it was watching. Updates are for
  whoever is watching now, such as a tutor's reply arriving token by token;
  records are what survives.
- Calling again is safe only for actions that are safe to repeat or that take
  an id. A task added twice after a lost answer is a duplicate the person
  deletes. The platform no longer pretends otherwise: ADR-0917 already conceded
  that an interrupted run "does not prove which effects occurred".
- An outcome that today reaches the page only in the answer must move into a
  record, or a reload loses it. The trace of the apps found four: Flights'
  failed, stopped and stale searches; Mail's last sync error and quota wait;
  a Zhongwen turn in progress, and a new conversation's key; and
  Codex's "preparing" suggestions. Today a page gets them back by replaying
  the run, for 24 hours and only in the browser that started it.
- Closing a page no longer stops the work. A suggestion or a tutor reply runs
  to its end and spends its tokens. No page has a Stop.
- Codex replies have no Stop. Its only stoppable window was transcription,
  and a reply already queued in Codex could never be recalled.
- Zhongwen saves the learner's message at once, streams the tutor's text as
  updates, and adds the tutor's turn when it finishes. After a reload
  the page shows the message, and shows that the tutor is replying only if
  the app wrote a status file saying so. `start` takes its conversation key in its input so a reload can
  find it. No in-progress file is needed.
- Mail shows progress from its data and drops its SQLite lock. Flights'
  daily research drops its heartbeat, its stop file and its `lockf`
  processes: it is one action with its own 15-minute deadline, run by a
  routine, and it calls `searchFares` in-process instead of starting
  searches through serve with `runs.start`. Codex drops its queue.
- `.local` keeps one meaning, a file that never leaves this computer. An
  outcome record is an ordinary record, written once per run, and a past
  failure is worth its line of history.
- Base64 costs a third more bytes on the wire and holds the whole file in
  memory. At 25 MiB that is a ceiling the home can carry; voice notes at
  32 kbps fit about 80 minutes.
- MCP and the CLI can call every action, because no action takes a file
  reference only a page can make and none has private input (ADR-0938).
- Nothing about calls needs migrating or cleaning: serve's run directory and
  the browser's receipts can be deleted when this lands.

- The 17 `yield` statements and 19 `yield*` delegations in the apps become
  calls and plain awaits. Mail holds 10 and 9 of them: `syncAccount`,
  `changesSince` and `fill` in `lib/sync.ts` lose their hand-written
  `AsyncGenerator<Progress, Result<…>, undefined>` types. Zhongwen's
  `tutorSays` already takes a `delivered` callback beside its
  `yield`; the two become one.
- An agent building an app sees an action's updates from the CLI, without a
  browser.
- An action's update type is one annotation instead of an inference from
  what it yields, and an action that forgets the annotation gets a type error
  at its first `update(...)`.
- Work is seen two ways while it runs: by the tab that started it, through
  updates, and by every other tab, through a read of what the work has
  written. An app can drop the first and keep one path; Mail's progress
  already comes from its cache.
- Two starts of the same long work both run. Mail's two downloads of one
  account split the quota and both finish; a second Flights daily run runs a
  second time. That is accepted.

## Considered alternatives

- **Keep `async function*` and `yield` (ADR-0879).** A generator lets its
  consumer set the pace and stop it, and this record takes both away, so only
  the syntax was left. It also made every helper that reports a generator
  its callers must delegate to with `yield*`, and it cannot report from a
  callback or from two awaits at once. Its yield type was inferred; a sketch
  showed TypeScript infers the update type from the annotated argument just
  as well.
- **An ambient `report()` found through the running call.** No argument to
  thread, but nothing ties its value to the action's type, and a helper's
  signature no longer says it reports.
- **Declare an `updates` schema beside `input`.** It would let serve check
  each update, which only a page the same app wrote reads. The answer has no
  declared schema either.
- **No updates; a page watches the app's files.** A reload would lose
  nothing, but serve would need a channel that follows file changes, and a
  tutor's reply would be a file write per token.
- **MCP progress notifications for updates.** Nothing calls a tool long
  enough to need them. They fit when a client's timeout does.

- **Keep durable runs (ADR-0915, ADR-0917).** It protects a page that lost an
  answer from calling twice, at the cost of a second store, retention rules,
  limits and an observation protocol. An id in the input gives the same
  protection only to the actions that need it, and the store forgot
  everything after 24 hours.
- **A status record with a heartbeat, and a stop file.** A drafted version of
  this record had long work write `state` and `updatedAt` every second, treat
  a record that stopped moving as stale, and poll a stop file. That is a
  protocol every long action would have to follow. An app that wants a
  status file writes one its own way, and Epicenter knows nothing about it.
- **A named lock kept in serve's memory, with `lock`, `locked` and `stop`.**
  A later draft answered "is it running" exactly and carried a stop. It was
  three functions and a table for a question a single owner rarely asks, and
  two runs of the same work are accepted.
- **Move the UI and calls under `/apps/<app>/`.** The prefix kept routes away
  from `/.runs/`. With runs gone nothing collides with `/<app>/`, and moving
  would break bookmarks for nothing.
- **Keep runs in memory only.** It keeps attach and stop while a serve
  process lives, but a restart loses them, so pages still need records to be
  correct. Two ways to see the same progress.
- **A cancel signal from the client.** A dropped connection and a deliberate
  stop look the same on the wire, so a phone losing signal would stop work.
- **A file as its own input beside `input`, sent only by a page.** A draft of
  this (ADR-0922, deleted) kept uploads and gave files a second request
  shape. The CLI and MCP still could not send one.
- **Multipart form bodies for files.** It saves the base64 overhead, but the
  CLI and MCP cannot send it, and it needs a second request shape for one
  kind of field.
- **Uploads separate from calls, resumable or in parts.** They serve files of
  gigabytes from a phone browser. Those belong in the folder, where a syncer
  already resumes them; a call is small.
