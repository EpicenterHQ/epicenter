# 0922. A file reaches an action as its own input beside `input`, and only a page sends one

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0915](0915-serve-owns-a-pages-runs-and-a-file-input-is-a-temporary-upload.md): withdraws `field.file` as a field, and keeping a run's input bytes after it ends without `returned`. Serve-owned runs, their store, events, recovery, and limits stand, as [ADR-0917](0917-a-pages-calls-are-serve-owned-runs-and-observing-is-not-cancelling.md) has them.
- **Unbuilt:** all of it. `field.file`, `fileFieldOf`, `FILE_REFERENCE_PREFIX`, and `checkInput`'s `fileReferences` flag are on `main`.

## Context

ADR-0915 made a file input a field: `field.file()` in an action's `input`. Its
schema says the value is a string starting with `epicenter-file:`, and its
type says `UploadedFile`. Because the value is not JSON, every reader of
`input` carries an exception. The command line refuses the action, MCP leaves
it out, `defineCollection` scans for the marker and refuses it, and
`routines.set` refuses it.

ADR-0917 made every call from a page a serve-owned run, so an awaited call
and `runs.start` carry a `Blob` the same way. Which page calls may carry a
file is no longer a question.

A run's input bytes are deleted when it returns and kept 24 hours otherwise.
Nothing can read the kept bytes and no run is run again, so the bytes kept
after a failure are out of reach until they expire.

## Decision

**An action declares the files it takes in `files`, beside `input`. `input` holds only JSON.**

```ts
const send = defineAction({
  description: 'Transcribe and send a voice reply',
  input: { reply: field.ref(replies) },
  files: { audio: { accept: ['audio/*'], maxBytes: 20_000_000 } },
  run: async ({ reply, audio }) => { /* audio is an UploadedFile */ },
});
```

An entry of `files` is `{ accept?, maxBytes?, optional? }`, the same shape as a
collection's slot
([ADR-0919](0919-a-collection-declares-its-files-beside-its-fields-and-they-rest-in-the-folder-named-by-its-key.md)).
`run` receives the files and the input in one object. A file may not share a
name with an input field. `field.file`, `fileFieldOf`, `FILE_REFERENCE_PREFIX`,
the `x-epicenter-file` marker, and the scans for it are removed.

**Only a page sends a file.**

| Caller | How it gives a file |
| --- | --- |
| A page | `app.send({ reply, audio: blob })` or `runs.start(app.send, { reply, audio: blob })`, typed as `Blob` |
| The command line, MCP, and `routines.set` | cannot; an action with a required file is refused or left out |

The command line's input is one JSON object
([ADR-0925](0925-an-actions-input-on-the-command-line-is-one-json-object.md)),
and JSON carries no bytes. A caller on the home's own computer puts the file
in the folder, where a collection's slot expects it, and then calls an action
with the record's key.

**Input bytes are deleted when the run ends, whatever its outcome.**

An action that needs the bytes afterward keeps them in the folder while it
runs, through a collection's slot.

## Consequences

- An action meant for every caller takes a record's key, not a file. A page
  keeps the file with one short call, then starts the long work with the
  key. The command line, MCP, and a routine can start that work too.
- Keeping first also keeps the write lock short. An action holds the app's
  lock from its first write until it ends, so saving and then transcribing in
  one action holds it for the whole transcription.
- A failed run no longer holds a person's recording for 24 hours, and no
  longer loses it afterward: it was kept in the folder or it was never meant
  to be.
- The exceptions for `field.file` in `packages/app/src/action.ts`,
  `packages/app/src/collection.ts`, `packages/cli/src/input.ts`, and
  `packages/cli/src/mcp.ts` are deleted. What remains is one question per
  caller: is it a page.

## Considered alternatives

- **Keep `field.file` and fix its types.** The value is still not JSON, so
  every reader of `input` keeps its exception.
- **A command-line flag that names a path, such as `--audio ./clip.m4a`.** A
  second kind of argument beside the one JSON object, for a caller that can
  already put the file in the folder.
- **Keep failed input bytes and add a way to fetch them.** A second place a
  person's files live, with its own lifetime, beside the folder.
