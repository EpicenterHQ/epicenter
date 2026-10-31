/**
 * Native watch uncertainty invalidates all held/read sources without reading
 * files. Null Linux filenames and watcher errors must not silently lose scope.
 */
import { expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let event: (kind: string, filename: string | null) => void;
let failure: () => void;
let closed = 0;
const root = join(tmpdir(), 'folder');
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
		if (at !== root)
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

test("Epicenter's own state at the top of the folder never reports a change", () => {
	const hints: unknown[] = [];
	const stop = watchDirectory(root)((paths) => hints.push(paths));
	// The save lock and staged saves live in `.epicenter`, so a save does
	// not echo as a change.
	event('rename', '.epicenter');
	event('change', join('.epicenter', 'save-lock'));
	event('rename', join('.epicenter', 'scratch', 'staged'));
	// Below the top, `.epicenter` is an ordinary hidden name.
	event('change', join('notes', '.epicenter'));
	expect(hints).toEqual([['notes/.epicenter']]);
	stop();
});
