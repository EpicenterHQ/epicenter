/**
 * The folder as the page's `QueryClient` observes it, over files in memory
 * that another program may also write.
 *
 * Key behaviors:
 * - An outside edit shows when the window regains focus
 * - A field change is written over the file as it is now, keeping what
 *   another program wrote, and settles once the folder on screen shows it
 * - A body typed over a body changed on disk writes nothing, and the newer
 *   text shows once the write settles
 * - The folder's writes run one at a time, in the order made
 * - A read that a write overtakes never shows older data than the write
 * - The connections and the shortcut hear a change to `settings.md` once
 *   it is set, and read the new values
 */
import { afterEach, expect, test } from 'bun:test';
import { focusManager } from '@tanstack/query-core';
import { runMutation } from 'wellcrafted/query';
import { expectOk } from 'wellcrafted/testing';
import { encode, type Files } from './files/files.js';
import { memoryFiles } from './files/memory.js';
import { openPage } from './services.test-support.js';

const ID = '2026-11-01T09-00-00-000Z-standup1';
const OTHER = '2026-11-02T09-00-00-000Z-standup2';
const PATH = `recordings/${ID}.md`;
const note = (title: string, body = '') =>
	`---\ntitle: "${title}"\nrecordedAt: "2026-11-01T09:00:00.000Z"\n---\n${body}`;
const text = async (files: Files, path: string) =>
	new TextDecoder().decode(
		expectOk(await files.read(path)) ?? new Uint8Array(),
	);

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

async function open(files: Files) {
	const page = await openPage(files);
	cleanups.push(page.close);
	return page;
}

const titleOf = (
	page: Awaited<ReturnType<typeof open>>,
	id: string,
): string | undefined =>
	page.query.snapshot()?.recordings.items.find((item) => item.id === id)?.title;

async function until(check: () => boolean) {
	for (let turn = 0; turn < 300 && !check(); turn++) await Bun.sleep(2);
	expect(check()).toBe(true);
}

/** A promise and the function that settles it. */
function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

test('an outside edit shows when the window regains focus', async () => {
	const files = memoryFiles({ [PATH]: encode(note('Standup')) });
	const page = await open(files);
	page.query.queryClient.mount();
	cleanups.push(() => {
		page.query.queryClient.unmount();
		focusManager.setFocused(undefined);
	});
	focusManager.setFocused(false);
	expect(titleOf(page, ID)).toBe('Standup');

	expectOk(await files.write(PATH, encode(note('Edited elsewhere'))));
	expect(titleOf(page, ID)).toBe('Standup');

	focusManager.setFocused(true);
	await until(() => titleOf(page, ID) === 'Edited elsewhere');
});

test('a field change over a note changed on disk keeps what the other program wrote', async () => {
	const files = memoryFiles({ [PATH]: encode(note('Standup')) });
	const page = await open(files);
	expectOk(await files.write(PATH, encode(note('Standup', 'their notes\n'))));

	expectOk(
		await runMutation(page.query.queryClient, page.query.noteMutations.set, {
			collection: 'recordings',
			id: ID,
			fields: { title: 'Mine' },
		}),
	);

	expect(await text(files, PATH)).toBe(note('Mine', 'their notes\n'));
	// The write stayed pending until the folder on screen was read again.
	expect(titleOf(page, ID)).toBe('Mine');
	expect(
		page.query.snapshot()?.recordings.items.find((item) => item.id === ID)
			?.body,
	).toBe('their notes\n');
});

test('a body typed over a body changed on disk writes nothing, and the newer text shows', async () => {
	const files = memoryFiles({ [PATH]: encode(note('Standup', 'notes\n')) });
	const page = await open(files);
	expectOk(await files.write(PATH, encode(note('Standup', 'their notes\n'))));

	const { error } = await runMutation(
		page.query.queryClient,
		page.query.noteMutations.set,
		{
			collection: 'recordings',
			id: ID,
			body: { seen: 'notes\n', text: 'my notes\n' },
		},
	);

	expect(error?.name).toBe('Changed');
	expect(await text(files, PATH)).toBe(note('Standup', 'their notes\n'));
	expect(
		page.query.snapshot()?.recordings.items.find((item) => item.id === ID)
			?.body,
	).toBe('their notes\n');
});

test('the folder’s writes run one at a time, in the order made', async () => {
	const inner = memoryFiles({
		[PATH]: encode(note('Standup')),
		[`recordings/${OTHER}.md`]: encode(note('Retro')),
	});
	const events: string[] = [];
	const held = gate();
	const files: Files = {
		...inner,
		async read(path) {
			events.push(`read ${path}`);
			return inner.read(path);
		},
		async write(path, bytes) {
			events.push(`write ${path}`);
			if (path === PATH) await held.opened;
			return inner.write(path, bytes);
		},
	};
	const page = await open(files);
	const { queryClient, noteMutations } = page.query;
	events.length = 0;

	const first = runMutation(queryClient, noteMutations.set, {
		collection: 'recordings',
		id: ID,
		fields: { title: 'First' },
	});
	const second = runMutation(queryClient, noteMutations.set, {
		collection: 'recordings',
		id: OTHER,
		fields: { title: 'Second' },
	});
	const transcript = runMutation(queryClient, noteMutations.set, {
		collection: 'transcriptions',
		id: 'tx1',
		fields: {
			recordingId: ID,
			createdAt: '2026-11-01T09:01:00.000Z',
			model: 'whisper-1',
			endpoint: 'stub',
		},
		body: { seen: null, text: 'a steady tone\n' },
	});

	// The first write is held; the others have not even read their notes.
	await until(() => events.includes(`write ${PATH}`));
	await Bun.sleep(10);
	expect(events).not.toContain(`read recordings/${OTHER}.md`);
	expect(events).not.toContain('read transcriptions/tx1.md');

	held.open();
	expectOk(await first);
	expectOk(await second);
	expectOk(await transcript);
	expect(events.filter((event) => event.startsWith('write '))).toEqual([
		`write ${PATH}`,
		`write recordings/${OTHER}.md`,
		'write transcriptions/tx1.md',
	]);
	expect(titleOf(page, ID)).toBe('First');
	expect(titleOf(page, OTHER)).toBe('Second');
});

test('a read that a finished write overtakes never shows older data than the write', async () => {
	const inner = memoryFiles({ [PATH]: encode(note('Standup')) });
	let hold: ReturnType<typeof gate> | null = null;
	const reading = gate();
	const files: Files = {
		...inner,
		async readMany(paths) {
			const read = await inner.readMany(paths);
			const held = hold;
			if (held !== null && paths.includes(PATH)) {
				hold = null;
				reading.open();
				await held.opened;
			}
			return read;
		},
	};
	const page = await open(files);
	const { queryClient, noteMutations } = page.query;

	// A read starts, takes the old note, and is held there.
	const late = gate();
	hold = late;
	void page.query.reread();
	await reading.opened;

	expectOk(
		await runMutation(queryClient, noteMutations.set, {
			collection: 'recordings',
			id: ID,
			fields: { title: 'Renamed' },
		}),
	);
	expect(titleOf(page, ID)).toBe('Renamed');

	// The overtaken read answers now, with the old note; it is not shown.
	late.open();
	await Bun.sleep(10);
	expect(titleOf(page, ID)).toBe('Renamed');
});

test('the connections and the shortcut hear a set of settings.md, and read the new values', async () => {
	const page = await open(
		memoryFiles({ 'settings.md': encode('---\nshortcut: "Alt+Space"\n---\n') }),
	);
	const { connections, shortcut } = page.query.settings;
	let heard = { connections: 0, shortcut: 0 };
	cleanups.push(
		connections.subscribe(() => heard.connections++),
		shortcut.subscribe(() => heard.shortcut++),
	);
	expect(shortcut.get()).toBe('Alt+Space');
	expect(connections.list()).toEqual([]);

	expectOk(await shortcut.set('Alt+R'));
	expect(heard).toEqual({ connections: 1, shortcut: 1 });
	expect(shortcut.get()).toBe('Alt+R');

	const openai = {
		id: 'openai',
		name: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		models: ['whisper-1'],
	};
	await connections.save([openai]);
	expect(heard).toEqual({ connections: 2, shortcut: 2 });
	expect(connections.list()).toEqual([openai]);
	expect(shortcut.get()).toBe('Alt+R');

	// A set that changes nothing they read is heard by neither.
	heard = { connections: 0, shortcut: 0 };
	await page.query.reread();
	await Bun.sleep(10);
	expect(heard).toEqual({ connections: 0, shortcut: 0 });
});
