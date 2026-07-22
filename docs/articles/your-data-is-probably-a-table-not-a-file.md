# Your Data Is Probably a Table, Not a File

> Historical article. It describes the deleted `@epicenter/workspace` and
> filesystem architecture. The current record and Lens model lives in
> [`@epicenter/data`](../../packages/data/README.md).

Epicenter has two packages for storing application data: `@epicenter/workspace` (typed tables, KV, documents) and `@epicenter/filesystem` (POSIX-style virtual files and folders). The workspace is the default. Most apps should use it directly and never touch the filesystem package.

The interesting part is that the filesystem isn't a separate storage system. It's built on top of workspace tables. The specialized API composes on the general-purpose one, not beside it.

## Honeycrisp thinks in records

Honeycrisp is an Apple Notes clone. Its data model is two tables and some KV settings:

```typescript
const foldersTable = defineTable({
  id: field.string<FolderId>(),
  name: field.string(),
  sortOrder: field.number(),
});

const notesTable = defineTable(
  {
    id: field.string<NoteId>(),
    folderId: field.string<FolderId>(),
    title: field.string(),
    preview: field.string(),
  },
  {
    id: field.string<NoteId>(),
    folderId: field.string<FolderId>(),
    title: field.string(),
    preview: field.string(),
    deletedAt: field.datetime(),
  },
).migrate(({ value, version }) => {
  switch (version) {
    case 1: return { ...value, deletedAt: null };
    case 2: return value;
  }
});

const workspace = createWorkspace({
  id: HONEYCRISP_ID,
  tables: { folders: foldersTable, notes: notesTable },
  kv: {},
});
```

Every note has a known shape: `title`, `preview`, `folderId`, timestamps. The UI reads them with `table.getAllValid()`, filters with `table.filter(...)`, and writes with `table.set(...)`. Rich text content lives in a separate per-note Y.Doc kept in a `createDisposableCache(...)` keyed by note id; the metadata row holds whatever the editor needs to find that content.

No filesystem needed. Notes don't have paths. Users don't `mkdir` or `mv`. The app thinks in "records with fields," and workspace tables express that directly.

## Opensidian thinks in files

Opensidian is a local-first note editor with a built-in bash terminal. Users create markdown files, organize them into nested folders, rename them, move them around. The file tree IS the interface.

```typescript
import { filesTable } from '@epicenter/filesystem';

const workspace = createWorkspace({
  id: OPENSIDIAN_ID,
  tables: {
    files: filesTable,
    conversations: conversationsTable,
    chatMessages: chatMessagesTable,
  },
  kv: {},
});
```

The `filesTable` comes from `@epicenter/filesystem`. It defines rows with `name`, `parentId`, `type` (file or folder), `size`, timestamps, and soft-delete state. That table gets passed to `attachTables(ydoc, ...)` like any other table, because that's what it is.

The filesystem wrapper then turns those table rows into POSIX operations:

```typescript
import { createYjsFileSystem } from '@epicenter/filesystem';

export const fs = createYjsFileSystem(
  workspace.tables.files,
  workspace.tables.files.documents.content,
);

await fs.mkdir('/docs');
await fs.writeFile('/docs/hello.md', '# Hello');
await fs.mv('/docs/hello.md', '/notes/hello.md');
```

Opensidian needs this because the appeal IS files and folders. Users expect to see a file tree, right-click to create files, drag things between directories. A bash terminal writes to the same filesystem. Paths, not IDs, are the primary way users think about their data.

But notice: the filesystem still uses workspace tables underneath. It doesn't replace them. Opensidian also has `conversations` and `chatMessages` tables alongside the `files` table. Those are plain workspace records that don't need file semantics at all.

## The filesystem composes on the workspace

This is the architectural point worth calling out. The dependency graph looks like this:

```
@epicenter/workspace   defineTable, documents, extensions
        │
@epicenter/filesystem  filesTable + createYjsFileSystem
        │
apps (Opensidian)      fs.mkdir, fs.writeFile, fs.mv
```

`@epicenter/filesystem` imports `defineTable` from `@epicenter/workspace` to create the `filesTable`. It imports workspace types like `TableHelper` and `Documents` to build the POSIX wrapper. The filesystem package doesn't introduce a new storage layer. It adds a semantic layer on top of the existing one.

That means you get both: structured table access for metadata queries (fast directory listings, path lookups, search indexing) and POSIX-style operations for user-facing file interactions. The same row that `fs.mv` updates is the same row that `workspace.tables.files.get(id)` returns.

## When to use which

The decision comes down to how users think about the data.

If the app knows the shape of every record upfront. Notes with titles, bookmarks with URLs, chat messages with timestamps. Workspace tables are the right fit. The data is structured. The fields are known. You define a schema, get typed CRUD, and move on.

If the app's data model is inherently hierarchical files. A code editor, a note vault with nested folders, anything where users expect `mkdir` and path resolution. Add the filesystem package on top. You still get workspace tables underneath (for metadata queries and other structured data), plus the POSIX operations users expect.

Honeycrisp doesn't use the filesystem because notes don't need paths. Opensidian does because the file tree is the product.
