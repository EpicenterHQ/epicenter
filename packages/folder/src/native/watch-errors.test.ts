/**
 * Native watch uncertainty invalidates all held/read sources without reading
 * files. Null Linux filenames and watcher errors must not silently lose scope.
 */
import { expect, mock, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let event: (kind: string, filename: string | null) => void;
let failure: () => void;
let closed = 0;
mock.module('node:fs', () => ({
	watch: (_root: string, options: unknown, listener: typeof event) => {
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
	const root = join(tmpdir(), 'folder');
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
