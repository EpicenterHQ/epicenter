/**
 * Native watch uncertainty invalidates all held/read sources without reading
 * files. Null Linux filenames and watcher errors must not silently lose scope,
 * a hidden path (`isHiddenPath`) never reports a change, and a watcher says
 * once when it is live, so a change made while it started is read.
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

test('absent filenames and errors reconcile all, while closed callbacks are ignored', () => {
	const hints: unknown[] = [];
	const stop = watchDirectory(root)((paths) => hints.push(paths));
	event('rename', null);
	event('change', '');
	failure();
	event('change', join(root, '..', 'outside.md'));
	event('change', join('notes', 'a.md'));
	event('rename', 'notes');
	event('change', join('.git', 'index'));
	expect(hints).toEqual([null, null, null, null, ['notes/a.md'], ['notes']]);
	stop();
	event('change', 'late.md');
	failure();
	expect(hints).toHaveLength(6);
	expect(closed).toBe(1);
});

test('a hidden path never reports a change', () => {
	const hints: unknown[] = [];
	const stop = watchDirectory(root)((paths) => hints.push(paths));
	// Unfinished writes live in `.epicenter`, so a save does not echo as a
	// change, and a recording's header rewrite wakes nothing.
	event('rename', '.epicenter');
	event('change', join('.epicenter', 'recordings', 'recordings', 'a.wav'));
	event('rename', join('.epicenter', 'saves', 'staged'));
	// Anything hidden, at any depth, is not the folder's data either.
	event('change', join('notes', '.epicenter'));
	event('change', join('notes', '.obsidian', 'workspace.json'));
	event('change', '.DS_Store');
	event('change', join('notes', 'a.md'));
	expect(hints).toEqual([['notes/a.md']]);
	stop();
});

/** The probes a watcher of `at` has staged so far, by their paths below it. */
const probes = (at: string) =>
	fs
		.readdirSync(join(at, '.epicenter', 'saves'), { withFileTypes: true })
		.map((entry) => `.epicenter/saves/${entry.name}`);

async function until(check: () => boolean) {
	for (let turn = 0; turn < 200 && !check(); turn++) await Bun.sleep(5);
	expect(check()).toBe(true);
}

test('a watcher writes a probe until it hears one, then says once that anything may have changed', async () => {
	const hints: unknown[] = [];
	const stop = watchDirectory(root)((paths) => hints.push(paths));
	await until(() => fs.existsSync(join(root, '.epicenter', 'saves')));
	await until(() => probes(root).length === 1);
	const [probe = ''] = probes(root);
	// Not live yet: what it hears is reported as ever, and nothing more.
	event('change', join('notes', 'a.md'));
	expect(hints).toEqual([['notes/a.md']]);

	event('rename', probe);
	expect(hints).toEqual([['notes/a.md'], null]);
	// Once live, the probe is a hidden path like any other, and is removed.
	event('change', probe);
	expect(hints).toHaveLength(2);
	await until(() => probes(root).length === 0);
	stop();
});

test('a folder that takes no probe has its readers list again at once', async () => {
	const unwritable = join(base, 'unwritable');
	fs.mkdirSync(unwritable);
	fs.writeFileSync(join(unwritable, '.epicenter'), 'not a directory');
	const hints: unknown[] = [];
	const stop = watchDirectory(unwritable)((paths) => hints.push(paths));
	await until(() => hints.length === 1);
	expect(hints).toEqual([null]);
	stop();
});
