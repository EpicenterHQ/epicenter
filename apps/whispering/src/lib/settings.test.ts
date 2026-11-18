/**
 * `settings.md` through its service, over files in memory that another
 * program also writes.
 *
 * Key behaviors:
 * - A set of one key rewrites only that key's line: the other keys, a key
 *   Whispering does not know, and the body stay
 * - A set over a `settings.md` that does not read replaces it with the
 *   keys given
 * - A `settings.md` that does not read says why, and none of its values
 *   are used
 */
import { expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import { decode, encode, type Files } from './files/files.js';
import { memoryFiles } from './files/memory.js';
import {
	chosenIn,
	connectionsIn,
	createSettings,
	NO_SETTINGS,
	shortcutIn,
} from './settings.js';

const PATH = 'settings.md';

const textOf = async (files: Files) =>
	decode(expectOk(await files.read(PATH)) ?? new Uint8Array());

test('a set of one key keeps the other keys, a key another program wrote, and the body', async () => {
	const before = [
		'---',
		'models: {"transcribe":{"endpoint":"openai","model":"whisper-1"}}',
		'theirs: "kept"',
		'shortcut: "Alt+Space"',
		'---',
		'Notes another program keeps here.',
		'',
	].join('\n');
	const files = memoryFiles({ [PATH]: encode(before) });
	const settings = createSettings(files);

	expectOk(await settings.set({ shortcut: 'Alt+R' }));

	expect(await textOf(files)).toBe(
		before.replace('shortcut: "Alt+Space"', 'shortcut: "Alt+R"'),
	);
	const read = expectOk(await settings.get());
	expect(read.problem).toBeNull();
	expect(shortcutIn(read)).toBe('Alt+R');
	expect(expectOk(chosenIn(read, 'transcribe'))).toEqual({
		endpoint: 'openai',
		model: 'whisper-1',
	});
});

test('a set over a settings.md that does not read replaces it with the keys given', async () => {
	for (const broken of [
		// A value that does not fit.
		'---\nshortcut: 42\nconnections: "none"\n---\nold body\n',
		// Front matter that does not parse.
		'---\nnot a key value line\n---\nold body\n',
	]) {
		const files = memoryFiles({ [PATH]: encode(broken) });
		const settings = createSettings(files);

		expectOk(await settings.set({ shortcut: 'Alt+R' }));

		const text = await textOf(files);
		expect(text).not.toContain('old body');
		expect(expectOk(await settings.get())).toEqual({
			fields: { shortcut: 'Alt+R' },
			problem: null,
		});
	}
});

test('a settings.md that does not read says why, and none of its values are used', async () => {
	const files = memoryFiles({
		[PATH]: encode(
			'---\nshortcut: 42\nconnections: [{"id":"a","name":"A","baseUrl":"http://a","models":[]}]\n---\n',
		),
	});
	const read = expectOk(await createSettings(files).get());

	expect(read.problem).toContain('shortcut');
	expect(connectionsIn(read)).toEqual([]);
	expect(chosenIn(read, 'transcribe').error?.name).toBe('Invalid');

	// No file is no settings, and no problem.
	expect(expectOk(await createSettings(memoryFiles()).get())).toEqual(
		NO_SETTINGS,
	);
});
