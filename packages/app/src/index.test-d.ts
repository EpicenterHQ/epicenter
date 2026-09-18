/** Flat declarations preserve schema inference and the captured Account overload. */
import { expectTypeOf } from 'bun:test';
import type { Account } from '@epicenter/auth';
import {
	defineTable,
	field,
	type KvOf,
	type RowOf,
} from '@epicenter/data/definition';
import { defineApp } from './index.js';

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
function openings(account: Account, maybe: Account | undefined) {
	const local = notes.open();
	const explicitLocal = notes.open(undefined);
	const signedIn = notes.open(account);
	const optional = notes.open(maybe);
	expectTypeOf(local.account).toEqualTypeOf<undefined>();
	expectTypeOf(explicitLocal.account).toEqualTypeOf<undefined>();
	expectTypeOf(signedIn.account).not.toBeUndefined();
	expectTypeOf(optional.account).toEqualTypeOf<
		typeof signedIn.account | undefined
	>();
	signedIn.account.personal.tables.notes.create({ title: 'Typed' });
	local.device.kv.update({ language: 'en' });
	// @ts-expect-error A generic argument cannot supply an absent Account.
	notes.open<Account>();
	// @ts-expect-error An App opened without an account has no personal store.
	local.account.personal;
	// @ts-expect-error The declaration has no tasks table.
	local.device.tables.tasks;
	// @ts-expect-error The title field requires a string.
	local.device.tables.notes.create({ title: 12 });
	// @ts-expect-error The live App requires an explicit destination.
	signedIn.tables;
	// @ts-expect-error The live App requires an explicit destination.
	local.kv;
	// @ts-expect-error The declaration has schemas, not row operations.
	notes.tables.notes.create({ title: 'No live rows' });
	// @ts-expect-error Implementation options are not schema properties.
	notes.runtime;
	// @ts-expect-error There is only one declared identity.
	notes.appId;
	// @ts-expect-error No nested schema wrapper remains.
	notes.definition;
	// @ts-expect-error Field values retain their type.
	local.device.kv.update({ language: 42 });
}
void openings;

function invalidDeclarations() {
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
