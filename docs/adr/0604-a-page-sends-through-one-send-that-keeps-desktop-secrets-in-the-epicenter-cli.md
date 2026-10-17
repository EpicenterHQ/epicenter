# 0604. A page sends through one send that keeps desktop secrets in the epicenter CLI

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) at "Three commands manage keys", as far as an app's window runs them, and at the AI target `{ connection: id, endpoint }`: an installed app's window runs no command that creates, changes, or removes a connection, and a target names only the connection. [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md) at the `ai_send` target `{kind: "openai-compatible", connection, endpoint}` and at "`send` refuses a request prepared for an endpoint the keychain no longer holds", with `EndpointChanged`: the target carries the connection id, and `epicenter send` sends to the endpoint the keychain entry holds when it reads it. [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md) at "the AI commands" in the union `installed-app.json` grants and at the consequence that a third-party app can "set or remove an AI connection's key": an installed app's window keeps `allow-ai-send` and `allow-ai-key-state` and loses `allow-ai-key-set` and `allow-ai-key-remove`. [ADR-0587](0587-epicenter-has-no-folder-of-its-own.md) at Whispering writing "through `ai_key_set`" and at "`send` sends an `openai-compatible` request only while the keychain entry still holds the endpoint it was prepared for": Whispering sends a person to Settings to set up a connection, and no endpoint comes from the page.
- **Unbuilt:** all of it: the page-side `send(target, request)` in `@epicenter/ai`, the target without an endpoint, the capability changes, Whispering's setup through Settings, and every deletion below.
- **Relates:** [ADR-0603](0603-a-machine-holds-one-account-grant-in-the-epicenter-cli.md) (the one account grant), [ADR-0556](0556-outside-a-webview-typescript-runs-only-as-the-epicenter-cli.md) (`epicenter send`), [ADR-0561](0561-rust-serves-every-app-from-one-epicenter-app-origin.md) (every installed app shares one origin), [ADR-0598](0598-an-app-is-built-once-and-selects-its-host-implementation-at-run-time.md) (an app selects its host implementation at run time), [ADR-0540](0540-an-app-is-installed-by-building-its-source-and-approving-a-commit-trusts-it-fully.md) (approving an app trusts it fully).

## Context

Line numbers below are at `e9027cc744`.

On the desktop the `epicenter` CLI already holds the secrets: the account
grant in `so.epicenter.auth` (ADR-0556, ADR-0603) and each AI connection's
endpoint and key in `so.epicenter.connections` (ADR-0564). A page sends an
AI request with `ai_send` and an account request with `account_send`, and
Rust runs `epicenter send` for both. In a browser, a page keeps its keys in
its origin's `localStorage` (`packages/ai/src/browser.ts`) and sends with
`sendToEndpoint` (`packages/ai/src/send.ts:411`) over its own `fetch`. Each
app picks between the two in its own code; Whispering has one path in
`apps/whispering/src/lib/workspace/desktop-connections.ts` and another for
the browser.

Every installed app's window holds `allow-ai-key-set` and
`allow-ai-key-remove` (`apps/epicenter/src-tauri/capabilities/installed-app.json`,
ADR-0570), and so does the Folders window (`folders.json`).
`ai_key_set(connection, endpoint, key)`
(`apps/epicenter/src-tauri/src/cli.rs:835-843`) hands the page's endpoint to
`saveKey` (`packages/ai/src/send.ts:329-355`), which replaces the entry of
any connection id. So one installed app can point a connection that
Whispering sends recordings over at an endpoint the app chose, with no key
or a key it supplies, and `ai_key_remove` deletes any connection. The app
cannot read the saved key, because `saveKey` replaces it too.

The `openai-compatible` target carries the endpoint the page read
(`SendTarget`, `send.ts:113-121`), and `sendRequest` refuses with
`EndpointChanged` when the entry holds another (`send.ts:556`). The check
exists because the page supplies an endpoint at all; the request's `path`
is already relative and never a URL (`SendRequest`, `send.ts:124-130`).

## Decision

**On the desktop the `epicenter` CLI holds every secret, and no page reads
one.**

```txt
keychain, read and written only by the epicenter CLI
  so.epicenter.auth          the machine's account grant (ADR-0603): refresh token, cached access tokens
  so.epicenter.connections   <id> -> {"endpoint", "key"} (ADR-0564)
a desktop page               no token, no key, and no endpoint it can set
a browser tab                its origin's localStorage: its own access token (ADR-0549), its own keys (ADR-0557)
```

**A page sends every request through one function, `send(target, request)`,
exported by `@epicenter/ai` for pages, which picks its path with
`isTauri()`.**

| Target | Desktop (`isTauri()` is true) | Browser |
| --- | --- | --- |
| a connection, by id | `ai_send`: `epicenter send` reads the keychain entry and sends with its key | `fetch` to the endpoint saved in the origin's `localStorage`, with its key |
| an account audience, `api` or `git` | `account_send`: `epicenter send` adds the grant's access token | `fetch` with the origin's own access token |

A request is `SendRequest`: a method, a `path` below the connection's
endpoint or the deployment's `/api/`, headers, and a body. `send` answers
with a `Response`. No app picks the path itself. `send.ts` keeps importing
nothing but `wellcrafted`, so the compiled CLI carries no page code; the
page-side `send` lives beside it in `@epicenter/ai`.

**`send` takes a connection id, never an endpoint from the page.** The
target names the connection and nothing that says where the request goes.
`epicenter send` reads the entry for that id and sends to the entry's
endpoint with the entry's key. A page cannot repoint a connection by what it
sends.

**Installed apps use connections; only Settings creates, changes, or removes
one.**

```txt
installed-app.json   keeps allow-ai-send, allow-ai-key-state, and ADR-0587's list command
                     loses allow-ai-key-set, allow-ai-key-remove
folders.json         loses allow-ai-key-set, allow-ai-key-remove
home.json            Settings; keeps allow-ai-key-set, allow-ai-key-remove
```

Which connection an app uses for an operation is use, not change, and stays
the app's choice under ADR-0587. An app that finds no usable connection opens
Settings at its connections with `open_home`, which every installed app
already holds. In a browser an app keeps and edits its own connections in its
own origin's storage, where it is the only page that can read them.

**Deleted:**

- `allow-ai-key-set` and `allow-ai-key-remove` in `installed-app.json` and
  `folders.json`, and the test that every capability grants them
  (`ai_commands_are_granted_to_settings_folders_and_installed_apps`,
  `apps/epicenter/src-tauri/src/lib.rs`);
- `endpoint` on the `openai-compatible` `SendTarget`, `SendError.EndpointChanged`,
  and every page's read of the endpoint to build a target;
- Whispering's desktop key form calling `aiKeySet`
  (`desktop-connections.ts:245`);
- each app's own choice between `ai_send` and `sendToEndpoint`.

## Consequences

- No installed app can repoint, replace, or delete a connection another app
  sends over. Settings is the one desktop form where a connection's endpoint
  and key are typed.
- Whispering on the desktop sends a person to Settings to add a key, a window
  switch it does not need today.
- No desktop page holds a token or a key, so the origin every installed app
  shares (ADR-0561) exposes none. This is the API the platform offers, not a
  sandbox: an approved app's build already ran on this machine with the
  person's account (ADR-0540), and its page still sends over every connection.
- A request goes to whatever endpoint the entry holds when `epicenter send`
  reads it. A person who edits a connection in Settings while an app is open
  redirects that app's next request with no refusal.
- In a browser, keys sit in each origin's `localStorage`, readable by any
  script on that origin, as ADR-0557 tells the person before they save one.
  Each browser app is its own origin, so one app's keys are not another's.
- An app writes one request path for both hosts.
- A terminal or an agent still sets and removes keys with `epicenter auth key
  set` and `remove` (ADR-0587). The boundary is between pages, not against a
  local process.

## Considered alternatives

- **Provider keys in desktop page storage, beside the browser's.** Every
  installed app is served from one origin (ADR-0561), so one installed app
  could read every key.
- **Keep key set and remove for installed apps.** An app could still repoint
  or delete a connection another app uses.
- **Keep the page's endpoint in the target as a staleness check.** Once no
  app can change an entry, it guards only against a person's own edit in
  Settings, and it hands the page a value that names where a key goes.
- **Each app chooses its own path, as today.** Every app reimplements the
  split between `ai_send` and `fetch`, and Whispering already carries it
  twice.
- **`tauri-plugin-http` with the key handed to the page.** ADR-0557 refused
  it: the key would sit in page memory on the shared origin.
