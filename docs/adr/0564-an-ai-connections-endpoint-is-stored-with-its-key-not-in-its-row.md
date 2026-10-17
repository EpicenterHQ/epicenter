# 0564. An AI connection's endpoint is stored with its key, not in its row

- **Status:** Accepted
- **Date:** 2026-10-16
- **Amends:** [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) at the row's `endpoint` field, the `savedForAnotherAddress` state, the kind named `endpoint`, the key commands' names and arguments, and the capability-file rule that lets an app into `so.epicenter`: a row holds `kind`, `title`, and `model`, the endpoint lives only in the keychain entry, the kind is `openai-compatible`, and `AI_CONNECTION_APPS` names the apps whose windows open `so.epicenter`.
- **Amended by:** [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md) at `AI_CONNECTION_APPS`: every installed app's window is permitted into `so.epicenter`, and the list is deleted.
- **Amended by:** [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) at "its row in `so.epicenter` holds only `kind`, `title`, and `model`" and "A page learns a connection's endpoint from the keychain": the kind, title, and model are in `connections.json` in app data, the endpoint stays with the key, and a page learns everything but the key.
- **Relates:** [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (approving an app trusts it fully), [ADR-0555](0555-apps-reach-native-code-through-official-tauri-plugins-first-granted-by-app-id.md) (native commands granted by app id), [ADR-0558](0558-the-epicenter-cli-groups-only-its-app-and-auth-commands.md) (`epicenter auth key`).
- **Unbuilt:** a build-time flag that replaces the `EPICENTER_TEST_SECRETS` check, so a release binary has no in-memory store; Whispering's `transcriptionConnection` and `textConnection` in `so.epicenter.whispering/kv.json`, replacing the fixed rows `whispering-transcription` and `whispering-text`.

## Context

ADR-0557 stored an `openai-compatible` connection's endpoint twice. The synced
row in `so.epicenter/connections/<id>.md` had an `endpoint` field, and the
keychain entry for `<id>` held `{ endpoint, key }`. Every key command took the
row's endpoint as an argument (`set_ai_key(id, endpoint, key)`,
`ai_key_state(id, endpoint)`), and `ai_key_state` compared the two copies: when
a row synced from another machine, or edited by an agent, named a different
endpoint, it answered `savedForAnotherAddress` and the connection asked for its
key again.

The row's copy had one job: to tell a machine that its keychain entry no longer
matched. It could never decide where a key went, because the keychain's copy
had to agree first. The build stores the endpoint once.

## Decision

**An AI connection's endpoint is stored with its key, in one keychain entry
under the connection's id, and its row in `so.epicenter` holds only `kind`,
`title`, and `model`.**

```txt
~/Epicenter/so.epicenter/connections/<id>.md     synced; edited by pages, people, and agents
  kind: openai-compatible | epicenter | local
  title: Groq
  model: whisper-large-v3

Keychain service so.epicenter.connections         this machine only; read and written only by the epicenter CLI
  <id> → {"endpoint": "https://api.groq.com/openai/v1", "key": "…"}     key is "" for a keyless endpoint
```

The row is `connectionsTable` in `packages/ai/src/connection-table.ts`. The
entry is written by `saveKey` and read by `readKeyEntry` in
`packages/ai/src/send.ts`, which stores the endpoint as `canonicalEndpoint`
spells it: an `http` or `https` URL with a lowercase host, no default port, no
trailing slash, and no user name, password, query, or fragment.
`packages/cli/src/secrets.ts` binds the entry to `Bun.secrets` under
`KEYCHAIN_SERVICE`.

**A page learns a connection's endpoint from the keychain, and never its key.**
Each Rust command runs one fixed CLI invocation
(`apps/epicenter/src-tauri/src/cli.rs`):

```txt
ai_key_set(connection, endpoint, key)   epicenter auth key set <id> --json      stdin {"endpoint", "key"}
ai_key_remove(connection)               epicenter auth key remove <id> --json
ai_key_state(connection)                epicenter auth key state <id> --json    {state: "missing"}
                                                                                 {state: "saved", endpoint, hasKey}
ai_send(target, request, channel)       epicenter send --json                   target {kind: "openai-compatible", connection, endpoint}
```

**`send` refuses a request prepared for an endpoint the keychain no longer
holds.** A page reads the endpoint from `ai_key_state`, builds the request below
it with `toSendRequest`, and names it in the `ai_send` target. `sendRequest`
reads the entry and refuses with `NoKey` when there is none and with
`EndpointChanged` when the entry's endpoint differs from the target's.
Otherwise it sends to the entry's endpoint with the entry's key. Nothing is
sent on a refusal.

ADR-0557's `savedForAnotherAddress` state does not exist. No synced row holds an
endpoint, so nothing synced can disagree with the keychain. Settings
(`apps/epicenter/src/ui/connections/ConnectionEditor.svelte`) shows one of:

```txt
Sends to <endpoint> with the key saved on this computer.
Sends to <endpoint> with no key.
Add your key on this computer.
```

Synced files never decide where a key is sent, and a person enters the
endpoint and key together on each machine, in one form with two fields.

## Consequences

- An endpoint does not follow a person to another machine. A synced
  `openai-compatible` row shows "Add your key on this computer" until the
  person types its endpoint and key there; a keyless endpoint is typed with an
  empty key. ADR-0557 already asked for each key once per machine; each
  endpoint is now typed with it.
- An agent or a sync can change a connection's title or model, never its
  destination. Two machines never conflict on an endpoint, because no file
  holds one.
- The kind ADR-0557 called `endpoint` is `openai-compatible` in
  `CONNECTION_KINDS`, labeled "OpenAI-compatible endpoint" in Settings
  (`KIND_LABELS`).
- `keychain()` in `packages/cli/src/secrets.ts` returns an in-memory store when
  `EPICENTER_TEST_SECRETS` is set, seeded from its JSON
  (`{ "<id>": { "endpoint", "key" } }`), and the system keychain is not
  touched. `packages/cli/src/ai-commands.test.ts` and the tests in
  `apps/epicenter/src-tauri/src/cli.rs` use it. A release binary honors the
  variable too, so any process that sets it for `epicenter` chooses the
  entries `send` reads.
- `open_installed_window` in `apps/epicenter/src-tauri/src/lib.rs` permits an
  app's window into `so.epicenter` when the app's id is in
  `AI_CONNECTION_APPS`, which is `["so.epicenter.whispering"]`. ADR-0557 said
  the shell permits a window whose capability file, `installed-<app>.json`,
  grants `send`. The shell reads no capability file when it opens a window:
  the AI commands are granted separately, by
  <!-- doc-path-check: ignore-next-line (deleted with the Bun host in wave 3) -->
  `apps/epicenter/src-tauri/capabilities/installed-whispering-development.json`
  and `installed-whispering-production.json` beside it, both compiled into the build and
  keyed by the same app id. `AI_CONNECTION_APPS` is the rule adopted, because
  it is the one check the shell makes before the permit. An app that sends
  over connections is added to both lists, and no test checks that they agree.
- Whispering keeps ADR-0557's decision that an app's choice of connection is
  its own setting, in its own folder. The build does not implement it:
  `CONNECTION_IDS` in `apps/whispering/src/lib/workspace/desktop-connections.ts`
  fixes the stems `whispering-transcription` and `whispering-text`, so
  Whispering cannot use a connection made in Settings, and its two rows appear
  in Settings beside the others.

## Considered alternatives

- **The endpoint in the row and in the entry (ADR-0557).** Stored twice; the
  row's copy only signals that the entry is stale, which costs a third state
  in `ai_key_state` and an endpoint argument on every key command.
- **The endpoint only in the row, the key alone in the keychain.** A synced
  edit of the row would send the key to a new endpoint, which ADR-0557
  refused.
