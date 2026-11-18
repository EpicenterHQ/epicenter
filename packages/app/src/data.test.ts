/**
 * Data handles read and patch top-level Markdown records through the current run.
 * Covers both key shapes, exact and refused ids, create-only adds, repairs, diagnostics,
 * list membership, and the separation between app writes and reference checks.
 */
import { expect, test } from 'bun:test';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { idProblem } from './id.ts';
import {
	ActionError,
	createMemoryContext,
	defineData,
	field,
	folder,
	inRun,
	Ok,
	timeId,
} from './index.ts';

function setup(files: Record<string, string> = {}) {
	const context = createMemoryContext(files);
	const data = defineData({
		notes: {
			fields: {
				title: field.text(),
				count: field.integer({ optional: true }),
				done: field.boolean(),
				tags: field.list(field.text()),
			},
		},
		'settings.md': {
			fields: { title: field.text(), count: field.integer({ optional: true }) },
		},
	});
	return { context, data };
}

test('folder verbs read, create, patch, compute, list, and delete flat records', async () => {
	const {
		context,
		data: { notes },
	} = setup();
	await inRun(context, async () => {
		expect(expectOk(await notes.get('Dune'))).toBeUndefined();
		expect(notes.path('Dune')).toBe('data/notes/Dune.md');
		const added = expectOk(
			await notes.add('Dune', { title: 'Dune', body: 'Arrakis' }),
		);
		expect(added).toEqual({
			path: 'data/notes/Dune.md',
			id: 'Dune',
			title: 'Dune',
			body: 'Arrakis',
			done: false,
			tags: [],
		});
		expect(expectOk(await notes.get('Dune'))).toEqual(added);
		expect(
			expectOk(await notes.set('Dune', { count: 2, body: 'spice' })).count,
		).toBe(2);
		expect(
			expectOk(
				await notes.update('Dune', (now) =>
					Ok({ count: (now?.count ?? 0) + 1 }),
				),
			).count,
		).toBe(3);
		expect(
			expectOk(await notes.set('Dune', { count: null })),
		).not.toHaveProperty('count');
		expect((await notes.list()).map(expectOk)).toEqual([
			{ ...added, body: 'spice' },
		]);
		expect(expectOk(await notes.delete('Dune'))).toBe(true);
		expect(expectOk(await notes.delete('Dune'))).toBe(false);
		expect(expectOk(await notes.get('Dune'))).toBeUndefined();
	});
});

test('one-file verbs read absent, create through set, compute, and delete without an id', async () => {
	const { context, data } = setup();
	const settings = data['settings.md'];
	expect(settings).not.toHaveProperty('list');
	expect(settings).not.toHaveProperty('add');
	expect(settings.path()).toBe('data/settings.md');
	await inRun(context, async () => {
		expect(expectOk(await settings.get())).toBeUndefined();
		expect(
			expectOk(await settings.set({ title: 'Daily', body: 'notes' })),
		).toEqual({ path: 'data/settings.md', title: 'Daily', body: 'notes' });
		expect(
			expectOk(
				await settings.update((now) => Ok({ count: (now?.count ?? 0) + 1 })),
			),
		).toMatchObject({ title: 'Daily', count: 1 });
		expect(expectOk(await settings.get())).not.toHaveProperty('id');
		expect(expectOk(await settings.delete())).toBe(true);
		expect(expectOk(await settings.delete())).toBe(false);
		let sawAbsent = false;
		expect(
			expectOk(
				await settings.update((now) => {
					sawAbsent = now === undefined;
					return Ok({ title: 'New' });
				}),
			),
		).toMatchObject({ title: 'New' });
		expect(sawAbsent).toBe(true);
	});
});

test('add is create-only even when another add supplies identical content', async () => {
	const {
		context,
		data: { notes },
	} = setup();
	await inRun(context, async () => {
		const [created, collision] = await Promise.all([
			notes.add('same', { title: 'first' }),
			notes.add('same', { title: 'second' }),
		]);
		expect(expectOk(created)).toMatchObject({ title: 'first' });
		const there = expectErr(collision);
		expect(there).toMatchObject({
			name: 'Changed',
			why: 'there',
			path: 'data/notes/same.md',
			message: 'data/notes/same.md is already there',
		});
		expect(
			expectErr(await notes.add('same', { title: 'first' })),
		).toMatchObject({ name: 'Changed', why: 'there' });
		expect(expectOk(await notes.get('same'))).toMatchObject({ title: 'first' });
	});
});

test('folder set returns Missing while one-file set creates only a fitting record', async () => {
	const { context, data } = setup();
	await inRun(context, async () => {
		expect(expectErr(await data.notes.set('typo', { title: 'x' })).name).toBe(
			'Missing',
		);
		expect(expectErr(await data['settings.md'].set({ count: 1 })).name).toBe(
			'Refused',
		);
		expect(await folder.read('data/settings.md')).toBeUndefined();
		expect(expectOk(await data['settings.md'].set({ title: 'x' })).title).toBe(
			'x',
		);
		let absent = false;
		expect(
			expectOk(
				await data.notes.update('new', (now) => {
					absent = now === undefined;
					return Ok({ title: 'new' });
				}),
			).id,
		).toBe('new');
		expect(absent).toBe(true);
	});
});

test('plain set repairs misfits and preserves undeclared lines and body for both key shapes', async () => {
	const text = '---\ntitle: 123\nextra: unquoted\ncount: 2\n---\nkept body';
	const { context, data } = setup({
		'data/notes/a.md': text,
		'data/settings.md': text,
	});
	await inRun(context, async () => {
		expect(expectErr(await data.notes.get('a'))).toMatchObject({
			name: 'Misfit',
			record: { id: 'a', count: 2, body: 'kept body' },
		});
		const repaired = expectOk(await data.notes.set('a', { title: 'fixed' }));
		expect(repaired).toMatchObject({
			title: 'fixed',
			count: 2,
			body: 'kept body',
		});
		expect(
			expectOk(await data['settings.md'].set({ title: 'fixed' })).title,
		).toBe('fixed');
		for (const path of ['data/notes/a.md', 'data/settings.md'])
			expect(await folder.read(path)).toBe(
				text.replace('title: 123', 'title: "fixed"'),
			);
	});
});

test('update returns Misfit before calling its function and set cannot rewrite unreadable front matter', async () => {
	for (const text of [
		'---\ntitle: 123\n---\nbody',
		'---\nnot a field\n---\nbody',
	]) {
		const { context, data } = setup({
			'data/notes/a.md': text,
			'data/settings.md': text,
		});
		await inRun(context, async () => {
			const change = () => {
				throw new Error('must not call on a misfit');
			};
			expect(expectErr(await data.notes.update('a', change)).name).toBe(
				'Misfit',
			);
			expect(expectErr(await data['settings.md'].update(change)).name).toBe(
				'Misfit',
			);
			if (text.includes('not a field')) {
				expect(
					expectErr(await data.notes.set('a', { title: 'fixed' })).name,
				).toBe('Misfit');
				expect(
					expectErr(await data['settings.md'].set({ title: 'fixed' })).name,
				).toBe('Misfit');
			}
			expect(await folder.read('data/notes/a.md')).toBe(text);
			expect(await folder.read('data/settings.md')).toBe(text);
		});
	}
});

test('computed refusals and faults leave a fitting file unchanged', async () => {
	const { context, data } = setup();
	await inRun(context, async () => {
		await data.notes.add('a', { title: 'a' });
		const refusal = ActionError.Refused({ message: 'stop' });
		expect(await data.notes.update('a', () => refusal)).toBe(refusal);
		expect(await data['settings.md'].update(() => refusal)).toBe(refusal);
		await expect(
			data.notes.update('a', () => {
				throw new Error('fault');
			}),
		).rejects.toThrow('fault');
		expect(expectOk(await data.notes.get('a'))?.title).toBe('a');
		expect(expectOk(await data['settings.md'].get())).toBeUndefined();
	});
});

// Each refusal happens before any folder operation; path checks nothing.
const invalidIds = [
	'',
	'   ',
	'a/b',
	'a\\b',
	'a\u0000b',
	'a\u007fb',
	'a\u0085b',
	'.hidden',
	' .hidden',
	'界'.repeat(67),
	'a'.repeat(201),
];
test.each(invalidIds)(
	'every folder verb refuses the id %j without touching the folder',
	async (id) => {
		const {
			context,
			data: { notes },
		} = setup();
		const untouched = () => {
			throw new Error('invalid id reached the folder');
		};
		const guarded = {
			...context,
			folder: {
				...context.folder,
				read: untouched,
				edit: untouched,
				delete: untouched,
			},
		};
		await inRun(guarded, async () => {
			for (const result of [
				await notes.get(id),
				await notes.add(id, { title: 'x' }),
				await notes.set(id, { title: 'x' }),
				await notes.update(id, () => {
					throw new Error('invalid id reached callback');
				}),
				await notes.delete(id),
			])
				expect(expectErr(result).name).toBe('Refused');
		});
		expect(idProblem(id)).toBeDefined();
	},
);

test.each([
	[
		' Dune',
		'notes: " Dune": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'Dune ',
		'notes: "Dune ": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'Dune\u00a0',
		'notes: "Dune\u00a0": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'\u3000Dune',
		'notes: "\u3000Dune": an id cannot start or end with whitespace; send "Dune"',
	],
	[
		'Cafe\u0301',
		'notes: "Cafe\u0301": an id must be Unicode NFC; send "Caf\u00e9"',
	],
])(
	'an id is never tidied: %j is refused by every verb with the reason',
	async (id, message) => {
		const {
			context,
			data: { notes },
		} = setup({ 'data/notes/Dune.md': '', 'data/notes/Caf\u00e9.md': '' });
		expect(notes.path(id)).toBe(`data/notes/${id}.md`);
		await inRun(context, async () => {
			for (const result of [
				await notes.get(id),
				await notes.add(id, { title: 'x' }),
				await notes.set(id, { title: 'x' }),
				await notes.update(id, () => Ok({ title: 'x' })),
				await notes.delete(id),
			])
				expect(expectErr(result)).toMatchObject({ name: 'Refused', message });
			expect((await folder.list('data/notes')).sort()).toEqual(
				['data/notes/Caf\u00e9.md', 'data/notes/Dune.md'].sort(),
			);
		});
		expect(idProblem(id)).toBeDefined();
	},
);

test('a Misfit carries the id of a folder record and none for a one-file key', async () => {
	const text = '---\ntitle: 123\n---\nbody';
	const { context, data } = setup({
		'data/notes/a.md': text,
		'data/settings.md': text,
	});
	await inRun(context, async () => {
		expect(expectErr(await data.notes.get('a'))).toMatchObject({
			name: 'Misfit',
			path: 'data/notes/a.md',
			id: 'a',
		});
		expect(expectErr((await data.notes.list())[0] ?? Ok(null)).id).toBe('a');
		const single = expectErr(await data['settings.md'].get());
		expect(single.path).toBe('data/settings.md');
		expect(single).not.toHaveProperty('id');
	});
});

test('ids retain internal spaces, case, NFC accents, and the byte limit', async () => {
	const {
		context,
		data: { notes },
	} = setup();
	await inRun(context, async () => {
		for (const id of ['Dune  Messiah', 'é', 'a'.repeat(200), '界'.repeat(66)]) {
			expect(idProblem(id)).toBeUndefined();
			expect(expectOk(await notes.add(id, { title: id })).id).toBe(id);
			expect(expectOk(await notes.get(id))?.id).toBe(id);
		}
		expect(expectOk(await notes.get('Dune Messiah'))).toBeUndefined();
	});
});

test('token.local is a valid id in a folder key', async () => {
	const {
		context,
		data: { notes },
	} = setup();
	expect(idProblem('token.local')).toBeUndefined();
	await inRun(context, async () => {
		expect(
			expectOk(await notes.add('token.local', { title: 'Token' })).id,
		).toBe('token.local');
		expect(expectOk(await notes.get('token.local'))?.path).toBe(
			'data/notes/token.local.md',
		);
	});
});

test.each([
	'Notes',
	'two_words',
	'two/parts',
	'notes.txt',
	'notes.local',
	'notes.local.md',
	'notes.md.local',
	'notes.local.local',
	'.local',
	'',
	'1notes',
])('definitions refuse the data key %j', (key) => {
	expect(() => defineData({ [key]: { fields: {} } })).toThrow(
		JSON.stringify(key),
	);
});
test.each(['path', 'body', 'id', 'edit'])(
	'definitions reserve the field %s',
	(key) => {
		expect(() =>
			defineData({ notes: { fields: { [key]: field.text() } } }),
		).toThrow(`"${key}"`);
	},
);

test('list reads only directly contained Markdown files with valid ids, sorted by path', async () => {
	const text = '---\ntitle: "valid"\n---\n';
	const files = [
		'z.md',
		'a.md',
		'bad.md',
		'nested/child.md',
		'picture.png',
		'.hidden.md',
		'token.local.md',
		'token.LOCAL.extra.md',
		' trailing .md',
		'e\u0301.md',
		`${'x'.repeat(201)}.md`,
	];
	const {
		context,
		data: { notes },
	} = setup(
		Object.fromEntries(
			files.map((name) => [
				`data/notes/${name}`,
				name === 'bad.md' ? '---\ntitle: 1\n---\n' : text,
			]),
		),
	);
	const opened: string[] = [];
	const folder = {
		...context.folder,
		read: async (path: string) => {
			opened.push(path);
			return context.folder.read(path);
		},
	};
	await inRun({ folder }, async () => {
		const rows = await notes.list();
		expect(rows.map((r) => r.error?.path ?? r.data?.path)).toEqual([
			'data/notes/a.md',
			'data/notes/bad.md',
			'data/notes/token.LOCAL.extra.md',
			'data/notes/token.local.md',
			'data/notes/z.md',
		]);
		for (const row of rows) {
			if (row.error) expect(expectErr(row).name).toBe('Misfit');
		}
	});
	expect(opened).toEqual([
		'data/notes/a.md',
		'data/notes/bad.md',
		'data/notes/token.LOCAL.extra.md',
		'data/notes/token.local.md',
		'data/notes/z.md',
	]);
});

test('definitions refuse readOnly fields', () => {
	expect(() =>
		defineData({
			notes: {
				fields: {
					created: Type.String({ format: 'date-time', readOnly: true }),
				},
			},
		}),
	).toThrow('"created" readOnly');
});

test('handles write refs as given without opening the referenced file', async () => {
	const data = defineData({
		watches: { fields: {} },
		checks: {
			fields: {
				watch: field.ref('watches'),
				many: field.list(field.ref('watches')),
				count: field.integer(),
			},
		},
	});
	const context = createMemoryContext();
	const folder = {
		...context.folder,
		read: async (path: string) => {
			expect(path).toStartWith('data/checks/');
			return context.folder.read(path);
		},
	};
	await inRun({ folder }, async () => {
		expect(
			expectOk(await data.checks.add('a', { watch: 'missing', count: 1 }))
				.watch,
		).toBe('missing');
		expect(
			expectOk(await data.checks.set('a', { watch: 'also-missing', count: 2 }))
				.count,
		).toBe(2);
		expect(
			expectOk(await data.checks.update('a', () => Ok({ count: 3 }))).count,
		).toBe(3);
		expect(expectOk(await data.checks.get('a'))?.watch).toBe('also-missing');
	});
});

test('data refs validate their target at runtime', () => {
	for (const target of ['missing', 'settings.md']) {
		// Dynamic schemas exercise runtime validation without bypassing the public types.
		const ref = Type.String({ 'x-epicenter-ref': { key: target } });
		expect(() =>
			defineData({
				notes: { fields: { ref } },
				'settings.md': { fields: {} },
			}),
		).toThrow(target);
	}
});

test('timeId preserves the UTC ISO stamp and adds exactly eight lowercase base36 characters', () => {
	const at = new Date('2026-11-16T09:12:04.120Z');
	const ids = Array.from({ length: 100 }, () => timeId(at));
	expect(
		ids.every((id) => /^2026-11-16T09-12-04-120Z-[a-z0-9]{8}$/.test(id)),
	).toBe(true);
	expect(new Set(ids).size).toBe(100);
	expect(
		ids.every((id) => timeId(new Date('2026-11-16T09:12:04.121Z')) > id),
	).toBe(true);
});

test('update accepts a whole record spread without storing its path or id as fields', async () => {
	const { context, data } = setup();
	await inRun(context, async () => {
		await data.notes.add('a', { title: 'first' });
		await data['settings.md'].set({ title: 'first' });
		expect(
			expectOk(
				await data.notes.update('a', (record) =>
					Ok({ ...record, title: 'second' }),
				),
			).title,
		).toBe('second');
		expect(
			expectOk(
				await data['settings.md'].update((record) =>
					Ok({ ...record, title: 'second' }),
				),
			).title,
		).toBe('second');
		const text = await folder.read('data/notes/a.md');
		expect(text).not.toContain('path:');
		expect(text).not.toContain('id:');
	});
});

test('data definitions refuse defaults', () => {
	expect(() =>
		defineData({
			notes: {
				fields: {
					nested: Type.Object({ number: Type.Number({ default: 1 }) }),
				},
			},
		}),
	).toThrow('default');
});

test('a create-only add respects a case-insensitive memory folder', async () => {
	const context = createMemoryContext();
	const notes = defineData({ notes: { fields: {} } }).notes;
	const folder: typeof context.folder = {
		...context.folder,
		read: (path) => context.folder.read(path.toLowerCase()),
		edit: (path, decide) => context.folder.edit(path.toLowerCase(), decide),
	};
	await inRun({ folder }, async () => {
		expect(expectOk(await notes.add('Dune', { body: 'first' })).body).toBe(
			'first',
		);
		expect(
			expectErr(await notes.add('dune', { body: 'second' })),
		).toMatchObject({ name: 'Changed', why: 'there' });
	});
	expect(await context.folder.read('data/notes/dune.md')).toContain('first');
});
