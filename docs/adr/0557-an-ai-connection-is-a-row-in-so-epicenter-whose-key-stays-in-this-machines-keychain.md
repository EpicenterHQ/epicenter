# 0557. An AI connection is a row in so.epicenter whose key stays in this machine's keychain

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0552](0552-every-app-is-installed-from-a-folder-in-any-git-repository.md) at "AI settings live in `kv.json` in `so.epicenter`": AI connections are rows of a `connections` table in `so.epicenter`, read by every app, and which connection an app uses is the app's own setting in its own folder.
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at "model choices" in `kv.json`: each connection row names its model, and an app's choice of connection is in the app's own folder.
- **Amended by:** [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md) at the row's `endpoint` field, the `savedForAnotherAddress` state, the kind named `endpoint`, the key commands' names and arguments, and the capability-file rule that lets an app into `so.epicenter`: the endpoint lives only in the keychain entry, the kind is `openai-compatible`, and `AI_CONNECTION_APPS` names the apps whose windows open `so.epicenter`.
- **Relates:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (trust covers code, never data). [ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md) (the Epicenter account's access tokens). [ADR-0551](0551-every-write-to-a-folder-file-is-one-save-that-merges-by-the-files-kind-and-sync-settles-with-the-same-merge.md) (a row merges per field). [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) (native code through `invoke`, granted by app id). [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (the shared `send` command), [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) (`epicenter auth key`), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) (one capability file per app).
- **Unbuilt:** all of it: the `connections` table, the browser build's sending path and key warning, the keychain entry per connection, the AI target of `send` and the key commands, the fetch-shaped shim, Settings opening `so.epicenter`, and the deletions below. Before Whispering's transcription moves to `send`, a 30 MB WAV must go through it to a local echo endpoint and be timed against today's `/_epicenter/ai/*/inference` path.

## Context

Epicenter's AI connections live in its Bun host. `createAiCatalog`
<!-- doc-path-check: ignore-next-line -->
(`apps/epicenter/src/ai-catalog.ts:135`) keeps each entry (`id`, `name`,
`baseUrl`, `models`, `hasApiKey`, `accessVersion`) in
`ai/<owner>/connections.json` under app data (`:147`), and each key in the
keychain under the secret app id `so.epicenter.ai-catalog` (`:39`), reached
through Rust over the sidecar pipe (`apps/epicenter/src-tauri/src/keyring_storage.rs`).
Pages read and edit the catalog at `/_epicenter/ai/<owner>/connections`, follow
it over server-sent events, and send requests to
`/_epicenter/ai/<owner>/inference/<id>/<accessVersion>/…`, where `forward`
adds `Authorization: Bearer <key>` and refuses redirects (`ai-catalog.ts:382-523`;
<!-- doc-path-check: ignore-next-line -->
routes in `apps/epicenter/src/ai-catalog-routes.ts:10-73`, mounted at
`apps/epicenter/src/server.ts:168-181`).

Installed Whispering keeps its two connections there as "Whispering
transcription" and "Whispering text", and remembers their ids in its origin's
<!-- doc-path-check: ignore-next-line -->
`localStorage` (`apps/whispering/src/lib/workspace/epicenter-connections.ts:43-47`,
`:97`). Its rules (`apps/whispering/src/lib/connections.ts:1-16`) say a key is
kept only for the base URL it was saved for, and that the folder's files never
choose where a request goes.

So connections do not follow a person to another machine, an agent cannot list
them, and each machine's list is set up by hand. ADR-0552 says AI settings
belong in `so.epicenter`; it does not say what happens to the key, or to the
rule that a synced file never chooses where a key goes. ADR-0556 removes the
Bun host, so the catalog and its proxy need another home in any case.

## Decision

**An AI connection is a row in `so.epicenter`, and its key lives only in this
machine's keychain, bound to the endpoint it was saved for.**

```txt
~/Epicenter/so.epicenter/connections/<id>.md    synced; edited by pages, people, and agents
  kind: endpoint | epicenter | local
  title: Groq
  endpoint: https://api.groq.com/openai/v1      only for kind endpoint
  model: whisper-large-v3                        names the model on every kind

Keychain (this machine only)                    written and read only by the epicenter CLI
  connection <id> → { endpoint, key }            key may be empty for a keyless endpoint
```

`connections` is a table of `epicenterDefinition`
(`apps/epicenter/src/folders/epicenter-folder.ts:30`), beside `apps`. Pages
write rows through the folder engine, so each connection is its own file,
versioned, and synced when `so.epicenter` is connected.

**A connection has one of three kinds.**

| `kind` | Request goes to | Credential | On a machine that has not set it up |
| --- | --- | --- | --- |
| `endpoint` | `endpoint`, OpenAI wire | the keychain entry for this id, if any | "Add your key on this computer" |
| `epicenter` | the deployment's API origin ([ADR-0326](0326-the-deployment-names-the-authority-and-a-person-never-types-one.md)) plus `/v1` | the account's access token, which `epicenter send` reads itself (ADR-0556) | "Sign in to Epicenter" |
| `local` | no request; `transcribe_audio_bytes(model_id, …)` with the row's `model` | none | "Download the model on this computer" |

**The CLI sends every AI request, and no page reads a saved key.** The page
calls ADR-0556's `send` command with an AI target, `{ connection: id, endpoint }`,
plus the method, path, headers, body, and a `Channel`. Rust runs
`epicenter send`, writes the body to its stdin, and pipes its NDJSON to the
`Channel`. The CLI reads the keychain entry for `id`,
refuses unless the entry's endpoint equals the `endpoint` the page read from
the row, sends to that endpoint plus the path with the key, refuses
redirects, and streams the response. Multipart audio crosses as raw bytes. The fetch-shaped
shim ADR-0556 names wraps it, so the OpenAI SDK and Whispering's transcription
keep calling `fetch`.

**A synced change to an endpoint does not move a key.** The keychain entry
records the endpoint it was saved for. When a row arrives from another
machine, or an agent edits it, with a different `endpoint`, `ai_key_state(id,
endpoint)` answers `savedForAnotherAddress` and the connection shows "Add your
key on this computer" again. A keyless endpoint is confirmed the same way,
with an empty key, so a synced edit cannot send recordings somewhere new.

**Three commands manage keys.** Each is a fixed Rust command that runs one
fixed CLI invocation (ADR-0556, ADR-0558):

```txt
set_ai_key(id, endpoint, key)   epicenter auth key set <id> --endpoint <url>     the key on stdin
remove_ai_key(id)               epicenter auth key remove <id>
ai_key_state(id, endpoint)      epicenter auth key state <id> --endpoint <url>   missing | saved | savedForAnotherAddress
```

`ai_key_state` never answers with the key, and a key never crosses in
arguments.

**Pickers read the table with `folderOptions` on `so.epicenter`.** Settings
opens `so.epicenter` and edits connections. When the shell opens an app's
window, it permits the window into `so.epicenter` if the app's capability
file, `installed-<app>.json`, grants `send`; the window lists `connections` and
may add or edit rows. Which
connection an app uses for each of its operations is the app's own setting, in
its own folder: Whispering's `transcriptionConnection` and `textConnection`
are connection ids in `so.epicenter.whispering/kv.json`.

**One implementation builds every request.** `@epicenter/ai` builds the
request for a connection and reads its response; `epicenter send` and the
browser page both call it, and differ only in how the request leaves.

**In the browser build, the page sends the request itself.** A browser has no
keychain and nothing outside the page, and no `so.epicenter` folder is open
there, so an app keeps its connections in its origin's storage, with the same
fields as a row:

| Kind | In a browser |
| --- | --- |
| `endpoint` with a key | the key is kept in the page's storage for its origin, and the form says so: "This key is saved in this browser. Code running on this site can read it." |
| `endpoint` without a key | works when the server allows browser requests, such as a local server with CORS enabled |
| `epicenter` | the page's own access token ([ADR-0549](0549-every-epicenter-resource-accepts-only-opaque-access-tokens-from-one-oauth-authorization-server.md)'s browser row) |
| `local` | not offered |

A provider that refuses browser requests (no CORS headers) does not work in
the browser, and the picker says so after the first refused request. The
endpoint-with-key rule holds there too: a key is kept only for the endpoint it
was saved for.

**Whispering's two connections become rows.** Nothing is migrated from
`ai/<owner>/connections.json`; Whispering finds no row and offers setup.

**Deleted:**

<!-- doc-path-check: ignore-next-line -->
- `apps/epicenter/src/ai-catalog.ts` (565 lines), `apps/epicenter/src/ai-catalog-routes.ts` (75), and their tests (754); the `/_epicenter/ai` gate and mounts (`apps/epicenter/src/server.ts:168-181`); `ai/<owner>/connections.json`; the secret app id `so.epicenter.ai-catalog`.
<!-- doc-path-check: ignore-next-line -->
- `apps/whispering/src/lib/workspace/epicenter-connections.ts` (285) and its `localStorage` key `whispering.epicenterConnections`.
<!-- doc-path-check: ignore-next-line -->
- `packages/ai/src/ai-connections.epicenter-host.ts` (224) and its test, and the smoke `packages/ai/scripts/shared-ai-catalog.browser.mjs` (412), which boots the Bun host.

## Consequences

- A person's connections, titles, and models follow them to every machine
  where `so.epicenter` is connected. Each key is typed once per machine.
- An agent lists and edits connections as files, and cannot read a key or
  redirect one.
- Two machines that edit different connections between syncs merge cleanly;
  two that edit one field of one connection conflict on that field, and a
  person settles it in the merge review.
- A person types a key into a page, and it crosses Rust once as
  `set_ai_key`'s argument on its way to the CLI's stdin. After it is saved, no
  page and no Rust code reads it back; `ai_key_state` answers without it.
  Pages lose
  plain `fetch` and server-sent events for AI and use the shim; changes to
  the list reach them as folder changes.
- Whispering's window and Settings now hold `so.epicenter`; under ADR-0540
  this widens what an app can write, not what it could reach during its build.
- In a browser a key sits in page storage, readable by any script on that
  origin; a person is told before they save one.
- Some providers work on the desktop and not in a browser, because only the
  desktop request leaves the page.
- A machine with a connection it cannot use shows why in the picker, in one of
  the three phrases above, rather than hiding the connection.

## Considered alternatives

- **One `aiConnections` key in `kv.json`.** Matches ADR-0552's wording, but
  `kv.json` merges by key (ADR-0551), so two machines that each add a
  connection between syncs conflict on the whole list.
- **Keys in the folder, or in a gitignored file beside it.** A synced key is a
  secret in Git history; a file beside it is a second, plaintext keychain.
- **`tauri-plugin-http` with a command that hands the page its key.** It
  streams and avoids CORS, but the key would sit in page memory, which every
  app on Epicenter's origin can reach, and nothing checks the endpoint against
  the one the key was saved for.
- **Connections stay in app data, with only choices in `so.epicenter`.** Each
  machine is set up by hand, and agents cannot see the list.
- **Each app's choice of connection in `so.epicenter`.** Which connection a
  workflow uses is the app's decision, and the app's own folder already syncs
  with it.
