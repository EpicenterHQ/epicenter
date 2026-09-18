# Skills Editor

An editor for Epicenter agent skills. Its route currently refuses startup
pending a product and authentication decision. The Account-taking adapter
opens the current Personal library through the shared App API and IndexedDB. Instructions and reference bodies are
the `content` nodes on their owning rows in the workspace document. CodeMirror
binds directly to those live nodes.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
AGPL-3.0 licensed.

## Workspace composition

`openSkillsRuntime({ account })` calls `openApp(skillsDefinition, { account })`,
awaits readiness, and constructs UI state over `app.account.personal`. Its
disposal stops UI state before closing the App. The mounted layout renders its
current authentication refusal through Svelte's `{#await}` failure branch.
Importing Skills modules opens no storage. The declaration validates row data. Rows that do not
conform stay stored and appear in the UI's invalid-record count rather than
being silently deleted or migrated.

The app uses runtime-owned structural record IDs. Each valid skill and reference
also carries a stable `sourceId` in its JSON payload for domain-level references.
Deleting a skill explicitly deletes its currently conforming reference records.
Deleting a row also removes its content node, which is nested under it.

Instructions and reference bodies are rich fields on their owning rows:

```ts
skills.data.tables.skills.get(skillId)?.content;
skills.data.tables.skillReferences.get(referenceId)?.content;
```

Application code never constructs addresses, authority identities, or providers.
There is one document, and the runtime owns it.

## UI

The single route renders a resizable split view with a searchable skill list,
metadata editor, Markdown instructions editor, references panel, and command
palette. CodeMirror binds directly to the row's `content` field.

## Development

The SvelteKit server hook and Vite dev and preview servers set COOP and COEP
headers. Document persistence uses IndexedDB; SQL is acquired only if a caller
opens a named database through the App.

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
