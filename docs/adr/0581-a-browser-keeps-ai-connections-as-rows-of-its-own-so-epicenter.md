# 0581. A browser keeps AI connections as rows of its own so.epicenter

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) at "no `so.epicenter` folder is open there, so an app keeps its connections in its origin's storage, with the same fields as a row": a browser page opens its origin's own `so.epicenter` in OPFS and keeps connections as rows of the same `connections` table; only the `{ endpoint, key }` entry of [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md) stays in the page's storage.

## Context

Inside Epicenter, an AI connection is a row of `so.epicenter`'s `connections`
table (`kind`, `title`, `model`), its endpoint and key sit in the keychain
under the row's id, and `sendRequest` in `packages/ai/src/send.ts` sends by
kind. A browser page had two other models:

```txt
Vocab       InferenceSources {account, runtime, connections}   packages/ai/src/target.ts
            ConnectionCatalog in epicenter/ai/no-account.app-ai-connections
            InferenceSelections in vocab/no-account.app-ai-selections
            InferencePicker, 618 lines                          packages/ai/src/picker/
Whispering  whispering.connections {transcription, text}       apps/whispering/src/lib/workspace/browser.ts
```

Each had its own record shape, validation, cross-tab relay, and request
handling, and neither could express a connection's kind. `send.ts` already
had a browser's whole sending path, `SecretStore`, `saveKey`, `keyState`, and
`sendRequest` ending in `sendToEndpoint`, and nothing in a browser called it.
`@epicenter/folder/browser` opens any id as an OPFS folder, several per page,
and relays writes to other tabs over a `BroadcastChannel`. Settings' editor for
the table, `ConnectionList` and `ConnectionEditor`, reached the keychain
through five Tauri calls and nothing else that was desktop-only.

## Decision

**A browser page opens its origin's `so.epicenter` and keeps connections as
rows of the `connections` table.** `openBrowserConnections` in
`packages/ai/src/browser-connections.ts` calls `openFolder({ id:
CONNECTIONS_FOLDER_ID, definition: epicenterDefinition })`, and
`epicenterDefinition` in `packages/ai/src/connection-table.ts` is the one
declaration the CLI publishes on the desktop.

**A row's endpoint and key are `localStorage['so.epicenter.secret.<id>']`**,
holding what `saveKey` writes, `{ "endpoint": "<url>", "key": "<key>" }`
(`browserSecrets`).

**A request is sent by `sendRequest`, by the row's kind** (`sendFromBrowser`):

| Kind | In a browser |
| --- | --- |
| `openai-compatible` | the saved key, over the page's `fetch` |
| `epicenter` | `EpicenterAccess` answers `${account.baseURL}/v1`, an empty key, and the account's `fetch`, which adds the token and refuses every origin but the account's own (`packages/auth/src/browser-oauth.ts`) |
| `local` | `LocalNotSent` |

**Every app edits rows with the same editor.** `ConnectionList` and
`ConnectionEditor` are `@epicenter/ai/ui`, given a `ConnectionKeys`:
Settings passes `keychainKeys` (the CLI's key commands), a page passes
`browserKeys()`. In a browser the form says "The endpoint and key are saved in
this browser. Code running on this site can read them."

**An app's chosen connection is a connection id in its own folder's `kv`.**
Vocab's is `tutorConnection` in `so.epicenter.vocab/kv.json`; the picker,
`apps/vocab/src/routes/components/TutorPicker.svelte`, is a select over rows
and a "Connections" button that opens `ConnectionList`. With
`tutorConnection` unset, a signed-in learner's tutor is Epicenter's
`VOCAB_MODEL`, and no row is written for it. Vocab's dictation always sends to
the account with `HOSTED_TRANSCRIPTION_MODEL`.

**Nothing an earlier build kept in browser storage is read.**
`epicenter/ai/no-account.app-ai-connections`,
`vocab/no-account.app-ai-selections`, and `whispering.connections` are left
where they are and never opened; a page's connections start empty.

**Deleted from `packages/ai`:** `ai.ts`, `inference.ts`, `ai-connections.ts`,
`connection-catalog.ts`, `browser.ts`, `selections.ts`, `target.ts`,
`runtime-transcriber.ts`, and `picker/`, with their tests,
`scripts/ai-connections.browser.mjs`, and `scripts/inference-picker.browser.mjs`;
the `.`, `/connections`, `/picker`, `/selections`, and `/target` exports; and
`toHostedCatalog` in `@epicenter/constants`.

## Consequences

- One row shape, one table API, one editor, and one `sendRequest` serve
  Epicenter and a browser page. A page differs from Epicenter in its
  `ConnectionKeys` and its `EpicenterAccess`.
- A browser's `so.epicenter` belongs to its origin. Vocab and Whispering are
  on different origins and do not see each other's rows. Rows hold no secret,
  so syncing a browser's `so.epicenter` never carries a key.
- A key in `localStorage` is readable by any script on the origin.
- A Vocab connection names one model. Another model is another row, or an
  edit of this one.
- A learner who connected an endpoint in an earlier build connects it again.
- Each turn builds its client from what is saved at that moment, inside the
  turn, so a missing key or a gone row is that turn's error, shown after the
  learner's message is saved.

## Considered alternatives

- **Rows in `localStorage` with a row's fields.** What ADR-0557 wrote. Settings'
  editor reads `TableOptions` from a folder, so rows outside a folder need
  their own editor, parser, and cross-tab relay.
- **Keep `InferenceSources` for Vocab.** One consumer for about 3,000 lines,
  and a second model of a connection beside the table.
- **No custom connections in a browser, only Epicenter's hosted models.**
  Whispering's browser build has no sign-in, and Vocab works signed out with a
  learner's own endpoint.
