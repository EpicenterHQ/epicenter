# Static Workspace API Guide

> **Historical.** This guide records the retired `defineWorkspace` and `createWorkspace` API. Its successor, `defineDocument`, also belonged to the folder-sync product. To define collections and actions today, see the [app package](../../packages/app/README.md). To run or serve them, see the [CLI](../../packages/cli/README.md).

Type-safe schema definitions and workspace clients for local-first apps with versioned data.

When I built Epicenter, the biggest pain point was managing data schema changes in local-first systems. Most CRDT libraries let you store anything, but they don't help you evolve your data model over time. The Static Workspace API solves this: define your schemas once (with versioning), and data migrates automatically when loaded.

## The Problem

Local-first apps live on user devices. Unlike servers, you can't run a migration script and update everyone's data. Instead, old data coexists with new, and you need to handle both gracefully. But CRDT libraries like Y.js don't enforce schemas. They just store blobs. So you end up writing migration logic scattered throughout your app.

This gets messy fast. Add a field to your schema? Now you need:

- Validation code to check if the field is there
- Migration logic to fill in a default if missing
- Careful handling of invalid data (old versions, corrupted state)
- Type safety so you don't forget a case

The Static Workspace API makes this structured. You define your schemas once with versions, write a migration function, and everything else is typed and automatic.

## Quick Start

```typescript
import {
	defineWorkspace,
	defineTable,
	defineKv,
	createWorkspace,
} from 'epicenter/static';
import { type } from 'arktype';

// Define table schemas with versioning
const posts = defineTable(
	type({ id: 'string', title: 'string', _v: '1' }),
	type({ id: 'string', title: 'string', views: 'number', _v: '2' }),
)
	.migrate((row) => {
		if (row._v === 1) return { ...row, views: 0, _v: 2 };
		return row;
	});

// Define KV stores (simple schema + default)
const theme = defineKv(type("'light' | 'dark'"), 'light');

// Define the workspace (pure schema definitions, no side effects)
const workspace = defineWorkspace({
	id: 'my-app',
	tables: { posts },
	kv: { theme },
});

// Create a client (synchronous)
const client = createWorkspace(workspace);

// Read and write with full type safety
client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
const post = client.tables.posts.get('1');

if (post.status === 'valid') {
	console.log(post.row.title); // TypeScript knows this is a string
}

client.kv.set('theme', { mode: 'dark' });

// Cleanup
await client.destroy();
```

## Three Layers of API

This library has three intentional layers. Start with the simplest, drop down only when you need to.

### Layer 1: defineWorkspace() - Full Stack

The high-level API handles everything:

```typescript
const workspace = defineWorkspace({
	id: 'my-app',
	tables: { posts },
	kv: { theme },
});

const client = createWorkspace(workspace);
```

This creates a Y.Doc, binds your schemas to it, and returns a fully-typed client. It's synchronous and ready to use immediately.

### Layer 2: Capabilities - Extensibility Without Opinions

Need persistence, sync, or SQLite materialization? Capabilities let you add functionality without changing the core API:

```typescript
const client = createWorkspace(workspace)
	.withExtension('persistence', ({ ydoc }) => {
		const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
		return {
			exports: { provider },
			destroy: () => provider.destroy(),
		};
	})
	.withExtension('sqlite', ({ tables }) => {
		const db = new Database(':memory:');
		// Wire tables to materialized views
		return {
			exports: { db },
			destroy: () => db.close(),
		};
	});

// Access extensions after creation
client.extensions.sqlite.db.query('SELECT * FROM posts');
```

Extensions receive typed access to the workspace's Y.Doc and helpers. They return a plain `{ exports?, whenReady?, destroy? }` object. The framework normalizes defaults internally.

### Layer 3: createTables / createKv - Bring Your Own Y.Doc

For advanced use cases (shared Y.Docs, custom synchronization), skip the high-level API:

```typescript
import * as Y from 'yjs';
import { createTables, createKv } from 'epicenter/static';

const ydoc = new Y.Doc({ guid: 'shared-app' });
const tables = createTables(ydoc, { posts });
const kv = createKv(ydoc, { theme });

tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
```

This gives you full control over the Y.Doc lifecycle while keeping typed helpers.

## Schema Versioning

The core feature is automatic schema migration on read. No background jobs, no migration commands. Just data that evolves as your app does.

### Single-Version Schemas

For tables that never change, use the shorthand:

```typescript
const users = defineTable(type({ id: 'string', email: 'string' }));
```

### Multi-Version Schemas

As your schema evolves, add versions and write a migration function:

```typescript
const settings = defineTable()
	.version(
		type({
			id: 'string',
			soundEnabled: 'boolean',
			_v: '1',
		}),
	)
	.version(
		type({
			id: 'string',
			soundEnabled: 'boolean',
			volumeLevel: 'number', // New field
			_v: '2',
		}),
	)
	.migrate((row) => {
		if (row._v === 1) {
			return {
				...row,
				volumeLevel: 100, // Default for v1 rows
				_v: 2,
			};
		}
		return row;
	});
```

The `.migrate()` function receives any version as input and must return the latest. TypeScript enforces this. If you handle only v1 and forget v2, type checking fails.

This pattern scales. Add a v3? Just handle it in the same function:

```typescript
.migrate((row) => {
  if (row._v === 1) return { ...row, volumeLevel: 100, _v: 2 };
  if (row._v === 2) return { ...row, colorScheme: 'auto', _v: 3 };
  return row;
})
```

## Read Results

Reads return discriminated union types so you handle all cases:

```typescript
const result = client.tables.posts.get('123');

switch (result.status) {
	case 'valid':
		// result.row is fully typed
		console.log(result.row.title);
		break;
	case 'invalid':
		// result.errors is StandardSchemaV1.Issue[]
		// result.row is unknown (failed validation)
		console.error('Invalid post:', result.errors);
		break;
	case 'not_found':
		// Row doesn't exist
		console.log('Post 123 not found');
		break;
}
```

This explicit error handling catches data corruption early. If an old schema version wasn't properly migrated, you'll see an `invalid` status instead of silent failures.

## Table Operations

```typescript
const posts = client.tables.posts;

// Single row read/write
posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });
const result = posts.get('1');

// Bulk reads
const all = posts.getAll(); // All rows (valid + invalid)
const valid = posts.getAllValid(); // Only valid rows
const invalid = posts.getAllInvalid(); // Only invalid (for debugging)

// Queries
const published = posts.filter((row) => row.views > 0);
const found = posts.find((row) => row.id === '123');

// Delete
posts.delete('1');
posts.clear(); // Delete all rows

// Metadata
posts.count(); // Number of rows
posts.has('1'); // Does row exist?

// Observe changes
const unsubscribe = posts.observe((changedIds, transaction) => {
	console.log('Changed rows:', changedIds);
});
```

### Atomic Batches

Use `.batch()` for atomic transactions. All changes happen together, and observers fire once:

```typescript
posts.batch((tx) => {
	tx.set({ id: '1', title: 'Updated', views: 1, _v: 2 });
	tx.set({ id: '2', title: 'New', views: 0, _v: 2 });
	tx.delete('3');
	// All three operations are a single Y.js transaction
	// Observers see one notification with all three changes
});
```

## Key-Value Stores

KV stores use `defineKv(schema, defaultValue)`. No versioning, no migration. Invalid data falls back to the default:

```typescript
const mode = defineKv(type("'light' | 'dark' | 'system'"), 'light');
const fontSize = defineKv(type('number'), 14);

// Set and get
client.kv.set('mode', 'dark');
const current = client.kv.get('mode'); // 'dark' (valid) or 'light' (invalid/missing)

// Batch operations
client.kv.batch((tx) => {
	tx.set('theme', { mode: 'dark', fontSize: 16 });
	tx.set('sidebar', { collapsed: true });
});

// Observe changes
client.kv.observe('theme', (change, transaction) => {
	if (change.type === 'set') {
		console.log('New theme:', change.value);
	} else if (change.type === 'delete') {
		console.log('Theme deleted');
	}
});
```

## Design Decisions

### Row-Level Last-Writer-Wins

Each `set()` replaces the entire row. You don't do field-level updates. There's no `update({ id: '1', title: 'New' })`.

This is intentional. When data migrates, old rows might have a different shape than new ones. Allowing field-level updates would create consistency problems: should we merge old fields with new? What if the schema changed and a field no longer exists?

Instead, every write is a complete row in the latest schema. This keeps the consistency model simple. If you're updating a field, you read the row, modify it, and write it back:

```typescript
const result = posts.get('1');
if (result.status === 'valid') {
	posts.set({ ...result.row, views: result.row.views + 1 });
}
```

### No Write Validation

Writes don't validate against the schema. You're trusted to write correct data. If you write garbage, reads will catch it and return `invalid`.

Why? Validation is a feature of TypeScript. If your types say `views: number`, the compiler ensures you pass a number. Adding runtime validation in the write path adds overhead without catching real bugs.

Invalid data usually comes from:

- Old data that wasn't migrated (handled by `.migrate()`)
- Actual corruption (rare, caught by invalid reads)
- Bugs in your code (TypeScript catches this)

### Migration On Read, Not On Write

When you read old data, it migrates to the latest schema. It doesn't auto-update in storage.

This means old rows coexist with new indefinitely. Until they're explicitly rewritten. This is a feature: you can roll back your app version without "unmigrating" data. Plus, you only pay the migration cost when you read, not when the app starts up.

### No Field-Level Observation

You can observe an entire table or an entire KV key, but not individual fields. This keeps the API surface simple and the implementation efficient.

If you need field-level reactivity, that's a higher-level concern handled by your UI framework (React/Svelte/etc). Typically you read the data once, subscribe to table changes, and let your UI reactivity handle updates.

## Extension Lifecycle

Extensions receive an `ExtensionContext` with typed access to the workspace:

```typescript
type ExtensionContext = {
	ydoc: Y.Doc;
	tables: TablesHelper<TTableDefinitions>;
	kv: KvHelper<TKvDefinitions>;
};
```

Each extension factory returns a plain `Extension<T>` object:

```typescript
type Extension<T> = {
	exports?: T; // Consumer-facing exports
	whenReady?: Promise<unknown>; // Resolves when ready (default: resolved)
	destroy?: () => MaybePromise<void>; // Cleanup (default: no-op)
};
```

Return a plain object directly. The framework normalizes defaults:

```typescript
const persistence = ({ ydoc }) => {
	const provider = new IndexeddbPersistence(ydoc.guid, ydoc);
	return {
		exports: { provider },
		destroy: () => provider.destroy(),
	};
};
```

The framework automatically provides defaults for omitted fields:

- `exports` defaults to `{}` (lifecycle-only extensions)
- `whenReady` defaults to `Promise.resolve()` (instantly ready)
- `destroy` defaults to `() => {}` (no-op cleanup)

Extensions are schema-generic by default. If you need typed access, add generic parameters:

```typescript
type MyTables = typeof workspace.tableDefinitions;
type MyKv = typeof workspace.kvDefinitions;

const logger: ExtensionFactory<MyTables, MyKv> = ({ tables }) => {
	// tables is fully typed. Autocomplete works for all your tables
	tables.posts.getAll();
	return {};
};
```

## Sync Construction, Async Properties

The createWorkspace() call is synchronous. It returns immediately:

```typescript
const client = createWorkspace(workspace)
	.withExtension('persistence', persistence)
	.withExtension('sync', sync);

// Can use tables/kv immediately
client.tables.posts.set({ id: '1', title: 'Hello', views: 0, _v: 2 });

// But extensions might still be initializing
console.log(client.extensions.persistence); // Exists
console.log(client.extensions.sync); // Exists
```

If an extension needs time to initialize (connecting to a server, opening a database), it signals readiness with `whenReady`:

```typescript
await client.extensions.sync.whenReady; // Wait for connection
```

This pattern lets your UI render immediately while extensions initialize in the background.

## Bringing Your Own Y.Doc

Sometimes you have a shared Y.Doc (e.g., a collaboration server). Use the lower-level APIs:

```typescript
import * as Y from 'yjs';
import { createTables, createKv } from 'epicenter/static';

// Shared Y.Doc passed from elsewhere
const ydoc = provider.ydoc; // From WebsocketProvider or similar

const tables = createTables(ydoc, {
	posts: defineTable(type({ id: 'string', title: 'string', _v: '1' })),
});

const kv = createKv(ydoc, {
	theme: defineKv(type({ mode: "'light' | 'dark'", _v: '1' })),
});

// Use normally
tables.posts.set({ id: '1', title: 'Hello' });
```

You don't get the createWorkspace() wrapper or automatic lifecycle management, but you keep full type safety and all the table/KV operations.

## Storage

Tables and KV store their data in Y.js data structures:

- Each table gets its own `Y.Array` at `table:{tableName}`
- All KV values share a single `Y.Array` at `kv`

These are real Y.js types, so they work with any Y.js provider (IndexedDB, WebSocket, etc.). The Static Workspace API is just a typed interface over Y.js.

## Error Handling

When reading data, always handle result statuses:

```typescript
const result = client.tables.posts.get('123');

if (result.status === 'valid') {
	// result.row is typed correctly
	useRow(result.row);
} else if (result.status === 'invalid') {
	// Data failed validation. Debug it
	console.error('Post 123 is corrupt:', result.errors);
	// Decide: fix it, delete it, or ignore it
} else {
	// Not found
	console.log('Post 123 not found');
}
```

For bulk reads, use `.getAllValid()` to skip invalid rows:

```typescript
// Only valid rows, easier for UI rendering
const validPosts = client.tables.posts.getAllValid();
```

For debugging, use `.getAllInvalid()`:

```typescript
// Find corrupt rows
const invalid = client.tables.posts.getAllInvalid();
if (invalid.length > 0) {
	console.error('Found invalid rows:', invalid);
}
```

## Typing

The API is fully typed with generics. Types are inferred from your definitions:

```typescript
const posts = defineTable(type({ id: 'string', title: 'string', views: 'number', _v: '1' }));

const workspace = defineWorkspace({
	id: 'my-app',
	tables: { posts },
});

const client = createWorkspace(workspace);

// TypeScript knows:
// - client.tables.posts.set() requires { id: string; title: string; views: number }
// - client.tables.posts.get() returns GetResult<{ id: string; title: string; views: number }>
// - client.tables.posts.getAll() returns RowResult<{ id: string; title: string; views: number }>[]
```

This is enforced at compile time, so you catch type mismatches before running code.

## Limitations and Tradeoffs

**No cell-level updates.** You write entire rows. This keeps consistency simple when data migrates, but means you can't do partial updates without reading first.

**No write-time validation.** Invalid data only fails on read. This trusts TypeScript but means bugs can introduce corrupt data that must be handled gracefully.

**No automatic data repair.** If data is invalid, it stays invalid until you explicitly rewrite it. You could add a migration that fixes it, or rebuild from scratch.

**Row-level Last-Writer-Wins.** Multiple concurrent writes to the same row from different users result in the last write winning. If you need fine-grained concurrency, you need a field-level CRDT, which this isn't.

These tradeoffs exist because they keep the implementation simple, predictable, and focused on the core problem: versioned local-first data. More sophisticated patterns are better handled by capabilities built on top.

## Examples

### Adding a Field to Your Schema

Your app has users. In v1, you store email. In v2, you add a phone number:

```typescript
const users = defineTable()
	.version(
		type({
			id: 'string',
			email: 'string',
			_v: '1',
		}),
	)
	.version(
		type({
			id: 'string',
			email: 'string',
			phone: 'string | null', // New field
			_v: '2',
		}),
	)
	.migrate((row) => {
		if (row._v === 1) {
			return {
				...row,
				phone: null, // Default for v1 rows
				_v: 2,
			};
		}
		return row;
	});
```

When you read a v1 row, it automatically gets a `phone: null`. When you read a v2 row, it's already typed correctly.

### Schema Validation

If you need to validate that imported data is valid before writing, you can:

```typescript
const definition = users; // Your table definition
const schema = definition.schema['~standard'];
const validationResult = schema.validate(importedData);

if (!validationResult.issues) {
	// Safe to write
	client.tables.users.set(importedData);
} else {
	console.error('Imported data invalid:', validationResult.issues);
}
```

But typically, you just write valid data (TypeScript enforces this) and trust that reads will catch corruption.

### Renaming a Field

Renaming requires a schema change and migration:

```typescript
const settings = defineTable()
	.version(
		type({
			id: 'string',
			notifyByEmail: 'boolean',
			_v: '1',
		}),
	)
	.version(
		type({
			id: 'string',
			emailNotifications: 'boolean', // Renamed from notifyByEmail
			_v: '2',
		}),
	)
	.migrate((row) => {
		if (row._v === 1) {
			return {
				id: row.id,
				emailNotifications: row.notifyByEmail,
				_v: 2,
			};
		}
		return row;
	});
```

### Using Multiple Tables

Tables are isolated. Each gets its own Y.Array:

```typescript
const workspace = defineWorkspace({
	id: 'notes-app',
	tables: {
		notebooks: defineTable(type({ id: 'string', name: 'string', _v: '1' })),
		notes: defineTable(type({ id: 'string', notebookId: 'string', content: 'string', _v: '1' })),
	},
});

const client = createWorkspace(workspace);

client.tables.notebooks.set({ id: 'nb1', name: 'Work' });
client.tables.notes.set({
	id: 'note1',
	notebookId: 'nb1',
	content: 'Remember to...',
});

// Query across tables manually
const workNotes = client.tables.notes.filter(
	(note) => note.notebookId === 'nb1',
);
```

## When to Use This

This library is for **local-first apps with structured data that evolves over time**. Good use cases:

- Todo apps, note apps, project management tools
- Browser extensions with local state
- Offline-first mobile apps
- Collaborative apps built on Y.js

Not a good fit if you:

- Don't need schema versioning (simple CRDT is enough)
- Need relational queries (add a SQL capability instead)
- Want ORM-style field-level updates (fight the architecture)

## Related APIs

This is one layer of a larger system. Related APIs:

- **createTables / createKv** - Lower-level APIs for custom Y.Doc management
- **Extension** - Extension type definition (from `shared/lifecycle.ts`)
- **YKeyValue** - Y.js key-value abstraction (from `core/utils/y-keyvalue.ts`)
