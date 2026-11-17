/**
 * Generated data actions expose only named handle verbs with their input schemas.
 * Verifies both key shapes, Result answers, atomic passage edits, patch omission,
 * exact and refused ids, time-named adds, verb refusals, and MCP annotations.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { Value } from 'typebox/value';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { isActionError } from './errors.ts';
import {
	type ActionError,
	createMemoryContext,
	defineData,
	encodeActionResult,
	field,
	folder,
	inRun,
	isAction,
} from './index.ts';

function setup(files: Record<string, string> = {}) {
	const fields = {
		title: field.text(),
		note: field.text({ optional: true }),
		done: field.boolean(),
		tags: field.list(field.text()),
	};
	const data = defineData({
		notes: { description: 'a note', fields },
		'settings.md': { description: 'settings', fields },
	});
	return {
		context: createMemoryContext(files),
		data,
		notes: data.notes.actions('list', 'get', 'add', 'set', 'delete'),
		settings: data['settings.md'].actions('get', 'set', 'delete'),
	};
}

test('folder actions add, list, read, patch, and delete the handle records', async () => {
	const { context, notes } = setup();
	await inRun(context, async () => {
		expect(expectOk(await notes.list({}))).toEqual([]);
		const added = expectOk(
			await notes.add({ id: 'Dune', title: 'Dune', body: 'spice' }),
		);
		expect(added).toEqual({
			path: 'data/notes/Dune.md',
			id: 'Dune',
			title: 'Dune',
			body: 'spice',
			done: false,
			tags: [],
		});
		expect(await folder.read('data/notes/Dune.md')).toBe(
			'---\ntitle: "Dune"\ndone: false\ntags: []\n---\nspice',
		);
		expect(expectOk(await notes.get({ id: 'Dune' }))).toEqual(added);
		expect(expectOk(await notes.list({})).map(expectOk)).toEqual([added]);
		expect(
			expectOk(await notes.set({ id: 'Dune', note: 'read', body: 'Arrakis' })),
		).toEqual({ ...added, note: 'read', body: 'Arrakis' });
		expect(expectOk(await notes.delete({ id: 'Dune' }))).toBe(true);
		expect(expectOk(await notes.delete({ id: 'Dune' }))).toBe(false);
	});
});

test('one-file actions read absence, create with set, patch, and delete without an id', async () => {
	const { context, settings } = setup();
	await inRun(context, async () => {
		expect(expectOk(await settings.get({}))).toBeUndefined();
		const made = expectOk(
			await settings.set({ title: 'Daily', body: 'notes' }),
		);
		expect(made).toEqual({
			path: 'data/settings.md',
			title: 'Daily',
			body: 'notes',
			done: false,
			tags: [],
		});
		expect(expectOk(await settings.get({}))).toEqual(made);
		expect(expectOk(await settings.set({ note: 'today' }))).toEqual({
			...made,
			note: 'today',
		});
		expect(expectOk(await settings.delete({}))).toBe(true);
		expect(expectOk(await settings.delete({}))).toBe(false);
		expect(expectOk(await settings.get({}))).toBeUndefined();
	});
});

test('folder get and set answer Missing while a duplicate add answers Changed (there)', async () => {
	const { context, notes } = setup();
	await inRun(context, async () => {
		expect(
			expectErr<ActionError>(await notes.get({ id: 'gone' })),
		).toMatchObject({
			name: 'Missing',
			path: 'data/notes/gone.md',
		});
		expect(
			expectErr<ActionError>(await notes.set({ id: 'gone', title: 'x' })).name,
		).toBe('Missing');
		expectOk(await notes.add({ id: 'same', title: 'first' }));
		expect(
			expectErr<ActionError>(await notes.add({ id: 'same', title: 'second' })),
		).toMatchObject({
			name: 'Changed',
			why: 'there',
			path: 'data/notes/same.md',
		});
		expect(expectOk(await notes.get({ id: 'same' })).title).toBe('first');
		expect(expectErr<ActionError>(await notes.get({ id: '../bad' })).name).toBe(
			'Refused',
		);
	});
});

// Passage edits and field patches must share the handle's single update.
test.each(['folder', 'one-file'] as const)(
	'%s set edits one passage, changes fields, and preserves omitted switches and lists',
	async (kind) => {
		const { context, notes, settings } = setup();
		const set = (input: Parameters<typeof settings.set>[0]) =>
			kind === 'folder'
				? notes.set({ id: 'a', ...input })
				: settings.set(input);
		await inRun(context, async () => {
			if (kind === 'folder')
				expectOk(await notes.add({ id: 'a', title: 'old' }));
			expectOk(
				await set({
					title: 'old',
					body: 'one two three',
					done: true,
					tags: ['keep'],
					note: 'remove',
				}),
			);
			const edited = expectOk(
				await set({
					title: 'new',
					edit: { old: 'two', new: 'TWO' },
					note: null,
				}),
			);
			expect(edited).toMatchObject({
				title: 'new',
				body: 'one TWO three',
				done: true,
				tags: ['keep'],
			});
			expect(edited).not.toHaveProperty('note');
			expect(expectOk(await set({ title: 'last' }))).toMatchObject({
				title: 'last',
				body: 'one TWO three',
				done: true,
				tags: ['keep'],
			});
		});
	},
);

test.each(['folder', 'one-file'] as const)(
	'%s edit refuses an absent or repeated quote and body plus edit without writing fields',
	async (kind) => {
		const { context, notes, settings } = setup();
		const set = (input: Parameters<typeof settings.set>[0]) =>
			kind === 'folder'
				? notes.set({ id: 'a', ...input })
				: settings.set(input);
		await inRun(context, async () => {
			if (kind === 'folder')
				expectOk(await notes.add({ id: 'a', title: 'old' }));
			expectOk(await set({ title: 'old', body: 'again again' }));
			for (const [old, why] of [
				['missing', 'quote'],
				['again', 'twice'],
			] as const) {
				expect(
					expectErr<ActionError>(
						await set({ title: 'unwritten', edit: { old, new: 'new' } }),
					),
				).toMatchObject({ name: 'Changed', why });
			}
			expect(
				expectErr<ActionError>(
					await set({
						title: 'unwritten',
						body: 'other',
						edit: { old: 'again again', new: 'new' },
					}),
				).name,
			).toBe('Refused');
			expect(
				expectErr<ActionError>(await set({ edit: { old: '', new: 'new' } }))
					.name,
			).toBe('Refused');
			const record = expectOk(
				await (kind === 'folder' ? notes.get({ id: 'a' }) : settings.get({})),
			);
			expect(record).toMatchObject({ title: 'old', body: 'again again' });
		});
	},
);

test('edit of an absent folder id is Missing and an absent one-file passage is Changed (quote)', async () => {
	const { context, notes, settings } = setup();
	await inRun(context, async () => {
		expect(
			expectErr<ActionError>(
				await notes.set({ id: 'absent', edit: { old: 'old', new: 'new' } }),
			),
		).toMatchObject({ name: 'Missing', path: 'data/notes/absent.md' });
		expect(
			expectErr<ActionError>(
				await settings.set({ edit: { old: 'old', new: 'new' } }),
			),
		).toMatchObject({
			name: 'Changed',
			why: 'quote',
			path: 'data/settings.md',
		});
		expect(await folder.list('data')).toEqual([]);
	});
});

test.each(['folder', 'one-file'] as const)(
	'%s set repairs a readable misfit while edit returns its Misfit before patching',
	async (kind) => {
		const text = '---\ntitle: 123\nextra: "keep"\n---\nold body';
		const path = kind === 'folder' ? 'data/notes/a.md' : 'data/settings.md';
		const { context, notes, settings } = setup({ [path]: text });
		const set = (input: Parameters<typeof settings.set>[0]) =>
			kind === 'folder'
				? notes.set({ id: 'a', ...input })
				: settings.set(input);
		await inRun(context, async () => {
			expect(
				expectErr<ActionError>(
					await set({ title: 'fixed', edit: { old: 'old', new: 'new' } }),
				).name,
			).toBe('Misfit');
			expect(await folder.read(path)).toBe(text);
			expect(expectOk(await set({ title: 'fixed' }))).toMatchObject({
				title: 'fixed',
				body: 'old body',
			});
			expect(await folder.read(path)).toBe(
				text.replace('title: 123', 'title: "fixed"'),
			);
		});
	},
);

test('list retains full fitting records and Misfit Results', async () => {
	const { context, notes } = setup({
		'data/notes/a.md': '---\ntitle: "good"\n---\nbody',
		'data/notes/b.md': '---\ntitle: 123\n---\nbad body',
	});
	await inRun(context, async () => {
		const rows = expectOk(await notes.list({}));
		expect(
			rows.map((row) => (row.error === null ? expectOk(row) : expectErr(row))),
		).toMatchObject([
			{ id: 'a', title: 'good', body: 'body' },
			{ name: 'Misfit', record: { id: 'b', body: 'bad body' } },
		]);
	});
});

test('generated writes accept refs as given and expose a declared was field as ordinary data', async () => {
	const data = defineData({
		targets: { fields: {} },
		notes: { fields: { target: field.ref('targets'), was: field.text() } },
	});
	const { add, set } = data.notes.actions('add', 'set');
	await inRun(createMemoryContext(), async () => {
		expect(
			expectOk(await add({ id: 'a', target: 'absent', was: 'first' })),
		).toMatchObject({ target: 'absent', was: 'first' });
		expect(
			expectOk(await set({ id: 'a', target: 'also-absent', was: 'last' })),
		).toMatchObject({ target: 'also-absent', was: 'last' });
	});
});

test('add without an id names the record by the moment and returns that id; with one it uses it', async () => {
	const { context, notes } = setup();
	await inRun(context, async () => {
		const named = expectOk(await notes.add({ title: 'untitled' }));
		expect(named.id).toMatch(/^\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-z]{8}$/);
		expect(named.path).toBe(`data/notes/${named.id}.md`);
		expect(expectOk(await notes.get({ id: named.id })).title).toBe('untitled');
		expect(expectOk(await notes.add({ id: 'Dune', title: 'Dune' })).id).toBe(
			'Dune',
		);
		expect((await folder.list('data/notes')).sort()).toEqual(
			['data/notes/Dune.md', named.path].sort(),
		);
	});
});

test('generated verbs take the id as the file name and refuse one that cannot name a file, saying why', async () => {
	const { context, notes } = setup({
		'data/notes/Caf\u00e9.md': '---\ntitle: "x"\n---\none two',
	});
	await inRun(context, async () => {
		for (const [id, message] of [
			[' Caf\u00e9 ', 'notes: an id cannot start or end with whitespace'],
			['Cafe\u0301', 'notes: an id must be Unicode NFC'],
			['../bad', 'notes: an id cannot contain / or \\'],
		] as const)
			for (const result of [
				await notes.get({ id }),
				await notes.add({ id, title: 'x' }),
				await notes.set({ id, title: 'x' }),
				await notes.delete({ id }),
			])
				expect(expectErr(result)).toMatchObject({ name: 'Refused', message });
		expect(
			expectOk(
				await notes.set({
					id: 'Caf\u00e9',
					edit: { old: 'one', new: 'three' },
				}),
			).body,
		).toBe('three two');
		expect(expectOk(await notes.delete({ id: 'Caf\u00e9' }))).toBe(true);
	});
});

test('an encoded Misfit answer keeps the id of a folder record and has none for a one-file key', async () => {
	const text = '---\ntitle: 123\n---\nbody';
	const { context, notes, settings } = setup({
		'data/notes/a.md': text,
		'data/settings.md': text,
	});
	await inRun(context, async () => {
		const sent = (result: Parameters<typeof encodeActionResult>[0]) =>
			JSON.parse(JSON.stringify(expectErr(encodeActionResult(result))));
		const folderMisfit = sent(await notes.get({ id: 'a' }));
		expect(folderMisfit).toMatchObject({ name: 'Misfit', id: 'a' });
		expect(isActionError(folderMisfit)).toBe(true);
		const single = sent(await settings.get({}));
		expect(single).toMatchObject({ name: 'Misfit', path: 'data/settings.md' });
		expect(single).not.toHaveProperty('id');
	});
});

// Discovery metadata and schemas are the boundary used by CLI, HTTP, and MCP.
test('schemas require add fields but not an id, reject empty edit.old, and permit only optional-field removal', () => {
	const { notes, settings } = setup();
	const add = Type.Object(notes.add.input, { additionalProperties: false });
	const set = Type.Object(notes.set.input, { additionalProperties: false });
	expect(Value.Check(add, { id: 'a', title: 'yes' })).toBe(true);
	expect(Value.Check(add, { title: 'yes' })).toBe(true);
	for (const input of [{ id: 'a' }, { id: 7, title: 'yes' }])
		expect(Value.Check(add, input)).toBe(false);
	for (const action of [notes.set, settings.set]) {
		const schema = Type.Object(action.input, { additionalProperties: false });
		const id = action === notes.set ? { id: 'a' } : {};
		expect(Value.Check(schema, { ...id, edit: { old: '', new: 'x' } })).toBe(
			false,
		);
		expect(Value.Check(schema, { ...id, edit: { old: 'x', new: '' } })).toBe(
			true,
		);
		expect(Value.Check(schema, { ...id, edit: { old: 'x' } })).toBe(false);
		expect(Value.Check(schema, { ...id, note: null })).toBe(true);
		expect(Value.Check(schema, { ...id, title: null })).toBe(false);
	}
	expect(Value.Check(set, { title: 'missing id' })).toBe(false);
	expect(Value.Check(set, { id: 'a', was: {} })).toBe(false);
	expect(notes.add.input.id).toMatchObject({
		description:
			'The name of the new note; left out, it is named by the moment it is made',
	});
	expect(Object.keys(settings.get.input)).toEqual([]);
	expect(Object.keys(settings.delete.input)).toEqual([]);
});

test('only named verbs are returned, every action is callable, and annotations match the record', () => {
	const { notes, settings, data } = setup();
	expect(Object.keys(data.notes.actions('get', 'set'))).toEqual(['get', 'set']);
	for (const actions of [notes, settings]) {
		for (const [verb, action] of Object.entries(actions)) {
			expect(isAction(action)).toBe(true);
			expect(action.description).toContain(
				actions === notes ? 'note' : 'settings',
			);
			expect(action.annotations).toEqual(
				verb === 'list' || verb === 'get'
					? { readOnlyHint: true, openWorldHint: false }
					: {
							readOnlyHint: false,
							destructiveHint: verb !== 'add',
							idempotentHint: true,
							openWorldHint: false,
						},
			);
		}
	}
	expect(notes.get.description).toBe(
		'Read one note: its fields and body; a file that does not fit its fields is an error',
	);
});

test('unnamed verbs and unavailable verbs throw at declaration naming the key', () => {
	const { data } = setup();
	// @ts-expect-error verbs must be named
	expect(() => data.notes.actions()).toThrow('notes');
	// @ts-expect-error verbs must be named for one-file keys too
	expect(() => data['settings.md'].actions()).toThrow('settings.md');
	// @ts-expect-error one-file keys do not offer list
	expect(() => data['settings.md'].actions('list')).toThrow('settings.md');
	// @ts-expect-error one-file keys do not offer add
	expect(() => data['settings.md'].actions('add')).toThrow('settings.md');
	// @ts-expect-error unknown verbs are bugs
	expect(() => data.notes.actions('dance')).toThrow('notes');
});
