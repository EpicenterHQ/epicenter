/**
 * Every entry opens the one `Folder`: the browser, desktop, and automatic
 * entries with `{ tables }`, each the runtime's own folder, and the Bun entry
 * with `{ directory, tables }`, a path. No page names a desktop directory.
 * Rows are typed by the caller's TypeBox schemas, and the removed
 * declaration-dependent shapes do not type-check.
 */
import { expectTypeOf } from 'bun:test';
import { Type } from 'typebox';
import type { Result } from 'wellcrafted/result';
import * as browser from './browser.js';
import * as bun from './bun.js';
import type * as contract from './contract.js';
import type {
	Folder,
	FolderFiles,
	FolderTable,
	OpenFolderError,
	ReadError,
	Row,
	SaveError,
} from './index.js';
import * as root from './index.js';
import * as tauri from './tauri.js';

const notes = Type.Object({
	title: Type.String(),
	done: Type.Optional(Type.Boolean()),
});
type Tables = { readonly notes: typeof notes };
type Opened = Promise<Result<Folder<Tables>, OpenFolderError>>;

// Each entry's opener answers the same `Folder`.
expectTypeOf(browser.openFolder({ tables: { notes } })).toEqualTypeOf<Opened>();
expectTypeOf(tauri.openFolder({ tables: { notes } })).toEqualTypeOf<Opened>();
expectTypeOf(
	bun.openFolder({ directory: '/tmp/notes', tables: { notes } }),
).toEqualTypeOf<Opened>();
expectTypeOf(root.openFolder({ tables: { notes } })).toEqualTypeOf<Opened>();
expectTypeOf(root.openFolder).toEqualTypeOf(tauri.openFolder);
expectTypeOf(tauri.openFolder<{ notes: typeof notes }>)
	.parameter(0)
	.toEqualTypeOf<contract.DefaultFolderOptions<{ notes: typeof notes }>>();

// Neither a browser nor a desktop page names a directory, and Bun needs one.
// @ts-expect-error The browser entry opens this origin's default folder.
browser.openFolder({ directory: '/tmp/notes', tables: { notes } });
// @ts-expect-error The desktop entry opens the folder bound to this window.
tauri.openFolder({ directory: 'data:Notes', tables: { notes } });
// @ts-expect-error The automatic entry takes no directory either.
root.openFolder({ directory: '/tmp/notes', tables: { notes } });
// @ts-expect-error The Bun entry opens a directory by its path.
bun.openFolder({ tables: { notes } });

// The declaration-dependent shapes are gone.
// @ts-expect-error No app ID selects a folder.
browser.openFolder({ app: 'so.epicenter.notes', tables: { notes } });
// @ts-expect-error No folder ID selects a folder.
root.openFolder({ id: 'notes', tables: { notes } });
// @ts-expect-error A Bun directory is `directory`, not `root`.
bun.openFolder({ root: '/tmp/notes', tables: { notes } });

declare const folder: Folder<Tables>;
expectTypeOf(folder.files).toEqualTypeOf<FolderFiles>();
expectTypeOf(folder.tables.notes).toEqualTypeOf<FolderTable<typeof notes>>();
// @ts-expect-error A table exists only when the caller named it.
folder.tables.todos;
// @ts-expect-error Git is not on a Folder's lifetime.
folder.git;
// @ts-expect-error Neither is Sync.
folder.sync;

declare const row: Row<typeof notes>;
if (row.issues === null) {
	expectTypeOf(row.fields.title).toEqualTypeOf<string>();
	expectTypeOf(row.fields.done).toEqualTypeOf<boolean | undefined>();
}
expectTypeOf(folder.tables.notes.get('a')).toEqualTypeOf<
	Promise<Result<Row<typeof notes> | undefined, ReadError>>
>();
expectTypeOf(folder.tables.notes.set('a', row, { body: 'x' })).toEqualTypeOf<
	Promise<Result<{ sent: Row<typeof notes> }, SaveError>>
>();

// Every entry exports the contract unchanged.
type ContractKeys = keyof typeof import('./contract.js');
expectTypeOf<ContractKeys>().toEqualTypeOf<
	'OpenFolderError' | 'ReadError' | 'SaveError'
>();
for (const entry of [root, browser, tauri, bun]) {
	expectTypeOf(entry.OpenFolderError).toEqualTypeOf<
		typeof contract.OpenFolderError
	>();
	expectTypeOf(entry.SaveError).toEqualTypeOf<typeof contract.SaveError>();
}

// The legacy names are not exported.
// @ts-expect-error
type _LegacyFolder = root.LegacyFolder;
// @ts-expect-error
type _OpenLegacyFolder = root.OpenLegacyFolder;
// @ts-expect-error
root.defineFolder;
// @ts-expect-error
root.parseRow;
