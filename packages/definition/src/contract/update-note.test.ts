/**
 * `updateNote`: the one rule for an edit that meets a `Conflict`.
 *
 * Key behaviors:
 * - Nothing moved: one update, over the version the writer read
 * - Another writer changed other fields (or the body): the edit is applied
 *   again over what is there now, and both changes stay
 * - Another writer changed a field the edit changes: the `Conflict`, and
 *   nothing is written over their value
 * - The other writer already made the same change: what is there, unwritten
 * - Deleted elsewhere: a `Conflict` whose `current` is null
 * - Writes that keep racing stop after a bounded number of tries
 */
import { expect, test } from 'bun:test';
import { Ok } from 'wellcrafted/result';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { ClientError, type NoteClient, type Version } from './client.js';
import { defineContract } from './contract.js';
import { updateNote } from './update-note.js';

const todos = defineContract({
	name: 'todos',
	collections: {
		todos: {
			path: 'todos/{id}.md',
			fields: {
				title: { type: 'string' },
				done: { type: 'boolean' },
				tags: { type: 'array', items: { type: 'string' } },
			},
			required: ['title', 'done'],
		},
	},
});
type Todos = (typeof todos)['collections']['todos'];
type Note = { title: string; done: boolean; tags?: string[]; body: string };

/** One note in memory, with a version that moves on every write. */
function memoryNotes(initial: Note | null) {
	let note = initial;
	let version = 1;
	let updates = 0;
	const path = 'todos/a.md';
	const current = () => (note === null ? null : (`v${version}` as Version));
	/** The note as read; only called while there is one. */
	const read = () => {
		if (note === null) throw new Error('the note was deleted');
		return { id: 'a', ...note, version: `v${version}` as Version };
	};
	const notes = {
		async get() {
			if (note === null) return ClientError.NotFound({ path });
			return Ok(read());
		},
		async update(
			_args: { id: string },
			patch: Partial<Note>,
			{ over }: { over: Version },
		) {
			updates++;
			if (note === null || over !== current())
				return ClientError.Conflict({ path, current: current() });
			note = { ...note, ...patch };
			version++;
			return Ok(read());
		},
	} as unknown as Pick<NoteClient<Todos>, 'get' | 'update'>;
	return {
		notes,
		/** Another writer's change, landing between the read and the write. */
		elsewhere(change: Partial<Note> | null) {
			note = change === null || note === null ? null : { ...note, ...change };
			version++;
		},
		get note() {
			return note;
		},
		get updates() {
			return updates;
		},
		read,
	};
}

const start: Note = { title: 'Milk', done: false, body: 'Two litres.\n' };

test('nothing moved: the edit lands in one update', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	const landed = expectOk(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ title: 'Oat milk' },
			{ base },
		),
	);
	expect(landed.title).toBe('Oat milk');
	expect(memory.updates).toBe(1);
});

test('another writer changed another field: the edit lands over theirs, and both stay', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	memory.elsewhere({ done: true, body: 'Three litres.\n' });
	const landed = expectOk(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ title: 'Oat milk' },
			{ base },
		),
	);
	expect(memory.note).toEqual({
		title: 'Oat milk',
		done: true,
		body: 'Three litres.\n',
	});
	expect(landed.version).not.toBe(base.version);
});

test('another writer changed the same field: a Conflict, and their value stays', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	memory.elsewhere({ title: 'Soy milk' });
	const error = expectErr(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ title: 'Oat milk' },
			{ base },
		),
	);
	expect(error.name).toBe('Conflict');
	expect(error.name === 'Conflict' && error.current).toBe(
		memory.read().version,
	);
	expect(memory.note?.title).toBe('Soy milk');
});

test('the body is one field: both editing it is a Conflict, one each is kept', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	memory.elsewhere({ body: 'Theirs.\n' });
	expect(
		expectErr(
			await updateNote(
				memory.notes,
				{ id: 'a' },
				{ body: 'Mine.\n' },
				{ base },
			),
		).name,
	).toBe('Conflict');
	expectOk(
		await updateNote(memory.notes, { id: 'a' }, { done: true }, { base }),
	);
	expect(memory.note).toEqual({ title: 'Milk', done: true, body: 'Theirs.\n' });
});

test('a patch is judged field by field: one clash refuses the whole edit', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	memory.elsewhere({ title: 'Soy milk' });
	expectErr(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ title: 'Oat milk', done: true },
			{ base },
		),
	);
	expect(memory.note).toEqual({ ...start, title: 'Soy milk' });
});

test('the other writer already made the same change: what is there, with no write', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	memory.elsewhere({ title: 'Oat milk', tags: ['dairy-free'] });
	const updates = memory.updates;
	const landed = expectOk(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ title: 'Oat milk' },
			{ base },
		),
	);
	expect(landed).toEqual(memory.read());
	expect(memory.updates).toBe(updates + 1);
});

test('values compare as values: an equal array is the same field', async () => {
	const memory = memoryNotes({ ...start, tags: ['a', 'b'] });
	const base = memory.read();
	memory.elsewhere({ done: true });
	expectOk(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ tags: ['a', 'b', 'c'] },
			{ base: { ...base, tags: ['a', 'b'] } },
		),
	);
	expect(memory.note?.tags).toEqual(['a', 'b', 'c']);
	expect(memory.note?.done).toBe(true);
});

test('a field the writer saw absent, still absent, is not a clash', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	memory.elsewhere({ title: 'Milk!' });
	expectOk(
		await updateNote(memory.notes, { id: 'a' }, { tags: ['x'] }, { base }),
	);
	expect(memory.note).toEqual({ ...start, title: 'Milk!', tags: ['x'] });
});

test('deleted elsewhere: a Conflict whose current is null', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	memory.elsewhere(null);
	const error = expectErr(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ title: 'Oat milk' },
			{ base },
		),
	);
	expect(error).toMatchObject({ name: 'Conflict', current: null });
});

test('writes that keep racing stop after a bounded number of tries', async () => {
	const memory = memoryNotes(start);
	const base = memory.read();
	const update = memory.notes.update;
	memory.notes.update = (args, patch, options) => {
		memory.elsewhere({ done: !memory.note?.done });
		return update(args, patch, options);
	};
	const error = expectErr(
		await updateNote(
			memory.notes,
			{ id: 'a' },
			{ title: 'Oat milk' },
			{ base },
		),
	);
	expect(error.name).toBe('Conflict');
	expect(memory.updates).toBeLessThanOrEqual(5);
	expect(memory.note?.title).toBe('Milk');
});
