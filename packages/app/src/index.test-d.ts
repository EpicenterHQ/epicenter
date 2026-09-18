/** Flat declarations preserve schema inference and the captured Account overload. */
import { expectTypeOf } from 'bun:test';
import { defineTable, field, type KvOf, type RowOf } from '@epicenter/app';
import type { Account } from '@epicenter/auth';
import { defineApp } from './index.js';
import { type AppRuntime, openApp } from './open.js';

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
function openings(
	account: Account,
	maybe: Account | undefined,
	runtime: AppRuntime,
	options: { account?: Account; runtime?: AppRuntime },
) {
	const local = openApp(notes);
	const explicitLocal = openApp(notes, { account: undefined });
	const runtimeOnly = openApp(notes, { runtime });
	const emptyOptions = openApp(notes, {});
	const signedIn = openApp(notes, { account });
	const signedInRuntime = openApp(notes, { account, runtime });
	const optional = openApp(notes, { account: maybe, runtime });
	const optionalOptions = openApp(notes, options);

	for (const opened of [
		explicitLocal,
		runtimeOnly,
		emptyOptions,
		signedInRuntime,
		optional,
		optionalOptions,
	]) {
		expectTypeOf(opened.account).toEqualTypeOf<typeof local.account>();
	}
	expectTypeOf(signedIn.account).toEqualTypeOf<typeof local.account>();
	if (signedIn.account)
		signedIn.account.personal.tables.notes.create({ title: 'Typed' });
	local.device.kv.update({ language: 'en' });
	// @ts-expect-error Accounts belong inside the options object.
	openApp(notes, account);
	// @ts-expect-error A runtime must supply all resources, with no ambient fallback.
	openApp(notes, { runtime: { sqlite: runtime.sqlite } });
	// @ts-expect-error Account presence is not a type argument.
	openApp<typeof notes, Account>(notes);
	// @ts-expect-error Account access requires narrowing, even after supplying an Account.
	signedIn.account.personal;
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
	// @ts-expect-error Declarations do not own live resources.
	notes.open();
	// @ts-expect-error Runtime resources belong to opening, not the declaration.
	defineApp({ id: 'test.runtime', tables: {}, kv: {}, runtime: {} });
	// @ts-expect-error AI wiring is not part of a schema.
	defineApp({ id: 'test.ai', tables: {}, kv: {}, ai: {} });
	// @ts-expect-error An empty runtime cannot replace the complete implementation.
	openApp(notes, { runtime: {} });
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
