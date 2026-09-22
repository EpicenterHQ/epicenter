/** Flat declarations preserve schema inference and the ready handle and optional Account. */
import { expectTypeOf } from 'bun:test';
import { defineTable, field, type KvOf, type RowOf } from '@epicenter/app';
import type { Account } from '@epicenter/auth';
import { defineApp } from './index.js';
import { openLocal, openPersonal, type StoreRuntime } from './open-store.js';

const notes = defineApp({
	id: 'test.notes',
	title: 'Notes',
	kv: { language: field.string() },
	tables: { notes: defineTable({ title: field.string() }) },
});
expectTypeOf(notes.id).toEqualTypeOf<'test.notes'>();
expectTypeOf(notes.title).toEqualTypeOf<'Notes'>();
expectTypeOf<KvOf<typeof notes>['language']>().toEqualTypeOf<string>();
expectTypeOf<
	RowOf<typeof notes.tables.notes>['title']
>().toEqualTypeOf<string>();

const untitled = defineApp({ id: 'test.untitled', kv: {}, tables: {} });
expectTypeOf(untitled.id).toEqualTypeOf<'test.untitled'>();
expectTypeOf(untitled.title).toEqualTypeOf<string | undefined>();

// Checked without opening any runtime resources.
async function openings(account: Account, runtime: StoreRuntime) {
	const local = await openLocal(notes, { runtime });
	const personal = await openPersonal(notes, { account, runtime });
	personal.tables.notes.create({ title: 'Personal' });
	local.kv.update({ language: 'en' });
	// @ts-expect-error Personal requires an account.
	openPersonal(notes);
	// @ts-expect-error Local is account-independent.
	openLocal(notes, { account });
	// @ts-expect-error No aggregate capabilities.
	local.device;
	// @ts-expect-error The opener already establishes readiness.
	local.ready;
	// @ts-expect-error Typed fields retain validation.
	local.tables.notes.create({ title: 12 });
}

void openings;

function invalidDeclarations() {
	// @ts-expect-error Declarations do not own live resources.
	notes.open();
	// @ts-expect-error Runtime resources belong to opening, not the declaration.
	defineApp({ id: 'test.runtime', tables: {}, kv: {}, runtime: {} });
	// @ts-expect-error AI wiring is not part of a schema.
	defineApp({ id: 'test.ai', tables: {}, kv: {}, ai: {} });
	// @ts-expect-error An empty runtime cannot replace the complete implementation.
	openLocal(notes, { runtime: {} });
	defineApp({
		id: 'test.invalid',
		tables: {},
		kv: {
			// @ts-expect-error Row identity is reserved in KV too.
			id: field.string(),
		},
	});
	defineApp({
		id: 'test.invalid',
		tables: {},
		kv: {
			// @ts-expect-error Defaults belong to the application.
			theme: { ...field.string(), default: 'light' },
		},
	});
	defineApp({
		id: 'test.invalid',
		kv: {},
		tables: {
			// @ts-expect-error Tables must pass through defineTable.
			notes: { title: field.string() },
		},
	});
}
void invalidDeclarations;
