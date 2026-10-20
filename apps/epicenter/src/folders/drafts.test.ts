/**
 * File Draft Tests
 *
 * Drives a folder editor window's drafts over a stand-in folder whose saves a
 * test holds open or refuses, as the editor and the window's lifetime drive
 * them.
 *
 * Key behaviors:
 * - Typing is held by the window, not the editor: a save sent as one file's
 *   editor goes away and fails keeps the typing and its error, and the file
 *   shows them when chosen again; Try again saves it
 * - A landed save reads the file again before its draft goes; typing that
 *   followed it stays, starting from the content it sent, with the file's
 *   own line endings
 * - Settling sends every draft and waits for every save started, refuses no
 *   input, and answers what is still held; typing after it goes on and saves
 * - The drafts are busy while typing is held or a save runs, and a failed
 *   save stays busy and failed until it saves or is discarded
 * - Discard lets typing go only when asked, and not while a save runs
 * - Field/text transitions retain their actual save bases; failed field
 *   recovery distinguishes removals from null and retries against fresh source
 * - An exclusive operation fences only its path and releases it after failure
 * - One expected-failing case records a field revert lost after switching to Files
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { describe, expect, test } from 'bun:test';
import { type FolderFiles, SaveError } from '@epicenter/folder';
import { readDocument } from '@epicenter/folder/documents';
import { Ok, type Result } from 'wellcrafted/result';

const { createFileDrafts } = await import('./drafts.svelte.ts');

type Saved = Result<void, SaveError | Error>;

/** A save that has not answered yet, and how the test answers it. */
type HeldSave = {
	path: string;
	from: unknown;
	content: unknown;
	answer: (result: Saved) => void;
};

const failed = (message: string) =>
	({ data: null, error: new Error(message) }) as unknown as Saved;

/** Files whose every save waits for the test to answer it. */
function standIn() {
	const held: HeldSave[] = [];
	const files = {
		read: async () => Ok(undefined),
		write(path: string, from: unknown, content: unknown) {
			return new Promise<Saved>((answer) =>
				held.push({ path, from, content, answer }),
			);
		},
	} as unknown as Pick<FolderFiles, 'write' | 'read'>;
	return {
		files,
		held,
		/** Answer the oldest save still waiting. */
		async answer(result: Saved) {
			await until(() => held.length > 0);
			held.shift()!.answer(result);
		},
	};
}

/** Wait until `done`, letting promises run between checks. */
async function until(done: () => boolean) {
	for (let turn = 0; turn < 50; turn++) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error('Never happened');
}

const text = { content: 'a\n', crlf: false };

describe('drafts', () => {
	test('a save that fails as the editor goes keeps the typing for the file chosen again', async () => {
		const disk = standIn();
		const reads: string[] = [];
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async (path) => void reads.push(path),
		});

		drafts.file('notes.md').type('a\nmine\n', text);
		// The editor goes away as another file is chosen.
		const sent = drafts.file('notes.md').save();
		await disk.answer(failed('disk full'));
		await sent;

		const again = drafts.file('notes.md');
		expect(again.text).toBe('a\nmine\n');
		expect(again.error?.message).toBe('disk full');
		expect(drafts.held).toEqual(['notes.md']);
		expect(drafts.failures.map((draft) => draft.path)).toEqual(['notes.md']);

		const retried = again.save();
		await disk.answer(Ok(undefined));
		await retried;
		expect(again.held).toBe(false);
		expect(reads).toEqual(['notes.md']);
	});

	test('typing that followed a landed save stays, from the content it sent', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const draft = drafts.file('notes.md');

		draft.type('one\n', { content: 'a\r\n', crlf: true });
		const sent = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]?.from).toBe('a\r\n');
		expect(disk.held[0]!.content).toBe('one\r\n');
		draft.type('one\ntwo\n', text);
		disk.held.shift()!.answer(Ok(undefined));
		await sent;

		expect(draft.text).toBe('one\ntwo\n');
		const next = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]?.from).toBe('one\r\n');
		expect(disk.held[0]!.content).toBe('one\r\ntwo\r\n');
		disk.held.shift()!.answer(Ok(undefined));
		await next;
		expect(draft.held).toBe(false);
	});

	test('discard lets typing go only when asked, and not while it saves', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const draft = drafts.file('notes.md');
		expect(draft.type('x', undefined)).toBe(false);

		draft.type('x', text);
		const sent = draft.save();
		expect(draft.discard()).toBe(false);
		await disk.answer(failed('refused'));
		await sent;
		expect(draft.discard()).toBe(true);
		expect(draft.held).toBe(false);
	});
});

describe('settling', () => {
	test('settling sends every draft and waits for its save, and typing goes on after it', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		drafts.file('a.md').type('a\nmine\n', text);
		drafts.file('b.md').type('a\ntheirs\n', text);
		expect(drafts.busy).toBe(true);

		// The window is hidden: what is typed is sent at once.
		let settled = false;
		const settling = drafts.settle().then((held) => {
			settled = true;
			return held;
		});
		await until(() => disk.held.length === 2);
		expect(settled).toBe(false);
		disk.held.shift()!.answer(Ok(undefined));
		disk.held.shift()!.answer(Ok(undefined));
		expect(await settling).toEqual([]);
		expect(drafts.busy).toBe(false);

		// Shown again, the person keeps typing, and it saves as before.
		const draft = drafts.file('a.md');
		expect(
			draft.type('a\nmine\nmore\n', { content: 'a\nmine\n', crlf: false }),
		).toBe(true);
		const sent = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]!.content).toBe('a\nmine\nmore\n');
		disk.held.shift()!.answer(Ok(undefined));
		await sent;
		expect(drafts.held).toEqual([]);
	});

	test('a failed save survives settling with its text, busy and failed, and input stays open', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		drafts.file('a.md').type('a\nmine\n', text);

		const settling = drafts.settle();
		await disk.answer(failed('disk full'));
		const held = await settling;
		expect(
			held.map((draft) => [draft.path, draft.text, draft.error?.message]),
		).toEqual([['a.md', 'a\nmine\n', 'disk full']]);
		expect(drafts.busy).toBe(true);
		expect(drafts.failures.map((draft) => draft.path)).toEqual(['a.md']);

		// Settling again tries again; still refused, it answers the same.
		const again = drafts.settle();
		await disk.answer(failed('disk full'));
		expect((await again).map((draft) => draft.path)).toEqual(['a.md']);
		expect(drafts.file('a.md').type('a\nmine\nfixed\n', undefined)).toBe(true);
		expect(drafts.file('a.md').text).toBe('a\nmine\nfixed\n');
	});

	test('a save already running is waited for, and typing during it is answered as held', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const draft = drafts.file('a.md');
		draft.type('a\none\n', text);
		void draft.save();
		await until(() => disk.held.length === 1);
		expect(drafts.busy).toBe(true);

		const settling = drafts.settle();
		draft.type('a\none\ntwo\n', text);
		disk.held.shift()!.answer(Ok(undefined));
		// The typing that arrived meanwhile is sent in the same round.
		await disk.answer(Ok(undefined));
		expect(await settling).toEqual([]);
		expect(drafts.busy).toBe(false);
	});
});

test.each([false, true])(
	'field changes during a text save retain typed body and the correct next base (first save refused: %s)',
	async (refused) => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const draft = drafts.file('nested/a.md');
		const before = '---\ntitle: before\nobsolete: old\n---\noriginal body\n';
		const typed = before.replace('original body', 'body typed in Files');
		const base = { content: before, crlf: false };
		draft.type(typed, base);
		const first = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]?.from).toBe(before);
		expect(
			draft.change({ title: 'changed in grid', obsolete: undefined }, base),
		).toBe(true);
		await disk.answer(refused ? failed('disk full') : Ok(undefined));
		await first;
		expect(draft.text).toContain('body typed in Files');
		expect(draft.text).toContain('title: changed in grid');
		expect(draft.text).not.toContain('obsolete:');

		const next = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]?.from).toBe(refused ? before : typed);
		expect(disk.held[0]?.content).toBe(draft.text);
		await disk.answer(Ok(undefined));
		await next;
		expect(draft.held).toBe(false);
	},
);

// Field and text views share one path entry and one save queue.
test('pending fields overlay fresh body edits and failed fields do not replay during view settlement', async () => {
	let stored = '---\ntitle: before\n---\nbody before\n';
	const writes: { from: unknown; content: unknown }[] = [];
	let refuses = true;
	const drafts = createFileDrafts({
		files: {
			read: async (path) => Ok({ path, content: new Blob([stored]) }),
			write: async (_path, from, content) => {
				writes.push({ from, content });
				if (refuses) return failed('disk full') as Result<void, SaveError>;
				stored = String(content);
				return Ok(undefined);
			},
		},
		saved: async () => {},
	});
	const draft = drafts.file('a.md');
	const base = () => ({ content: stored, crlf: false });
	expect(draft.change({ title: 'mine' }, base())).toBe(true);
	stored = '---\ntitle: before\nother: remote\n---\nbody remote\n';
	expect(draft.shown(base())).toContain('body remote');
	expect(draft.shown(base())).toContain('title: mine');
	const pending = draft.save();
	const hidden = drafts.settle();
	await pending;
	await hidden;
	expect(writes[0]?.content).toContain('other: remote');
	expect(writes[0]?.content).toContain('body remote');
	expect(draft.sourceLocked).toBe(true);
	expect(draft.type('repair', base())).toBe(false);
	await drafts.settle();
	await draft.save();
	expect(writes).toHaveLength(1);
	refuses = false;
	await draft.retry();
	expect(draft.held).toBe(false);
	expect(stored).toContain('title: mine');
});

test('switching from fields to text keeps the latest body and one draft, while malformed source preserves field intent', async () => {
	let stored = '---\ntitle: before\n---\nbody\n';
	const drafts = createFileDrafts({
		files: {
			read: async (path) => Ok({ path, content: new Blob([stored]) }),
			write: async (_path, _from, content) => {
				stored = String(content);
				return Ok(undefined);
			},
		},
		saved: async () => {},
	});
	const draft = drafts.file('a.md');
	const base = () => ({ content: stored, crlf: false });
	draft.change({ title: 'mine' }, base());
	stored = '---\ntitle: before\n---\nnew body\n';
	expect(draft.type(draft.shown(base())! + 'typed\n', base())).toBe(true);
	await draft.save();
	expect(stored).toContain('title: mine');
	expect(stored).toContain('new body\ntyped\n');
	draft.change({ title: 'second' }, base());
	stored = '---\ntitle: [\n---\nbroken\n';
	expect(draft.type('repair', base())).toBe(false);
	expect(draft.sourceLocked).toBe(true);
	expect(draft.fieldText).toContain('second');
	expect(draft.text).toBeUndefined();
	expect(draft.shown(base())).toBeUndefined();
	expect((await drafts.settle())[0]?.text).not.toContain('body');
	expect(draft.discard()).toBe(true);
});

// A successful field save must acknowledge its own fields in the text base.
// Remove the expected-failure marker when that provenance rule is implemented.
for (const { revert, refuseFirst } of [
	{ revert: false, refuseFirst: false },
	{ revert: true, refuseFirst: false },
	{ revert: false, refuseFirst: true },
]) {
	test.failingIf(revert)(
		revert
			? 'reverting a field in Files survives its earlier field save (known failure)'
			: `field-to-text preserves external body (refused first write: ${refuseFirst})`,
		async () => {
			const { mkdtemp, writeFile, readFile, rm } = await import(
				'node:fs/promises'
			);
			const { tmpdir } = await import('node:os');
			const { join } = await import('node:path');
			const { openFolder } = await import('@epicenter/folder/bun');
			const { expectOk } = await import('wellcrafted/testing');
			const directory = await mkdtemp(
				join(tmpdir(), 'epicenter-draft-transition-'),
			);
			const before = '---\ntitle: before\n---\nbody before\n';
			await writeFile(join(directory, 'a.md'), before);
			const folder = expectOk(await openFolder({ directory, tables: {} }));
			let release: (() => void) | undefined;
			const bases: unknown[] = [];
			const drafts = createFileDrafts({
				files: {
					read: folder.files.read,
					async write(path, from, content) {
						bases.push(from);
						if (bases.length === 1) {
							await new Promise<void>((resolve) => {
								release = resolve;
							});
							if (refuseFirst)
								return SaveError.StorageFailed({
									cause: new Error('disk full'),
								});
						}
						return folder.files.write(path, from, content);
					},
				},
				saved: async () => {},
			});
			try {
				const draft = drafts.file('a.md');
				const base = { content: before, crlf: false };
				draft.change({ title: 'mine' }, base);
				await writeFile(
					join(directory, 'a.md'),
					'---\ntitle: before\n---\nbody from another writer\n',
				);
				const fieldSave = draft.save();
				await until(() => release !== undefined);
				draft.type(draft.shown(base)! + 'my appended line\n', base);
				release!();
				await fieldSave;
				expect(draft.error).toBeUndefined();
				if (revert) {
					const held = draft.text;
					if (held === undefined) throw new Error('The source edit was lost');
					expect(
						draft.type(held.replace('title: mine', 'title: before'), base),
					).toBe(true);
				}
				await draft.save();
				if (refuseFirst) expect(bases[1]).toBe(before);
				const stored = await readFile(join(directory, 'a.md'), 'utf8');
				expect(stored).toContain(revert ? 'title: before' : 'title: mine');
				expect(stored).toContain('body from another writer');
				expect(stored).toContain('my appended line');
			} finally {
				await drafts.settle();
				await folder.close();
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
}

describe('exclusive section writes', () => {
	test('fences input synchronously, drains source first, and close waits without a blur deadlock', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const source = drafts.file('epicenter.json');
		source.type('{"title":"mine"}', text);
		let finish!: () => void;
		let changed = false;
		const operation = source.exclusive(async () => {
			changed = true;
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
		});
		expect(source.exclusivePending).toBe(true);
		expect(source.type('untracked typing', text)).toBe(false);
		expect(source.discard()).toBe(false);
		await source.save(); // Blur does not wait for its own exclusive drain.
		expect(changed).toBe(false);
		await disk.answer(Ok(undefined));
		await until(() => changed);
		let settled = false;
		const closing = drafts.settle().then(() => {
			settled = true;
		});
		await Bun.sleep(0);
		expect(settled).toBe(false);
		await expect(source.exclusive(async () => {})).rejects.toThrow(
			'still saving',
		);
		finish();
		await operation;
		await closing;
		expect(source.exclusivePending).toBe(false);
		expect(drafts.busy).toBe(false);
	});

	test('failed source stays visible and refuses the section write', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const source = drafts.file('epicenter.json');
		source.type('my source', text);
		let changed = false;
		const operation = source.exclusive(async () => {
			changed = true;
		});
		await disk.answer(failed('disk full'));
		await expect(operation).rejects.toThrow('unfinished source');
		expect(changed).toBe(false);
		expect(source.text).toBe('my source');
		expect(source.exclusivePending).toBe(false);
		source.discard();
	});

	test('a failed section write releases its path while another file can save independently', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const source = drafts.file('epicenter.json');
		const other = drafts.file('notes/a.md');
		const gate = Promise.withResolvers<void>();
		const operation = source.exclusive(async () => {
			await gate.promise;
			throw new Error('The view changed in another window');
		});
		expect(source.type('blocked', text)).toBe(false);
		expect(other.type('independent edit', text)).toBe(true);
		const saving = other.save();
		await disk.answer(Ok(undefined));
		await saving;
		expect(other.held).toBe(false);
		expect(source.exclusivePending).toBe(true);

		let settled = false;
		const settling = drafts.settle().then(() => {
			settled = true;
		});
		await Bun.sleep(0);
		expect(settled).toBe(false);
		gate.resolve();
		await expect(operation).rejects.toThrow('another window');
		await settling;
		expect(source.exclusivePending).toBe(false);
		expect(source.type('repair after refusal', text)).toBe(true);
		expect(source.discard()).toBe(true);
		expect(drafts.busy).toBe(false);
	});
});

test('failed schema-free patches retain removal and null intent, then retry against fresh source', async () => {
	const path = 'nested/tasks/a.md';
	let stored = '\uFEFF---\r\nobsolete: old\r\nunknown: keep\r\n---\r\nbody\r\n';
	let refuses = true;
	let writes = 0;
	const drafts = createFileDrafts({
		files: {
			read: async () => Ok({ path, content: new Blob([stored]) }),
			write: async (_path, _from, content) => {
				writes++;
				if (refuses) return failed('disk full') as Result<void, SaveError>;
				stored =
					typeof content === 'string'
						? content
						: new TextDecoder('utf-8', { ignoreBOM: true }).decode(content);
				return Ok(undefined);
			},
		},
		saved: async () => {},
	});
	const draft = drafts.file(path);
	expect(
		draft.change(
			{ obsolete: undefined, destination: null },
			{ content: stored, crlf: true },
		),
	).toBe(true);
	await draft.save();
	const [held] = await drafts.settle();
	if (held === undefined) throw new Error('The failed field patch was lost');
	expect(JSON.parse(held.text)).toEqual({
		set: { destination: null },
		remove: ['obsolete'],
	});
	expect(draft.sourceLocked).toBe(true);
	expect(writes).toBe(1);

	stored =
		'\uFEFF---\r\nobsolete: changed externally\r\nunknown: keep\r\nremote: added\r\n---\r\nbody from another writer\r\n';
	refuses = false;
	await draft.retry();
	const document = readDocument(path, new TextEncoder().encode(stored));
	expect(document.fields).toEqual({
		unknown: 'keep',
		remote: 'added',
		destination: null,
	});
	expect(document.body).toContain('body from another writer');
	expect(stored.startsWith('\uFEFF')).toBe(true);
	expect(stored.replaceAll('\r\n', '')).not.toContain('\n');
	expect(draft.held).toBe(false);
});
