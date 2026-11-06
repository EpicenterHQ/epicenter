/**
 * Native watch uncertainty invalidates all held/read sources without reading
 * files. Null Linux filenames and watcher errors must not silently lose scope
 * (`'all'`), a hidden path (`isHiddenPath`) never reports a change, and a
 * watcher answers once it is live, so a change made after it answers is
 * heard.
 */
import { afterAll, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let event: (kind: string, filename: string | null) => void;
let failure: () => void;
let closed = 0;
const base = fs.mkdtempSync(join(tmpdir(), 'epicenter-watch-'));
const root = join(base, 'folder');
fs.mkdirSync(root);
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
// A module mock outlives this file when tests share a process, so any other
// directory is watched for real.
const { watch } = fs;
mock.module('node:fs', () => ({
	...fs,
	watch: (
		at: string,
		options: fs.WatchOptionsWithStringEncoding,
		listener: typeof event,
	): unknown => {
		if (!at.startsWith(base))
			return watch(at, options, listener as fs.WatchListener<string>);
		expect(options).toMatchObject({ recursive: true, persistent: false });
		event = listener;
		return {
			on: (_name: string, listener: typeof failure) => {
				failure = listener;
			},
			close: () => {
				closed++;
			},
		};
	},
}));
const { watchDirectory } = await import('./watch.js');
const { isSaveName } = await import('../state.js');

/** The probes a watcher of `at` has staged so far: staged saves' names at its root. */
const probes = (at: string) =>
	fs.readdirSync(at).filter((name) => isSaveName(name));

async function until(check: () => boolean) {
	for (let turn = 0; turn < 200 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

/** A watcher of `root` heard live: its probe written and heard; answers its stop. */
async function live(hints: unknown[]) {
	const watching = watchDirectory(root, (paths) => hints.push(paths));
	await until(() => probes(root).length === 1);
	event('rename', probes(root)[0] ?? '');
	return watching;
}

test('absent filenames and errors reconcile all, while closed callbacks are ignored', async () => {
	const hints: unknown[] = [];
	const stop = await live(hints);
	event('rename', null);
	event('change', '');
	failure();
	event('change', join(root, '..', 'outside.md'));
	event('change', join('notes', 'a.md'));
	event('rename', 'notes');
	event('change', join('.git', 'index'));
	expect(hints).toEqual(['all', 'all', 'all', 'all', ['notes/a.md'], ['notes']]);
	stop();
	event('change', 'late.md');
	failure();
	expect(hints).toHaveLength(6);
	expect(closed).toBe(1);
});

test('a hidden path never reports a change', async () => {
	const hints: unknown[] = [];
	const stop = await live(hints);
	// A staged save and a recording in progress sit beside their targets
	// under reserved hidden names, so a save does not echo as a change, and
	// a recording's growth wakes nothing.
	event('rename', '.epicenter');
	event('change', join('recordings', '.ep-k3j9x2ab-a.recording'));
	event('rename', join('notes', '.ep-0123456789abcdef.save'));
	// Anything hidden, at any depth, is not the folder's data either.
	event('change', join('notes', '.epicenter'));
	event('change', join('notes', '.obsidian', 'workspace.json'));
	event('change', '.DS_Store');
	event('change', join('notes', 'a.md'));
	expect(hints).toEqual([['notes/a.md']]);
	stop();
});

test('a watcher writes a probe until it hears one, and answers then', async () => {
	const hints: unknown[] = [];
	let answered = false;
	const watching = watchDirectory(root, (paths) => hints.push(paths)).then(
		(stop) => {
			answered = true;
			return stop;
		},
	);
	await until(() => probes(root).length === 1);
	const [probe = ''] = probes(root);
	// Not live yet: it has not answered, and what it hears is reported as ever.
	event('change', join('notes', 'a.md'));
	expect(answered).toBe(false);
	expect(hints).toEqual([['notes/a.md']]);

	event('rename', probe);
	const stop = await watching;
	// Live: the probe is a hidden path like any other, and is removed.
	event('change', probe);
	expect(hints).toEqual([['notes/a.md']]);
	await until(() => probes(root).length === 0);
	stop();
});

test('a folder that takes no probe answers at once, saying anything may have changed', async () => {
	// A folder gone from under its watch takes no probe.
	const unwritable = join(base, 'gone');
	const hints: unknown[] = [];
	const stop = await watchDirectory(unwritable, (paths) => hints.push(paths));
	expect(hints).toEqual(['all']);
	stop();
});
