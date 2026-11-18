/**
 * The folder as the page's `QueryClient` observes it, over files in memory
 * that another program may also write.
 *
 * Key behaviors:
 * - An outside edit shows when the window regains focus
 * - A write is refused when the file changed since it was shown: nothing is
 *   written, and the newer text shows once the write settles
 * - Writes to one kind run one at a time, in the order made; another kind's
 *   writes do not wait for them
 * - A read that a write overtakes never shows older data than the write
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
const note = (title: string) =>
	`---\ntitle: "${title}"\nrecordedAt: "2026-11-01T09:00:00.000Z"\n---\n`;

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

test('a write over a note that changed since it was shown writes nothing, and the newer text shows', async () => {
	const files = memoryFiles({ [PATH]: encode(note('Standup')) });
	const page = await open(files);
	const shown = page.query.snapshot()?.recordings.texts[ID] ?? null;
	expectOk(await files.write(PATH, encode(note('Edited elsewhere'))));

	const { error } = await runMutation(
		page.query.queryClient,
		page.query.noteMutations.recordings.set,
		{ id: ID, seen: shown, changes: { title: 'Mine' } },
	);

	expect(error?.name).toBe('Changed');
	const now = expectOk(await files.read(PATH));
	expect(new TextDecoder().decode(now ?? new Uint8Array())).toBe(
		note('Edited elsewhere'),
	);
	// The write stayed pending until the folder on screen was read again.
	expect(titleOf(page, ID)).toBe('Edited elsewhere');
});

test('writes to one kind run one at a time in the order made, and another kind does not wait', async () => {
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
	const { queryClient, noteMutations, snapshot } = page.query;
	const seen = (id: string) => snapshot()?.recordings.texts[id] ?? null;
	events.length = 0;

	const first = runMutation(queryClient, noteMutations.recordings.set, {
		id: ID,
		seen: seen(ID),
		changes: { title: 'First' },
	});
	const second = runMutation(queryClient, noteMutations.recordings.set, {
		id: OTHER,
		seen: seen(OTHER),
		changes: { title: 'Second' },
	});
	const transcript = runMutation(
		queryClient,
		noteMutations.transcriptions.set,
		{
			id: 'tx1',
			seen: null,
			changes: {
				recordingId: ID,
				createdAt: '2026-11-01T09:01:00.000Z',
				model: 'whisper-1',
				endpoint: 'stub',
				body: 'a steady tone\n',
			},
		},
	);
	expectOk(await transcript);

	// The first write is held; the second has not even read its note.
	expect(events).toContain(`write ${PATH}`);
	expect(events).not.toContain(`read recordings/${OTHER}.md`);
	expect(events).toContain('write transcriptions/tx1.md');

	held.open();
	expectOk(await first);
	expectOk(await second);
	const order = events.filter((event) => event.startsWith('write recordings/'));
	expect(order).toEqual([`write ${PATH}`, `write recordings/${OTHER}.md`]);
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
	const { queryClient, noteMutations, snapshot } = page.query;
	const shown = snapshot()?.recordings.texts[ID] ?? null;

	// A read starts, takes the old note, and is held there.
	const late = gate();
	hold = late;
	void page.query.reread();
	await reading.opened;

	expectOk(
		await runMutation(queryClient, noteMutations.recordings.set, {
			id: ID,
			seen: shown,
			changes: { title: 'Renamed' },
		}),
	);
	expect(titleOf(page, ID)).toBe('Renamed');

	// The overtaken read answers now, with the old note; it is not shown.
	late.open();
	await Bun.sleep(10);
	expect(titleOf(page, ID)).toBe('Renamed');
});
