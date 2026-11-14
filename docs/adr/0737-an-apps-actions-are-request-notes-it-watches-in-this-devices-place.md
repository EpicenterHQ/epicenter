# 0737. An app's actions are request notes it watches in this device's place

- **Status:** Superseded
- **Date:** 2026-11-04
- **Superseded by:** [ADR-0899](0899-the-folder-sync-product-is-retired.md): the folder sync product is retired, and this record is its history.
- **Relates:** [ADR-0723](0723-an-apps-site-is-found-by-convention.md) (an app's site publishes `/contract.json` and `/SKILL.md`; how it publishes actions was open), [ADR-0725](0725-an-app-reaches-named-roots-through-one-command-per-storage-operation.md) (an app watches files by root), [ADR-0727](0727-json-schema-is-the-field-language.md) (fields are JSON Schema), [ADR-0716](0716-agents-edit-a-document-through-one-shot-cli-commands.md) (agents edit documents through the CLI).
- **Unbuilt:** all of it: a request collection in any contract; an app watching its requests in AppData; deep link schemes for the standalone apps (only the Epicenter app registers one, `epicenter`, in `apps/epicenter/src-tauri/tauri.conf.json`).

## Context

A script or an agent can read and write an app's folder, because the folder
is files and the contract describes them. It cannot ask the app to do
something only the app can do: transcribe a file with the person's chosen
model, start a recording, or fetch new photos. ADR-0723 left how an app
publishes actions open.

The usual answers are a local socket with a verb registry, or a windowless
mode a script launches. Each gives the app a second interface beside its
files, with its own discovery, versioning, and authentication between
programs running as the same person. Whispering's shortcut already reaches
its page through an internal event, `whispering://toggle-recording`
(`apps/whispering/src-tauri/src/shortcut.rs`), which no other program can
send.

## Decision

**An app's action is a request note in its AppData, which the app watches
and handles when it runs.** A script or agent writes the note; the app
writes the result into its synced folder.

```txt
<AppData>/so.epicenter.whispering/requests/<id>.md   the request: front matter holds the input fields
~/Epicenter/whispering/recordings/<id>.md             the result, in the synced folder
```

- **A request lives in this device's place, not the folder.** A synced
  request would run once on every device; one in AppData runs on the device
  where it was written.
- **A request's input is contract fields.** The app's contract declares each
  request collection and its fields in JSON Schema, like any other
  collection, so a request is checked against its schema like any note.
- **The app handles a request when it runs.** A request written while the app
  is closed waits for its next launch. The app deletes a request it handled;
  one it refuses stays, with the refusal in its `error` field.
- **Discovery is the contract plus `/SKILL.md`.** The contract says which
  requests exist and what they take; the skill says when an agent should
  write one.

**An action that needs the app's window is a deep link.** `whispering://record`
launches the app, or brings it forward, and starts recording. A deep link
carries no result back.

**No socket, verb registry, or windowless mode exists** until a named action
needs a synchronous answer.

## Consequences

- A script needs no protocol beyond writing a note, and an agent needs no
  tool beyond its file tools.
- A request gets no answer in the same call. A script that needs the result
  watches the folder for the note the app writes.
- Requests queue across restarts with no extra state: the directory is the
  queue.
- An app that is never launched never handles its requests.
- Each standalone app registers a URL scheme for its deep links.

## Considered alternatives

- **A local socket with a verb registry.** A second interface to version and
  secure, for answers no named action needs yet.
- **A windowless mode a script launches.** A second way to run every app,
  and the app's state would be split between two running copies.
- **Requests in the synced folder.** Every device would handle each request.
- **Actions as CLI commands in the engine.** The engine would have to know
  each app's behavior, which only the app has.
