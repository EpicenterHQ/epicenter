# 0582. Whispering's results name the connection they were sent over

- **Status:** Proposed
- **Date:** 2026-10-16
- **Amends:** [ADR-0502](0502-whispering-connections-own-request-destinations-and-credentials.md) at its two private operation connections, legacy-key adoption, the recipe `endpoint` read as a constraint, and `expectedBaseUrl`: each operation chooses a row of `so.epicenter` by id, nothing an earlier build saved is read, and a result row names the connection it went over.
- **Relates:** [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md) (`transcriptionConnection` and `textConnection`), [ADR-0581](0581-a-browser-keeps-ai-connections-as-rows-of-its-own-so-epicenter.md) (the browser's `so.epicenter`).

## Context

ADR-0502 gave Whispering two private connections, transcription and text,
each a base URL, a default model, and an optional key, and checked every
request against the base URL it was prepared for (`expectedBaseUrl`). A result
row recorded `model` and `endpoint`, and **Run again** sent its request only
while the operation's connection was still that base URL. Inside Epicenter the
two connections became the fixed rows `whispering-transcription` and
`whispering-text` (ADR-0557); in a browser they stayed in
`whispering.connections`.

With connections as rows any app can add, two rows can share an endpoint
with different keys, such as a personal and a work account at one provider.
An endpoint alone does not say which key a request was billed to.

## Decision

**Each operation names a connection by id, and a request goes over that row,
read when it is sent.** `kv.json` holds `transcriptionConnection` and
`textConnection`. `routeOf` in `apps/whispering/src/lib/connection-routes.ts`
reads the row and answers its kind, the exact model, and the endpoint:

| Kind | Model | Endpoint |
| --- | --- | --- |
| `openai-compatible` | a recipe's own, else the row's | the endpoint saved for the row |
| `epicenter` | a recipe's own, else the row's | the signed-in deployment's `/v1` |
| `local` | the row's, else Epicenter's active model | empty |

A `local` row is offered only in Epicenter, and only for transcription.

**A result row records `connection`, `endpoint`, and `model`, and Run again
sends over that connection to that endpoint.** `recordedRoute` rebuilds the
route from the row: the connection must still exist, an `epicenter` row must
still send to the recorded `/v1`, and an `openai-compatible` request names the
recorded endpoint, which `sendRequest` refuses with `EndpointChanged` when the
saved endpoint moved. What each operation chooses now does not change it.
`connection` is optional, so a row written before it reads; such a row is not
sent again.

**Nothing an earlier build saved is read.** `whispering.connections`, the
single key at `whispering.transcriptionApiKey`, and `kv.json`'s
`transcriptionBaseUrl` and `transcriptionModel` stay where they are. A
recipe's `endpoint` is no longer declared; the line stays in its file and does
not decide where it runs.

## Consequences

- Two connections at one endpoint never stand in for each other on Run again.
- A person whose earlier build held connections sets one up again in Settings.
- A recipe an earlier build pinned to an endpoint, such as a local server, now
  runs over whichever connection is the text connection.
- Local transcription is reachable from Settings for the first time, as a
  `local` connection, and every transcript names the exact model.
- Deleted: `apps/whispering/src/lib/connections.ts`, `settings-draft.svelte.ts`,
  `ConnectionForm.svelte`, `workspace/desktop-connections.ts`,
  `transcription.ts`, and `transformation.ts`; `workspace.transcribe`,
  `workspace.transform`, and `transformNote`.

## Considered alternatives

- **Record only the endpoint and send over the connection chosen now.** Two
  rows at one endpoint would send a retried request with the other row's key.
- **Import the earlier connections once.** Decided against: a clean break.
