/**
 * Generated data actions expose only named handle verbs with their input schemas.
 * Verifies both key shapes, Result answers, passage edits, patch omission,
 * exact and refused ids, time-named creates, verb refusals, and MCP annotations.
 */
import { expect, test } from 'bun:test';
import { Value } from 'typebox/value';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type ActionError,
	defineData,
	encodeActionResult,
	field,
	isAction,
} from './index.ts';
import { tempFolder } from './temp-folder.test-support.ts';

async function setup(seed: Record<string, string> = {}) {
	const { folder, read, files } = await tempFolder(seed);
	const fields = {
		title: field.text(),
		note: field.text({ optional: true }),
		done: field.boolean(),
		tags: field.list(field.text()),
	};
	const data = defineData(folder, {
		notes: { description: 'a note', fields },
		'settings.md': { description: 'settings', fields },
	});
	return {
		read,
		files,
		data,
		notes: data.notes.actions(
			'list',
			'get',
			'create',
			'patch',
			'edit',
			'delete',
		),
		settings: data['settings.md'].actions('get', 'patch', 'edit', 'delete'),
	};
}

test('folder actions create, list, read, patch, and delete the handle records', async () => {
	const { read, notes } = await setup();
	expect(expectOk(await notes.list({}))).toEqual([]);
	const added = expectOk(
		await notes.create({ id: 'Dune', title: 'Dune', body: 'spice' }),
	);
	expect(added).toEqual({
		path: 'data/notes/Dune.md',
		id: 'Dune',
		title: 'Dune',
		body: 'spice',
		done: false,
		tags: [],
	});
	expect(await read('data/notes/Dune.md')).toBe(
		'---\ntitle: "Dune"\ndone: false\ntags: []\n---\nspice',
	);
	expect(expectOk(await notes.get({ id: 'Dune' }))).toEqual(added);
	expect(expectOk(await notes.list({})).map(expectOk)).toEqual([added]);
	expect(
		expectOk(await notes.patch({ id: 'Dune', note: 'read', body: 'Arrakis' })),
	).toEqual({ ...added, note: 'read', body: 'Arrakis' });
	expect(expectOk(await notes.delete({ id: 'Dune' }))).toBe(true);
	expect(expectOk(await notes.delete({ id: 'Dune' }))).toBe(false);
});

test('one-file actions read absence, create with patch, patch, and delete without an id', async () => {
	const { settings } = await setup();
	expect(expectOk(await settings.get({}))).toBeUndefined();
	const made = expectOk(
		await settings.patch({ title: 'Daily', body: 'notes' }),
	);
	expect(made).toEqual({
		path: 'data/settings.md',
		title: 'Daily',
		body: 'notes',
		done: false,
		tags: [],
	});
	expect(expectOk(await settings.get({}))).toEqual(made);
	expect(expectOk(await settings.patch({ note: 'today' }))).toEqual({
		...made,
		note: 'today',
	});
	expect(expectOk(await settings.delete({}))).toBe(true);
	expect(expectOk(await settings.delete({}))).toBe(false);
	expect(expectOk(await settings.get({}))).toBeUndefined();
});

test('folder get and patch answer Missing while a duplicate create answers Changed (there)', async () => {
	const { notes } = await setup();
	expect(expectErr<ActionError>(await notes.get({ id: 'gone' }))).toMatchObject(
		{
			name: 'Missing',
			path: 'data/notes/gone.md',
		},
	);
	expect(
		expectErr<ActionError>(await notes.patch({ id: 'gone', title: 'x' })).name,
	).toBe('Missing');
	expectOk(await notes.create({ id: 'same', title: 'first' }));
	expect(
		expectErr<ActionError>(await notes.create({ id: 'same', title: 'second' })),
	).toMatchObject({
		name: 'Changed',
		cause: 'there',
		path: 'data/notes/same.md',
	});
	expect(expectOk(await notes.get({ id: 'same' })).title).toBe('first');
	expect(expectErr<ActionError>(await notes.get({ id: '../bad' })).name).toBe(
		'Misfit',
	);
});

test.each(['folder', 'one-file'] as const)(
	'%s patch changes fields, edit replaces one passage, and both keep omitted switches and lists',
	async (kind) => {
		const { notes, settings } = await setup();
		const patch = (input: Parameters<typeof settings.patch>[0]) =>
			kind === 'folder'
				? notes.patch({ id: 'a', ...input })
				: settings.patch(input);
		const edit = (input: Parameters<typeof settings.edit>[0]) =>
			kind === 'folder'
				? notes.edit({ id: 'a', ...input })
				: settings.edit(input);
		if (kind === 'folder')
			expectOk(await notes.create({ id: 'a', title: 'old' }));
		expectOk(
			await patch({
				title: 'old',
				body: 'one two three',
				done: true,
				tags: ['keep'],
				note: 'remove',
			}),
		);
		expectOk(await patch({ title: 'new', note: null }));
		const edited = expectOk(await edit({ old: 'two', new: 'TWO' }));
		expect(edited).toMatchObject({
			title: 'new',
			body: 'one TWO three',
			done: true,
			tags: ['keep'],
		});
		expect(edited).not.toHaveProperty('note');
		expect(expectOk(await patch({ title: 'last' }))).toMatchObject({
			title: 'last',
			body: 'one TWO three',
			done: true,
			tags: ['keep'],
		});
	},
);

test.each(['folder', 'one-file'] as const)(
	'%s edit refuses an absent or repeated quote and an empty one without writing',
	async (kind) => {
		const { notes, settings } = await setup();
		const edit = (input: Parameters<typeof settings.edit>[0]) =>
			kind === 'folder'
				? notes.edit({ id: 'a', ...input })
				: settings.edit(input);
		if (kind === 'folder')
			expectOk(await notes.create({ id: 'a', title: 'old' }));
		expectOk(
			await (kind === 'folder'
				? notes.patch({ id: 'a', body: 'again again' })
				: settings.patch({ title: 'old', body: 'again again' })),
		);
		for (const [old, cause] of [
			['missing', 'quote'],
			['again', 'twice'],
		] as const) {
			expect(
				expectErr<ActionError>(await edit({ old, new: 'new' })),
			).toMatchObject({ name: 'Changed', cause });
		}
		expect(
			expectErr<ActionError>(await edit({ old: '', new: 'new' })).name,
		).toBe('Misfit');
		const record = expectOk(
			await (kind === 'folder' ? notes.get({ id: 'a' }) : settings.get({})),
		);
		expect(record).toMatchObject({ title: 'old', body: 'again again' });
	},
);

test('edit of an absent record is Missing for both key shapes', async () => {
	const { files, notes, settings } = await setup();
	expect(
		expectErr<ActionError>(
			await notes.edit({ id: 'absent', old: 'old', new: 'new' }),
		),
	).toMatchObject({ name: 'Missing', path: 'data/notes/absent.md' });
	expect(
		expectErr<ActionError>(await settings.edit({ old: 'old', new: 'new' })),
	).toMatchObject({ name: 'Missing', path: 'data/settings.md' });
	expect(await files('data')).toEqual([]);
});

test.each(['folder', 'one-file'] as const)(
	'%s patch repairs a readable misfit while edit returns its Misfit before changing it',
	async (kind) => {
		const text = '---\ntitle: 123\nextra: "keep"\n---\nold body';
		const path = kind === 'folder' ? 'data/notes/a.md' : 'data/settings.md';
		const { read, notes, settings } = await setup({ [path]: text });
		expect(
			expectErr<ActionError>(
				await (kind === 'folder'
					? notes.edit({ id: 'a', old: 'old', new: 'new' })
					: settings.edit({ old: 'old', new: 'new' })),
			).name,
		).toBe('Misfit');
		expect(await read(path)).toBe(text);
		expect(
			expectOk(
				await (kind === 'folder'
					? notes.patch({ id: 'a', title: 'fixed' })
					: settings.patch({ title: 'fixed' })),
			),
		).toMatchObject({ title: 'fixed', body: 'old body' });
		expect(await read(path)).toBe(text.replace('title: 123', 'title: "fixed"'));
	},
);

test('list retains full fitting records and Misfit Results', async () => {
	const { notes } = await setup({
		'data/notes/a.md': '---\ntitle: "good"\n---\nbody',
		'data/notes/b.md': '---\ntitle: 123\n---\nbad body',
	});
	const rows = expectOk(await notes.list({}));
	expect(
		rows.map((row) => (row.error === null ? expectOk(row) : expectErr(row))),
	).toMatchObject([
		{ id: 'a', title: 'good', body: 'body' },
		{ name: 'Misfit', record: { id: 'b', body: 'bad body' } },
	]);
});

test('generated writes accept refs as given and expose a declared was field as ordinary data', async () => {
	const { folder } = await tempFolder();
	const data = defineData(folder, {
		targets: { fields: {} },
		notes: { fields: { target: field.ref('targets'), was: field.text() } },
	});
	const { create, patch } = data.notes.actions('create', 'patch');
	expect(
		expectOk(await create({ id: 'a', target: 'absent', was: 'first' })),
	).toMatchObject({ target: 'absent', was: 'first' });
	expect(
		expectOk(await patch({ id: 'a', target: 'also-absent', was: 'last' })),
	).toMatchObject({ target: 'also-absent', was: 'last' });
});

test('create without an id names the record by the moment and returns that id; with one it uses it', async () => {
	const { files, notes } = await setup();
	const named = expectOk(await notes.create({ title: 'untitled' }));
	expect(named.id).toMatch(/^\d{4}-\d\d-\d\dT[\d-]+Z-[0-9a-z]{8}$/);
	expect(named.path).toBe(`data/notes/${named.id}.md`);
	expect(expectOk(await notes.get({ id: named.id })).title).toBe('untitled');
	expect(expectOk(await notes.create({ id: 'Dune', title: 'Dune' })).id).toBe(
		'Dune',
	);
	expect((await files('data/notes')).sort()).toEqual(
		['data/notes/Dune.md', named.path].sort(),
	);
});

test('generated verbs take the id as the file name and refuse one that cannot name a file, saying why', async () => {
	const { notes } = await setup({
		'data/notes/Caf\u00e9.md': '---\ntitle: "x"\n---\none two',
	});
	for (const [id, message] of [
		[
			' Caf\u00e9 ',
			'data/notes does not fit its fields:\ndata/notes: " Caf\u00e9 ": an id cannot start or end with whitespace; send "Caf\u00e9"',
		],
		[
			'Cafe\u0301',
			'data/notes does not fit its fields:\ndata/notes: "Cafe\u0301": an id must be Unicode NFC; send "Caf\u00e9"',
		],
		[
			'../bad',
			'data/notes does not fit its fields:\ndata/notes: "../bad": an id cannot contain / or \\',
		],
	] as const)
		for (const result of [
			await notes.get({ id }),
			await notes.create({ id, title: 'x' }),
			await notes.patch({ id, title: 'x' }),
			await notes.edit({ id, old: 'one', new: 'x' }),
			await notes.delete({ id }),
		])
			expect(expectErr(result)).toMatchObject({ name: 'Misfit', message });
	expect(
		expectOk(await notes.edit({ id: 'Caf\u00e9', old: 'one', new: 'three' }))
			.body,
	).toBe('three two');
	expect(expectOk(await notes.delete({ id: 'Caf\u00e9' }))).toBe(true);
});

test('an encoded Misfit answer keeps the id of a folder record and has none for a one-file key', async () => {
	const text = '---\ntitle: 123\n---\nbody';
	const { notes, settings } = await setup({
		'data/notes/a.md': text,
		'data/settings.md': text,
	});
	const sent = (result: Parameters<typeof encodeActionResult>[0]) =>
		JSON.parse(JSON.stringify(expectErr(encodeActionResult(result))));
	const folderMisfit = sent(await notes.get({ id: 'a' }));
	expect(folderMisfit).toMatchObject({ name: 'Misfit', id: 'a' });
	const single = sent(await settings.get({}));
	expect(single).toMatchObject({ name: 'Misfit', path: 'data/settings.md' });
	expect(single).not.toHaveProperty('id');
});

// Discovery metadata and schemas are the boundary used by CLI, HTTP, and MCP.
test('schemas require create fields but not an id, permit only optional-field removal, and give edit only id, old, and new', async () => {
	const { notes, settings } = await setup();
	const create = notes.create.input;
	const patch = notes.patch.input;
	expect(Value.Check(create, { id: 'a', title: 'yes' })).toBe(true);
	expect(Value.Check(create, { title: 'yes' })).toBe(true);
	for (const input of [{ id: 'a' }, { id: 7, title: 'yes' }])
		expect(Value.Check(create, input)).toBe(false);
	for (const action of [notes.patch, settings.patch]) {
		const schema = action.input;
		const id = action === notes.patch ? { id: 'a' } : {};
		expect(Value.Check(schema, { ...id, note: null })).toBe(true);
		expect(Value.Check(schema, { ...id, title: null })).toBe(false);
		expect(Value.Check(schema, { ...id, edit: { old: 'x', new: 'y' } })).toBe(
			false,
		);
	}
	expect(Value.Check(patch, { title: 'missing id' })).toBe(false);
	expect(Value.Check(patch, { id: 'a', was: {} })).toBe(false);
	for (const action of [notes.edit, settings.edit]) {
		const schema = action.input;
		const id = action === notes.edit ? { id: 'a' } : {};
		expect(Value.Check(schema, { ...id, old: 'x', new: '' })).toBe(true);
		expect(Value.Check(schema, { ...id, old: '', new: 'x' })).toBe(false);
		expect(Value.Check(schema, { ...id, old: 'x' })).toBe(false);
		// A passage edit changes no field and does not replace the body.
		expect(Value.Check(schema, { ...id, old: 'x', new: 'y', title: 'z' })).toBe(
			false,
		);
		expect(Value.Check(schema, { ...id, old: 'x', new: 'y', body: 'z' })).toBe(
			false,
		);
	}
	expect(Object.keys(notes.edit.input.properties)).toEqual([
		'id',
		'old',
		'new',
	]);
	expect(Object.keys(settings.edit.input.properties)).toEqual(['old', 'new']);
	expect(notes.create.input.properties.id).toMatchObject({
		description:
			'The name of the new note; left out, it is named by the moment it is made',
	});
	expect(settings.get.input).toEqual({
		type: 'object',
		properties: {},
		required: [],
		additionalProperties: false,
	});
	expect(Object.keys(settings.delete.input.properties)).toEqual([]);
});

test('only named verbs are returned, every action is callable, and annotations say which writes are safe to repeat', async () => {
	const { notes, settings, data } = await setup();
	expect(Object.keys(data.notes.actions('get', 'patch'))).toEqual([
		'get',
		'patch',
	]);
	const written = { readOnlyHint: false, openWorldHint: false };
	const expected: Record<string, object> = {
		list: { readOnlyHint: true, openWorldHint: false },
		get: { readOnlyHint: true, openWorldHint: false },
		// Without an id, each call makes another record.
		create: { ...written, destructiveHint: false, idempotentHint: false },
		patch: { ...written, destructiveHint: true, idempotentHint: true },
		// Replacing a with ab twice gives abb.
		edit: { ...written, destructiveHint: true, idempotentHint: false },
		delete: { ...written, destructiveHint: true, idempotentHint: true },
	};
	for (const actions of [notes, settings]) {
		for (const [verb, action] of Object.entries(actions)) {
			expect(isAction(action)).toBe(true);
			expect(action.description).toContain(
				actions === notes ? 'note' : 'settings',
			);
			expect(action.annotations).toEqual(expected[verb]);
		}
	}
	expect(notes.get.description).toBe(
		'Read one note: its fields and body; a file that does not fit its fields is an error',
	);
	expect(notes.patch.description).toContain(
		'A missing note answers Missing and is never made',
	);
	expect(notes.patch.description).toContain('replaces the whole body');
	expect(settings.patch.description).toContain('made when it is absent');
	expect(notes.create.description).toContain(
		'A caller that may retry should send an id',
	);
	expect(notes.edit.description).toContain('exactly one occurrence of old');
	expect(notes.edit.description).toContain('Missing');
	expect(notes.edit.description).toContain('Not safe to repeat');
});

test('unnamed verbs and unavailable verbs throw at declaration naming the key', async () => {
	const { data } = await setup();
	// @ts-expect-error verbs must be named
	expect(() => data.notes.actions()).toThrow('notes');
	// @ts-expect-error verbs must be named for one-file keys too
	expect(() => data['settings.md'].actions()).toThrow('settings.md');
	// @ts-expect-error one-file keys do not offer list
	expect(() => data['settings.md'].actions('list')).toThrow('settings.md');
	// @ts-expect-error one-file keys do not offer create
	expect(() => data['settings.md'].actions('create')).toThrow('settings.md');
	// @ts-expect-error the old verbs are gone
	expect(() => data.notes.actions('set')).toThrow('notes');
	// @ts-expect-error unknown verbs are bugs
	expect(() => data.notes.actions('dance')).toThrow('notes');
});
