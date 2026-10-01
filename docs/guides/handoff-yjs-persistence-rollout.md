# YJS Persistence Rollout: Handoff Document

<!-- doc-path-check: ignore-file (historical record; its paths are frozen) -->

> **Historical.** This document describes the October 2025 `createWorkspace({ setupYDoc })` + `defineEpicenter({ workspaces: [...] })` flow. Both of those APIs are gone. Persistence today is a single `attachSqlite(ydoc, { filePath })` (or `attachIndexedDb(ydoc)` in the browser) call inside a `defineDocument((id) => { ... })` builder: see `apps/whispering/src/lib/client.ts` and `playground/opensidian-e2e/epicenter.config.ts` for the current pattern. Preserved for history.

**Date**: October 14, 2025
**Status**: Historical record
**Reference Implementation**: `examples/basic-workspace`

## Executive Summary

The `basic-workspace` example has been successfully updated with a complete YJS persistence pattern that provides:

- Binary YJS persistence (CRDT source of truth)
- Markdown index (git-friendly storage)
- SQLite index (queryable snapshots)
- Multi-session state persistence

This document provides step-by-step instructions to apply this pattern to all remaining workspaces in the Epicenter project.

## The Pattern

### Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│ YJS Document (.epicenter/<workspace-id>.yjs)            │
│ - Binary CRDT format                                    │
│ - Source of truth for all data                         │
│ - Persists across sessions                             │
│ - Auto-saves on every update                           │
│ - One file per workspace (isolated by workspace ID)    │
└─────────────────────────────────────────────────────────┘
                        │
                        ├─────────────────────────────────┐
                        │                                 │
           ┌────────────▼────────────┐      ┌────────────▼────────────┐
           │ SQLite Index            │      │ Markdown Index          │
           │ (test-data/*.db)        │      │ (test-data/content/)    │
           │ - Fast queries          │      │ - Git-friendly          │
           │ - Drizzle ORM           │      │ - Human-readable        │
           │ - Queryable snapshots   │      │ - YAML frontmatter      │
           └─────────────────────────┘      └─────────────────────────┘
```

### Multi-Workspace Architecture

**Key Insight**: Multiple workspaces can coexist in the same project, each with its own isolated YJS document.

```
project-root/
  .epicenter/                    # Shared directory for ALL workspaces
    ├── blog.yjs                 # Blog workspace state
    ├── pages.yjs                # Pages workspace state
    └── content-hub.yjs          # Content-hub workspace state

  test-data/
    ├── blog.db                  # Blog SQLite index
    ├── pages.db                 # Pages SQLite index
    └── content-hub.db           # Content-hub SQLite index

  content/
    ├── blog/                    # Blog markdown files
    ├── pages/                   # Pages markdown files
    └── content-hub/             # Content-hub markdown files
```

**How It Works**:

1. Each workspace is created with a unique `id` (e.g., `'blog'`, `'pages'`, `'content-hub'`)
2. YJS creates a document with that ID as its GUID: `new Y.Doc({ guid: ws.id })`
3. `setupYDoc` callback uses the workspace ID to create a unique filename: `.epicenter/${id}.yjs`
4. Multiple workspaces = multiple isolated `.yjs` files in the shared `.epicenter/` directory
5. Workspaces can run concurrently without conflicts because they have separate documents

**This Is a Feature**: The architecture is intentionally designed for multiple workspaces. Adding a new workspace just means adding another `.yjs` file.

### File Structure

```
<workspace-directory>/
├── .epicenter/                    # YJS binary persistence (shared by all workspaces)
│   ├── blog.yjs                  # Blog workspace YJS document (gitignored)
│   ├── pages.yjs                 # Pages workspace YJS document (gitignored)
│   └── content-hub.yjs           # Content-hub workspace YJS document (gitignored)
│                                  # Note: Multiple workspaces = multiple .yjs files
├── .gitignore                     # Must ignore .epicenter/
├── epicenter.config.ts            # Workspace definition(s) with setupYDoc
├── package.json                   # CLI scripts
├── test-data/
│   ├── blog.db                   # Blog SQLite index
│   ├── pages.db                  # Pages SQLite index
│   ├── content-hub.db            # Content-hub SQLite index
│   └── content/                   # Markdown files (organized by workspace/table)
│       ├── blog/
│       │   └── posts/
│       │       └── <id>.md
│       ├── pages/
│       │   └── pages/
│       │       └── <id>.md
│       └── content-hub/
│           └── youtube/
│               └── <id>.md
└── test-*.ts                      # Test scripts (programmatic API)
```

## Implementation Details

### 1. The setupYDoc Callback

**Critical Order**: `setupYDoc` MUST run BEFORE `createEpicenterDb` so persisted data loads before table initialization.

**Important**: Use the workspace `id` to create a unique filename for each workspace.

```typescript
const blogWorkspace = createWorkspace({
	id: 'blog', // ← This ID determines the .yjs filename
	version: 1,
	name: 'blog',
	// ... schema, indexes, actions ...

	/**
	 * Set up YJS document persistence to disk
	 * This enables state to persist across CLI invocations and programmatic runs
	 *
	 * The workspace ID ('blog') is used to create a unique filename: blog.yjs
	 * Multiple workspaces = multiple .yjs files in the shared .epicenter/ directory
	 */
	setupYDoc: (ydoc) => {
		const storagePath = './.epicenter';
		const filePath = path.join(storagePath, 'blog.yjs'); // ← Use workspace ID here

		// Ensure .epicenter directory exists (shared by all workspaces)
		if (!fs.existsSync(storagePath)) {
			fs.mkdirSync(storagePath, { recursive: true });
		}

		// Try to load existing state from disk
		try {
			const savedState = fs.readFileSync(filePath);
			Y.applyUpdate(ydoc, savedState);
			console.log(`[Persistence] Loaded workspace from ${filePath}`);
		} catch {
			console.log(`[Persistence] Creating new workspace at ${filePath}`);
		}

		// Auto-save on every update
		ydoc.on('update', () => {
			const state = Y.encodeStateAsUpdate(ydoc);
			fs.writeFileSync(filePath, state);
		});
	},
});
```

**Pattern for Multiple Workspaces**:

```typescript
// Pages workspace
const pages = createWorkspace({
	id: 'pages', // → .epicenter/pages.yjs
	setupYDoc: (ydoc) => {
		const filePath = path.join('./.epicenter', 'pages.yjs');
		// ... same persistence logic ...
	},
});

// Content-hub workspace
const contentHub = createWorkspace({
	id: 'content-hub', // → .epicenter/content-hub.yjs
	setupYDoc: (ydoc) => {
		const filePath = path.join('./.epicenter', 'content-hub.yjs');
		// ... same persistence logic ...
	},
});
```

### 2. Required Imports

Add these imports to `epicenter.config.ts`:

```typescript
import * as Y from 'yjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { defineEpicenter } from '../../packages/workspace/src/index';
```

### 3. Wrap Configuration

Wrap the workspace export with `defineEpicenter`:

```typescript
// Before:
export default workspaceName;

// After:
export default defineEpicenter({
	workspaces: [workspaceName],
});
```

### 4. Index Configuration

Ensure both indexes are configured in the workspace:

```typescript
indexes: ({ db }) => ({
	sqlite: sqliteIndex(db, { databaseUrl: 'file:test-data/<workspace-name>.db' }),
	markdown: markdownIndex(db, { storagePath: './test-data/content' }),
}),
```

### 5. .gitignore Configuration

Create or update `.gitignore` in each workspace directory:

```
# Epicenter system folder
.epicenter/
```

### 6. package.json Scripts

Ensure CLI script is available:

```json
{
	"scripts": {
		"cli": "bun ../../packages/workspace/src/cli/bin.ts"
	}
}
```

## Workspace Inventory

### Current Workspaces

| Workspace Directory        | Status          | Workspace Name         | Notes                        |
| -------------------------- | --------------- | ---------------------- | ---------------------------- |
| `examples/basic-workspace` | ✅ Complete     | `blog`                 | Reference implementation     |
| `examples/content-hub`     | ❌ Needs Update | `content-hub`, `pages` | Two workspaces in one file   |
| `examples/e2e-tests`       | ❌ Needs Update | `blog`                 | Comprehensive test workspace |

### Workspace Details

#### 1. examples/basic-workspace ✅

- **Status**: Complete (reference implementation)
- **Workspace**: `blog`
- **Tables**: `posts`, `comments`
- **Has setupYDoc**: Yes
- **Has indexes**: SQLite + Markdown
- **Wrapped in defineEpicenter**: Yes
- **Test files**: `test-yjs-persistence.ts`, `test-bidirectional-sync.ts`

#### 2. examples/content-hub ❌

- **Status**: Needs YJS persistence
- **Workspaces**: `pages` (dependency), `content-hub` (main)
- **Tables**:
  - `pages`: `pages`
  - `content-hub`: `youtube`, `instagram`, `tiktok`, `substack`, `medium`, `twitter`
- **Has setupYDoc**: No
- **Has indexes**: SQLite only (needs markdown)
- **Wrapped in defineEpicenter**: No
- **Special considerations**:
  - Has workspace dependencies (`pages` is a dependency of `content-hub`)
  - Only exports the main workspace, not wrapped in `defineEpicenter`
  - No test files or CLI scripts in package.json

#### 3. examples/e2e-tests ❌

- **Status**: Needs YJS persistence
- **Workspace**: `blog`
- **Tables**: `posts`, `comments`
- **Has setupYDoc**: No
- **Has indexes**: SQLite + Markdown
- **Wrapped in defineEpicenter**: Yes
- **Test files**: `cli.test.ts`, `server.test.ts`
- **Special considerations**:
  - Already has comprehensive test suite
  - Tests use `@effect/vitest` pattern
  - Already has proper package.json with CLI scripts

## Step-by-Step Implementation Guide

### For Each Workspace

Follow these steps for each workspace that needs updating:

#### Step 1: Add Required Imports

At the top of `epicenter.config.ts`, add:

```typescript
import * as Y from 'yjs';
import * as fs from 'node:fs';
import * as path from 'node:path';
```

If not already present, ensure `defineEpicenter` is imported:

```typescript
import { defineEpicenter } from '../../packages/workspace/src/index';
```

#### Step 2: Add setupYDoc Callback

Inside the workspace definition (after `actions`, before the closing brace), add:

```typescript
/**
 * Set up YJS document persistence to disk
 * This enables state to persist across CLI invocations and programmatic runs
 *
 * IMPORTANT: Use the workspace ID (defined at the top of the workspace)
 * to create a unique filename. Example: id: 'blog' → 'blog.yjs'
 */
setupYDoc: (ydoc) => {
	const storagePath = './.epicenter';
	const filePath = path.join(storagePath, '<WORKSPACE-ID>.yjs');

	// Ensure .epicenter directory exists (shared by all workspaces)
	if (!fs.existsSync(storagePath)) {
		fs.mkdirSync(storagePath, { recursive: true });
	}

	// Try to load existing state from disk
	try {
		const savedState = fs.readFileSync(filePath);
		Y.applyUpdate(ydoc, savedState);
		console.log(`[Persistence] Loaded workspace from ${filePath}`);
	} catch {
		console.log(`[Persistence] Creating new workspace at ${filePath}`);
	}

	// Auto-save on every update
	ydoc.on('update', () => {
		const state = Y.encodeStateAsUpdate(ydoc);
		fs.writeFileSync(filePath, state);
	});
},
```

Replace `<WORKSPACE-ID>` with the workspace's `id` field (e.g., if `id: 'blog'`, use `'blog.yjs'`).

**For files with multiple workspaces**: Each workspace needs its own `setupYDoc` callback with its own unique filename based on its `id`.

#### Step 3: Update Indexes

Verify both indexes are present. If markdown index is missing, add it:

```typescript
indexes: ({ db }) => ({
	sqlite: sqliteIndex(db, { databaseUrl: 'file:test-data/<workspace-name>.db' }),
	markdown: markdownIndex(db, { storagePath: './test-data/content' }),
}),
```

#### Step 4: Wrap with defineEpicenter

If the file doesn't already use `defineEpicenter`, update the export:

```typescript
// Before:
export default workspaceName;

// After:
export default defineEpicenter({
	workspaces: [workspaceName],
});
```

For files with multiple workspaces (like `content-hub`), include all:

```typescript
export default defineEpicenter({
	workspaces: [pages, contentHub],
});
```

#### Step 5: Create/Update .gitignore

Create `.gitignore` in the workspace directory if it doesn't exist:

```
# Epicenter system folder
.epicenter/
```

#### Step 6: Update package.json

If `package.json` doesn't exist or lacks CLI scripts, create/update:

```json
{
	"name": "<workspace-directory-name>",
	"version": "0.0.1",
	"private": true,
	"scripts": {
		"cli": "bun ../../packages/workspace/src/cli/bin.ts"
	},
	"dependencies": {
		"@epicenter/workspace": "workspace:*"
	}
}
```

#### Step 7: Test the Implementation

1. **Test YJS persistence**:

   ```bash
   cd examples/<workspace-directory>

   # Create data via CLI
   bun cli <workspace-name> <mutation-action> --arg1 value1 --arg2 value2

   # Verify .yjs file was created
   ls -la .epicenter/

   # Query data (should persist)
   bun cli <workspace-name> <query-action>
   ```

2. **Test markdown sync**:

   ```bash
   # Check markdown files were created
   ls -la test-data/content/<table-name>/

   # View a markdown file
   cat test-data/content/<table-name>/<id>.md
   ```

3. **Test multi-session persistence**:

   ```bash
   # Session 1: Create data
   bun cli <workspace-name> <mutation-action> --arg value

   # Session 2: Query data (should persist)
   bun cli <workspace-name> <query-action>
   ```

4. **Optional: Create persistence test**:
   Create a `test-yjs-persistence.ts` file modeled after `basic-workspace/test-yjs-persistence.ts`.

## Test Naming Convention

### Current State

The `basic-workspace` example uses:

- `test-yjs-persistence.ts` - Programmatic multi-session persistence tests
- `test-bidirectional-sync.ts` - Markdown bidirectional sync tests

### Recommendation: Keep Current Naming

**Keep the `test-*.ts` naming convention** for the following reasons:

1. **Intentional Design**: These are programmatic test scripts that demonstrate API usage, not automated test suites
2. **Documentation Value**: They serve as runnable examples for developers
3. **Simple Execution**: Users can run them directly with `bun test-yjs-persistence.ts`
4. **No Test Runner Needed**: They don't require vitest/jest, just Node.js
5. **Clear Convention**: The `test-` prefix indicates testing/demonstration purpose without implying test framework usage

### When to Use `*.test.ts`

Use `*.test.ts` format ONLY when:

- Using a test runner (vitest, jest, bun test)
- Writing automated test suites
- Integrating with CI/CD

**Example**: The `e2e-tests` workspace correctly uses:

- `cli.test.ts` - Automated tests with vitest
- `server.test.ts` - Automated tests with vitest

These run with `bun test` and use test assertions.

## Implementation Checklist

Use this checklist for each workspace:

### examples/content-hub

- [ ] Add required imports (`Y`, `fs`, `path`, `defineEpicenter`)
- [ ] Add `setupYDoc` callback for `pages` workspace (filename: `'pages.yjs'`)
- [ ] Add `setupYDoc` callback for `content-hub` workspace (filename: `'content-hub.yjs'`)
- [ ] Add markdown index to both workspaces
- [ ] Wrap export with `defineEpicenter({ workspaces: [pages, contentHub] })`
- [ ] Create `.gitignore` with `.epicenter/` entry
- [ ] Create `package.json` with CLI script
- [ ] Test CLI commands work for both workspaces
- [ ] Verify `.epicenter/pages.yjs` is created when using `pages` workspace
- [ ] Verify `.epicenter/content-hub.yjs` is created when using `content-hub` workspace
- [ ] Verify both `.yjs` files can coexist in the same directory
- [ ] Verify markdown files are created in `test-data/content/` for both workspaces
- [ ] Test multi-session persistence for both workspaces independently
- [ ] Consider creating `test-yjs-persistence.ts` for documentation

**Note**: This example demonstrates the multi-workspace pattern. Both workspaces share `.epicenter/` but have isolated state.

### examples/e2e-tests

- [ ] Add required imports (`Y`, `fs`, `path`)
- [ ] Add `setupYDoc` callback to `blog` workspace (filename: `'blog.yjs'`)
- [ ] Verify markdown index is present (already has it)
- [ ] Verify wrapped in `defineEpicenter` (already is)
- [ ] Create `.gitignore` with `.epicenter/` entry
- [ ] Verify package.json has CLI script (already does)
- [ ] Test existing test suites still pass
- [ ] Test CLI commands work
- [ ] Verify `.epicenter/blog.yjs` is created
- [ ] Test multi-session persistence
- [ ] Update existing tests to verify persistence
- [ ] Add persistence-specific test cases to test suite

**Note**: This example has a single workspace, demonstrating the basic pattern. The `.epicenter/` directory will contain only `blog.yjs`.

## Edge Cases & Special Considerations

### 1. Workspace Dependencies

**Issue**: `content-hub` has `pages` as a dependency.
**Solution**: Each workspace gets its own `setupYDoc` callback and `.yjs` file:

- `pages` → `.epicenter/pages.yjs`
- `content-hub` → `.epicenter/content-hub.yjs`

Both workspaces are completely isolated. The dependency relationship is at the API level (content-hub can call pages' actions), not at the persistence level. Each maintains its own state.

**Concrete Example**:

```typescript
// Pages workspace (dependency)
const pages = createWorkspace({
	id: 'pages', // → .epicenter/pages.yjs
	setupYDoc: (ydoc) => {
		const filePath = path.join('./.epicenter', 'pages.yjs');
		// ... persistence logic ...
	},
});

// Content-hub workspace (depends on pages)
const contentHub = createWorkspace({
	id: 'content-hub', // → .epicenter/content-hub.yjs
	dependencies: [pages],
	setupYDoc: (ydoc) => {
		const filePath = path.join('./.epicenter', 'content-hub.yjs');
		// ... persistence logic ...
	},
});
```

Result: Two `.yjs` files in the same `.epicenter/` directory, each with its own isolated state.

### 2. Multiple Workspaces in One File

**Issue**: `content-hub/epicenter.config.ts` defines two workspaces.
**Solution**: Both workspaces need `setupYDoc` callbacks with unique filenames. The `defineEpicenter` wrapper should include both:

```typescript
export default defineEpicenter({
	workspaces: [pages, contentHub], // Both registered
});
```

When you run CLI commands:

- `bun cli pages createPage` → Uses `.epicenter/pages.yjs`
- `bun cli content-hub addYoutubeVideo` → Uses `.epicenter/content-hub.yjs`

Both workspaces can run concurrently without conflicts.

### 3. Existing Test Suites

**Issue**: `e2e-tests` has existing automated tests.
**Solution**:

- Add persistence without breaking existing tests
- Tests should verify persistence works
- May need to add cleanup logic to prevent test pollution
- Consider adding `.epicenter/` to test cleanup routines

### 4. Test Data Conflicts

**Issue**: Multiple test runs could conflict with persisted data.
**Solution**:

- For automated tests: Clean `.epicenter/` directory before/after tests
- For manual testing: Embrace persistence as expected behavior
- Document how to reset state: `rm -rf .epicenter/ test-data/`

### 5. Git-Friendly Storage

**Issue**: Binary `.yjs` files aren't git-friendly.
**Solution**: This is by design:

- `.yjs` files → Binary, fast, gitignored (ephemeral state)
- `.md` files → Text, git-friendly, committed (source of truth for version control)
- `.db` files → Binary, gitignored (queryable snapshot)

Users can commit markdown files to git and YJS state will rebuild from them.

## Migration Path

### For New Workspaces

1. Copy the pattern from `basic-workspace/epicenter.config.ts`
2. All new workspaces should have YJS persistence from the start

### For Existing Workspaces

1. Apply the pattern using the step-by-step guide above
2. Test thoroughly before committing
3. Verify existing functionality isn't broken
4. Add persistence-specific tests if needed

### For Production Workspaces

If/when Epicenter is used for production data:

1. **Backup strategy**: Commit markdown files regularly to git
2. **Recovery**: Can rebuild from markdown files if `.yjs` is lost
3. **Sync conflicts**: Manual markdown edits require long-running process for workspace sync
4. **Best practice**: Use workspace API for mutations, markdown for viewing/git history

## Verification Criteria

After updating each workspace, verify:

1. ✅ `.epicenter/<workspace-id>.yjs` is created on first mutation (e.g., `blog.yjs`, `pages.yjs`)
2. ✅ YJS file is gitignored (not tracked by git)
3. ✅ Data persists across CLI invocations
4. ✅ Markdown files are created in `test-data/content/<table>/<id>.md`
5. ✅ SQLite database is created/updated at `test-data/<workspace-id>.db`
6. ✅ CLI commands work: `bun cli <workspace> <action>`
7. ✅ Queries return data from previous sessions
8. ✅ Updates in one session are visible in next session
9. ✅ Console logs show `[Persistence] Loaded workspace from...` on subsequent runs
10. ✅ Existing tests pass (if applicable)

**For multi-workspace files**: 11. ✅ Each workspace creates its own `.yjs` file (e.g., both `pages.yjs` and `content-hub.yjs` exist) 12. ✅ Workspaces don't interfere with each other (can run CLI commands for different workspaces) 13. ✅ Each workspace maintains isolated state

## Testing Strategy

### Minimal Testing (Required)

For every workspace, at minimum:

1. **Create data**: Use CLI to create records
2. **Verify persistence**: Exit and restart, verify data still exists
3. **Update data**: Make changes, verify they persist
4. **Check files**: Verify `.yjs`, `.md`, and `.db` files exist

### Comprehensive Testing (Recommended)

For important workspaces, create test files:

1. **Persistence test**: `test-yjs-persistence.ts`
   - Multi-session data creation
   - Cross-session queries
   - Update persistence
   - Verify file creation

2. **Bidirectional sync test**: `test-bidirectional-sync.ts`
   - Workspace → Markdown sync
   - Manual markdown edits (when long-running process exists)
   - Conflict handling

### Automated Testing (For CI/CD)

For workspaces with automated tests (like `e2e-tests`):

1. Add persistence verification to existing tests
2. Clean `.epicenter/` directory before/after test runs
3. Test multi-session scenarios
4. Verify indexes sync correctly

## FAQ

### Q: Can I have multiple workspaces in the same project?

**A**: Yes! This is the intended design. Each workspace uses `.epicenter/${workspaceId}.yjs` for its state. Multiple workspaces = multiple `.yjs` files in the shared `.epicenter/` directory.

Example:

- Workspace `id: 'blog'` → `.epicenter/blog.yjs`
- Workspace `id: 'pages'` → `.epicenter/pages.yjs`
- Workspace `id: 'content-hub'` → `.epicenter/content-hub.yjs`

All workspaces share the same `.epicenter/` directory but have completely isolated state. They can run concurrently without conflicts.

### Q: Why is setupYDoc critical to run before createEpicenterDb?

**A**: `setupYDoc` loads persisted state with `Y.applyUpdate()`. This must happen before table initialization so the tables are populated with the loaded state. If tables initialize first, they'll be empty.

### Q: Can I use just binary persistence without markdown?

**A**: Yes, but you lose git-friendly storage. The markdown index is optional but highly recommended for version control and human readability.

### Q: What if I already have data in my workspace?

**A**: Adding `setupYDoc` won't delete existing data. On first run, it will create a new `.yjs` file with current state. Future runs will load from that file.

### Q: How do I reset a workspace completely?

**A**: Delete all persistence files:

```bash
rm -rf .epicenter/ test-data/
```

Next run will start fresh.

### Q: Can multiple processes use the same workspace simultaneously?

**A**: No. YJS persistence currently uses file-based storage. For multi-process, you'd need a different sync provider (like WebSocket or HTTP). File-based persistence is designed for CLI and single-process programmatic usage.

### Q: What happens if .yjs file is corrupted?

**A**: The try-catch in `setupYDoc` will fall back to creating a new workspace. If you have markdown files, you can manually recreate data, or the markdown index will eventually sync back (requires long-running process for markdown → workspace sync).

### Q: Why two workspaces in content-hub?

**A**: `pages` is a shared dependency workspace. `content-hub` depends on it for page data. Both need their own persistence.

### Q: Should I commit .db files to git?

**A**: No. SQLite databases are binary and gitignored. They're ephemeral query indexes that rebuild from YJS state. Commit `.md` files instead.

## Next Steps

After reading this document:

1. **Review reference implementation**: Study `examples/basic-workspace/epicenter.config.ts`
2. **Start with simplest workspace**: Begin with `e2e-tests` (already partially set up)
3. **Follow step-by-step guide**: Use the checklist for each workspace
4. **Test thoroughly**: Verify all criteria before moving to next workspace
5. **Document issues**: If you encounter problems, update this document

## Questions or Issues?

If you encounter any problems:

1. Compare your implementation to `basic-workspace/epicenter.config.ts`
2. Check that imports are correct
3. Verify `.epicenter/` directory is created
4. Check console logs for persistence messages
5. Ensure `.gitignore` is working (git shouldn't track `.epicenter/`)

## Success Criteria

This rollout is complete when:

- [ ] All workspaces in `examples/` have YJS persistence
- [ ] All workspaces pass verification criteria
- [ ] Each workspace has been manually tested
- [ ] Documentation is updated with any lessons learned
- [ ] Any issues encountered are documented

---

**Document Version**: 1.0
**Last Updated**: October 14, 2025
**Author**: Implementation team
**Reference**: `examples/basic-workspace`
