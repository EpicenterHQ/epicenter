# Recipes, connections, and the pasted-text playground (October 3, 2026)

Execution notes for one slice. The README describes the behavior; ARCHITECTURE
describes the structure. On October 17, 2026 the clean break deleted three
things this record describes: the recipe `endpoint` constraint, the `kv.json`
form fill, and adopting the earlier transcription key. This file records the decision, what it costs an
existing folder or device, and what was and was not verified.

## Decision

A recipe is a reusable title and instructions: a row in `transformations/`.
Running one is generic: instructions, plain input text, and a resolved model
go to the text connection. Whispering keeps its transcript adapter (a
transcript run names its recording and transcription, and deleting the
recording deletes its results) and its result-publication guarantees.

Where a request goes and which key it carries belong to the device, not the
folder. There are two private connections, transcription and text, each a
canonical base URL, a default model, and an optional key. There is no
registry, catalog, or per-recipe binding.

- The page names the base URL a request was prepared for (`expectedBaseUrl`);
  the host and the browser workspace read the connection once at entry and
  send to the connection's own URL only when it matches exactly. A request
  never chooses a destination, and a change saved while one is out does not
  move it.
- The default model lives with the connection, not in `kv.json`: a model name
  means something only to the endpoint that serves it, and a portable default
  would be wrong on a device whose connection points elsewhere. A recipe may
  name its own model.
- A recipe written by an earlier build names an endpoint. It is kept as an
  exact constraint (canonical full base URL, no same-origin relaxation), never
  as routing, and the recipe page offers to remove it. New recipes write
  `model: null` and `endpoint: null`; the schema cannot represent a missing
  field, so `null` is the explicit "use the connection".
- `WHISPERING_TRANSCRIPTION_API_KEY` is a read-only transcription connection
  at the launch's base URL and model. It is never lent to text. There is no
  text environment variable.
- The earlier single key stays in the device file (or `localStorage`), unused,
  until the person ticks destinations in Settings; the host moves it there
  without returning it.
- `src/lib/recipe.ts` is the one resolver. The Run check, the post-processing
  chooser, the transcript Transform menu, the recipe page, and both run entry
  points use it.
- One run lifecycle in `library.svelte.ts` serves transcript and pasted-text
  runs; the destination is the only difference. Pasted-text answers are held
  until Save and written to the new `text_runs/` table.

## Migration cost

- Transcription no longer works until the transcription connection is saved
  (or the launch sets `WHISPERING_TRANSCRIPTION_API_KEY`). The form starts
  from `kv.json`'s endpoint and model when they exist; a key must be entered,
  or the earlier key moved, explicitly.
- Transformations no longer run until the text connection is saved.
- An earlier recipe whose endpoint differs from the text connection does not
  run until its endpoint is removed or the connection changed. Nothing
  rewrites it automatically.
- `kv.json` is never written again. The kv save path and its tests are
  deleted.
- The bridge operation `credential` is removed; `connections`,
  `set-connection`, and `adopt-legacy-key` replace it. The Epicenter host's
  Whispering commands are not affected; this app does not call them.
- No file is renamed or moved. Earlier `transformation_runs/` rows read
  unchanged.

## Verified

Codex reproduced these checks in the live checkout after integration and review
fixes. Claude Opus 5.5 produced the isolated implementation; its sandbox blocked
the loopback redirect test. The live run below includes that test.

| Check | Result |
| --- | --- |
| `bun test --isolate` from `apps/whispering` | 366 passed, zero failed, 2490 assertions, 23 files. |
| `bun run --cwd apps/whispering typecheck` | Zero Svelte errors and warnings; native TypeScript check passed. |
| `bun run --cwd apps/whispering build` | Passed. |

What the tests establish, against real directories and Git, with stubbed
endpoints that count every request:

- The host and the browser send only to the configured connection with its
  key; a request prepared for another URL (another path on the same origin, a
  folder's or recipe's URL) is refused with nothing sent; a change saved while
  a request is out leaves that request's URL and key alone; a key cannot be
  kept for a new endpoint; the environment key is read-only and never sent to
  text; the earlier key is lent to nothing and moves only on request; replies
  never contain a key; requests set `redirect: 'error'` and
  `credentials: 'omit'`.
- Earlier recipes and result files read without issues; new and earlier
  recipes resolve the same way in every caller.
- Pasted text runs without recordings, holds its answer, fixes its snapshot
  before sending, refuses a second run per recipe, saves once across failed,
  lost, and concurrent saves without a second request, refuses to overwrite
  another file, does not restore a discarded answer, retries only over the
  same connection, holds the close guard, survives navigation in the session,
  and never blocks recording deletion.

## Browser acceptance

Codex exercised Chrome at `http://127.0.0.1:5301` with a disposable keyless
OpenAI-compatible fixture at `http://127.0.0.1:5302/v1`. No microphone,
personal credential, or paid provider was used.

1. Saved the text connection with model `fixture-chat`, leaving transcription
   unconfigured. No recording was needed.
2. Created a default-model recipe and ran it on pasted text. The original and
   fixture result appeared with explicit Save, Copy, and Discard.
3. Changed the pasted input, navigated Home, and reopened the held result.
   The input as sent and result remained unchanged.
4. Saved it to `text_runs/20261003-042532-5s5s.md`. The file held the captured
   title, instructions, original input, model, endpoint, and result.
5. Reloaded and reopened the saved file. The result remained present. The
   fixture log recorded exactly one request across Run, Save, and reload.

The screenshot is `/tmp/epicenter-recipes-after-20261003.png` on the test device;
it is evidence for this run, not a repository asset.

## Review corrections

- An existing malformed connection is refused by setup and legacy adoption,
  rather than treated as absent and overwritten. Its key stays recoverable.
  Native and browser regression tests cover keep, remove, replace, and adoption.
- A failed pasted-text run says "No result was received." A missing host reply
  does not prove that the provider never ran. Retrying remains explicit.
- Independent Codex and Opus reviews agreed that destination and credential
  ownership belong together. The implementation uses two operation slots rather
  than Opus's proposed connection registry: there are only two consumers today.

## Not verified

- Native window interaction, microphone capture, and operating-system close
  behavior were not exercised in this slice. Host and session tests cover the
  relevant logic; they do not establish native GUI behavior.
- No real provider was called. The fixture proves request and save plumbing,
  not transformation quality.
- No Rust or shell change was made or compiled.
