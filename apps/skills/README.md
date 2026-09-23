# Skills Editor

An editor for Epicenter agent skills. Its route currently refuses startup
pending a product and authentication decision. The Account-taking adapter
opens the current Personal library through the shared App API and IndexedDB. Instructions and reference bodies are
the body nodes on their owning rows in the workspace document. CodeMirror
binds directly to those live nodes.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
AGPL-3.0 licensed.

## Workspace composition

`openSkillsRuntime({ account })` awaits `openPersonal(skillsDefinition, { account })`
and constructs UI state over the ready store. Its disposal stops UI state before
closing the store. The mounted layout renders its
current authentication refusal through Svelte's `{#await}` failure branch.
Importing Skills modules opens no storage. The declaration validates row data. Rows that do not
conform stay stored and appear in the UI's invalid-record count rather than
being silently deleted or migrated.

The app uses runtime-owned structural record IDs. Each valid skill and reference
also carries a stable `sourceId` in its JSON payload for domain-level references.
Deleting a skill explicitly deletes its currently conforming reference records.
Deleting a row also removes its body node, which is nested under it.

Instructions and reference bodies are collaborative nodes on their owning rows:

```ts
skills.data.tables.skills.body(skillId);
skills.data.tables.skillReferences.body(referenceId);
```

Application code never constructs addresses, authority identities, or providers.
There is one document, and the runtime owns it.

## UI

The single route renders a resizable split view with a searchable skill list,
metadata editor, Markdown instructions editor, references panel, and command
palette. CodeMirror binds directly to the row's body node.

## Development

The SvelteKit server hook and Vite dev and preview servers set COOP and COEP
headers. Document persistence uses IndexedDB. SQL has an independent
`openSqlite` constructor; opening the Skills store does not acquire SQL.

From the repository root:

```bash
bun install
bun dev:skills
```

Run checks with:

```bash
bun run --filter skills typecheck
bun run --filter skills build
```

## License

AGPL-3.0
