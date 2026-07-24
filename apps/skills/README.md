# Skills Editor

A local browser editor for Epicenter agent skills. Records live in the W4
Browser runtime's canonical OPFS store. Instructions and reference bodies are
row-owned Yjs documents in the Skills Lens.

Part of the [Epicenter](https://github.com/EpicenterHQ/epicenter) monorepo.
AGPL-3.0 licensed.

## Workspace composition

The mounted root layout calls `openSkillsApplication()`, renders its stable boot
promise with Svelte's `{#await}` block, and provides only the fully opened and
hydrated application to descendants. Importing Skills modules does not open
storage. Record lenses validate canonical JSON when it is read. Rows that do not
conform stay stored and appear in the UI's invalid-record count rather than
being silently deleted or migrated.

The app uses runtime-owned structural record IDs. Each valid skill also carries
a stable `sourceId` in its JSON payload for domain-level references.
Deleting a skill explicitly deletes its currently conforming reference records.
Deleting a row also deletes its owned document state.

Instructions and reference bodies open through their owning rows:

```ts
await skills.skills.record(skillId).document.open();
await skills.references.record(referenceId).document.open();
```

Application code never constructs document addresses, authority identities, or
providers. The runtime derives them from the table and structural row id.

## UI

The single route renders a resizable split view with a searchable skill list,
metadata editor, Markdown instructions editor, references panel, and command
palette. CodeMirror synchronizes edits through the open row document handle.

## Development

The Browser OPFS runtime requires a cross-origin isolated page. The SvelteKit
server hook and Vite dev and preview servers set the required COOP and COEP
headers. Production proxies must preserve those headers.

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
