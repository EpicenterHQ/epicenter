# 0587. Epicenter has no folder of its own

- **Status:** Accepted
- **Date:** 2026-10-17
- **Amends:** [ADR-0539](0539-epicenters-own-folder-is-so-epicenter-and-machine-state-splits-by-what-it-costs-to-lose.md) at "Epicenter's own folder is `~/Epicenter/so.epicenter`", its tree's `so.epicenter/` entries, and "App source never sits inside `so.epicenter`": Epicenter keeps no folder, and the split of machine state by what it costs to lose stands. [ADR-0557](0557-an-ai-connection-is-a-row-in-so-epicenter-whose-key-stays-in-this-machines-keychain.md) at "An AI connection is a row in `so.epicenter`", "Pickers read the table with `folderOptions` on `so.epicenter`", and "Whispering's two connections become rows": a connection is one keychain entry, listed without its key through the CLI. [ADR-0564](0564-an-ai-connections-endpoint-is-stored-with-its-key-not-in-its-row.md) at "its row in `so.epicenter` holds only `kind`, `title`, and `model`" and "A page learns a connection's endpoint from the keychain": the keychain entry holds the kind, title, and model too, and a page learns all of them, never the key. [ADR-0569](0569-the-installed-apps-are-the-clones-in-apps-not-rows-in-so-epicenter.md) at "The CLI owns `so.epicenter`'s declaration and publishes it at every launch": there is no such folder or declaration. [ADR-0570](0570-every-installed-apps-window-gets-the-same-grant.md) at "Opening any installed app permits its window into `so.epicenter`": an app window reaches only the folder it was handed.
- **Unbuilt:** all of it: the full keychain entry and its id list; `epicenter auth key list` and the shell command that runs it; Settings and Whispering listing connections through it; Whispering's choice of connection as a setting in its own folder; and every deletion below.

## Context

Epicenter kept one folder for itself, `~/Epicenter/so.epicenter/`
(ADR-0539), whose only table is `connections`: `connectionsTable` in
`packages/ai/src/connection-table.ts`, one row per AI connection holding
`kind`, `title`, and `model`. The endpoint and key of an `openai-compatible`
connection live in this machine's keychain, in one entry per connection id
under the service `so.epicenter.connections` (ADR-0564;
`KEYCHAIN_SERVICE`, `packages/cli/src/secrets.ts:20`). `epicenter auth key
set <id>` reads `{"endpoint", "key"}` on stdin
(`packages/cli/src/ai-commands.ts`).

The row syncs and the entry does not, so on another machine an
`openai-compatible` row is unusable until its endpoint and key are entered
again. Holding the row required a folder no person chose:

- `packages/cli/src/epicenter-folder.ts` declares it (`epicenterDefinition`,
  `EPICENTER_FOLDER_ID`), and `declareEpicenterFolder` publishes it at
  every launch; the shell waits on that (`EpicenterFolderDeclared`,
  `apps/epicenter/src-tauri/src/cli.rs:583`) before opening an installed
  app (`installed_apps.rs:249-250`).
- The shell registers it with `FolderConfig::new`, so its first grant
  creates it empty (`register_epicenter_folder`,
  `apps/epicenter/src-tauri/src/data_folders.rs:73-90`), and permits every
  installed app's window into it (ADR-0570).
- Settings opens it (`openFolder({ app: EPICENTER_FOLDER_ID, ... })` in
  `apps/epicenter/src/ui/connections/AiConnections.svelte:29-30`) and lists
  `connections` (`ConnectionList.svelte`). Whispering's desktop workspace
  opens it through `connectionsDefinition`
  (`apps/whispering/src/lib/workspace/desktop.ts:89-90`) and reads and
  writes the fixed rows `whispering-transcription` and `whispering-text`
  (`desktop-connections.ts:51-54`).
- The CLI special-cases its name: `isApplicationFolder`
  (`packages/cli/src/history-commands.ts:57`) and the installer's refusal of
  the id (`packages/cli/src/installed-apps.ts:224`).

## Decision

**An AI connection lives entirely in this machine's keychain entry.** The
entry under `so.epicenter.connections`, named by the connection id, holds:

```json
{ "kind": "openai-compatible", "title": "OpenAI", "model": "gpt-4o-mini", "endpoint": "https://api.openai.com/v1", "key": "sk-..." }
```

An `epicenter` or `local` connection has no endpoint or key. `Bun.secrets`
cannot list a service's entries, so `auth key set` and `auth key remove`
also keep the entry `$ids`, the list of connection ids; no connection id
starts with `$`.

**Apps and Settings list connections without their keys.** `epicenter auth
key list --json` prints each connection's id, kind, title, model, and
endpoint, and whether a key is saved. The shell runs it for a page as one
fixed command beside `ai_key_set`, `ai_key_remove`, and `ai_key_state`.
`auth key set <id>` reads the whole entry on stdin. A page never reads a
key, and the CLI still sends every desktop request (ADR-0557).

**Which connection an app uses stays the app's own setting, in its own
folder,** naming the connection id (ADR-0557). Whispering's fixed rows
become such a setting in Whispering's folder.

**In a browser, connections stay where they are today,** in `localStorage`
(`packages/ai/src/browser.ts`), since a browser has no keychain.

**Epicenter has no folder of its own.** Deleted:

- `~/Epicenter/so.epicenter/`, `EPICENTER_FOLDER` and
  `register_epicenter_folder` (`data_folders.rs`), the last path that
  creates a folder on its first grant;
- `connectionsTable`, `connectionsDefinition`, and `CONNECTIONS_FOLDER_ID`
  (`packages/ai/src/connection-table.ts` and its `./connection-table`
  export);
- `packages/cli/src/epicenter-folder.ts` and its test, with
  `epicenterDefinition` and `EPICENTER_FOLDER_ID`, and Epicenter's own
  template;
- the `CONNECTIONS_FOLDER_ID` clauses in `history-commands.ts` and
  `installed-apps.ts`;
- the startup barrier: `EpicenterFolderDeclared`, its spawn, and the wait
  in `installed_apps.rs`;
- Settings opening a folder: `AiConnections.svelte` lists through the
  shell command, and `ConnectionList.svelte` reads that list;
- Whispering opening `so.epicenter`: `desktop.ts` and
  `desktop-connections.ts` list through the shell command and write through
  `ai_key_set`;
- both `so.epicenter` clauses of ADR-0586's `admit`, which becomes: the
  Folders window opens any data folder, and an app window opens the folder
  it was handed.

## Consequences

- An agent configures connections with `epicenter auth key set`, `list`,
  and `remove`, not by editing files.
- Titles and models no longer sync between machines; keys never did. A
  second machine sets its connections up again, as it already had to for
  an endpoint and key.
- A connection is usable wherever it is listed: no half-configured row
  arrives from another machine.
- Settings needs no folder grant, and no window reaches a folder it was not
  handed except the Folders window.
- Launch waits on no folder declaration.
- No released build reads `so.epicenter`. A development machine's
  `~/Epicenter/so.epicenter/` becomes an ordinary folder with no `app`,
  which a person deletes; its connections are set up again.

## Considered alternatives

- **Keep the row in `so.epicenter` and only the secret in the keychain.** A
  folder no person chose exists for one table, its row syncs to machines
  where it cannot be used, and every app window needs a grant to it.
- **Keep connections as rows in each app's own folder.** Two apps that use
  one connection would each hold a copy, and the key still could not move
  with the row.
