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

test('a hidden path never reports a change, at any depth', () => {
	const hints: unknown[] = [];
	const stop = watchDirectory(root)((paths) => hints.push(paths));
	// A staged save and a recording in progress are hidden siblings of where
	// they land, so a save does not echo and a recording's header does not
	// wake anything.
	event(
		'rename',
		join('notes', '.lz0-0123456789abcdef0123456789abcdef-1.epicenter-pending'),
	);
	event('change', join('recordings', '.1.wav.epicenter-pending'));
	event('change', '.DS_Store');
	event('change', join('notes', '.obsidian', 'workspace.json'));
	event('change', join('notes', 'a.md'));
	expect(hints).toEqual([['notes/a.md']]);
	stop();
});
