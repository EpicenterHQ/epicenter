# 0922. A file reaches an action as its own input beside `input`, on any call

- **Status:** Proposed
- **Date:** 2026-11-15
- **Amends:** [ADR-0915](0915-serve-owns-a-pages-runs-and-a-file-input-is-a-temporary-upload.md): withdraws `field.file` as a field, the refusal of file inputs by the command line and by ordinary `POST` calls, and keeping a run's input bytes after it ends without `returned`. Serve-owned runs, their journal, events, recovery, and limits stand.
- **Unbuilt:** all of it. `field.file`, `fileFieldOf`, `FILE_REFERENCE_PREFIX`, and `checkInput`'s `fileReferences` flag are on `main`.

## Context

ADR-0915 made a file input a field: `field.file()` in an action's `input`. Its
schema says the value is a string starting with `epicenter-file:`, and its type
says `UploadedFile`. Because the value is not JSON, every reader of `input`
carries an exception. The command line refuses the action, MCP leaves it out,
`defineCollection` scans for the marker and refuses it, `positional` refuses
it, `routines.set` refuses it, and an ordinary call from a page refuses a
`Blob`. The page's types ask an ordinary call for an `UploadedFile`, which a
browser cannot make.

ADR-0915 also lets a file arrive only through a run started with `runs.start`.
Of the three places the apps use runs, two send no file. A short action that
saves a photo still needs the journal, admission, and event log.

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

**Any call may carry a file.**

| Caller | How it gives a file |
| --- | --- |
| A page, ordinary call | `app.send({ reply, audio: blob })`, typed as `Blob` |
| A page, serve-owned run | `runs.start(app.send, { reply, audio: blob })`, as today |
| The command line | `--audio ./clip.m4a` |
| MCP and `routines.set` | cannot; an action with a required file is left out or refused |

An ordinary `POST /<app>/<action>` with files is `multipart/form-data`: a part
named `input` holding the JSON, and one part per file named for its entry. How
a run uploads its files before admission is not changed here.

**Input bytes are deleted when the call or the run ends, whatever its outcome.**

An action that needs the bytes afterward keeps them in the folder while it
runs, through a collection's slot.

## Consequences

- A page saves a file with one ordinary call. Long work takes two: keep the
  file with a short call, then start a run with the record's key. The run then
  takes only JSON, so the command line, MCP, and a routine can start it too.
- Keeping first also keeps the write lock short. An action holds the app's
  lock from its first write until it ends, so saving and then transcribing in
  one action holds it for the whole transcription.
- A failed run no longer holds a person's recording for 24 hours, and no
  longer loses it afterward: it was kept in the folder or it was never meant
  to be.
- The exceptions for `field.file` in `packages/app/src/action.ts`,
  `packages/app/src/collection.ts`, `packages/cli/src/input.ts`, and
  `packages/cli/src/mcp.ts` are deleted. What remains is one question per
  caller: can it carry bytes.
- An ordinary call with a file has no id to observe if its answer is lost.
  That is acceptable for a call that is short and safe to repeat, such as an
  `add` that refuses an existing file. Work that is neither belongs in a
  run.
- Not yet established: that the server reads a 15 MiB part without holding it
  in memory.

## Considered alternatives

- **Keep `field.file` and fix its types.** The value is still not JSON, so
  every reader of `input` keeps its exception.
- **Files only through runs.** Rejected above: most runs carry no file, and
  most file saves are short.
- **Keep failed input bytes and add a way to fetch them.** A second place a
  person's files live, with its own lifetime, beside the folder.
