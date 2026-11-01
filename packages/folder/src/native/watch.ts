/**
 * A Bun process's hints of what changed in a directory: Node's recursive
 * watcher, its names made relative to the root. A hidden path never hints.
 */
import { watch } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { isHiddenPath } from '@epicenter/definition/contract';
import type { ChangeListener, ChangeSource } from '../changes.js';
import { readablePath } from '../paths.js';

/**
 * Watch the directory at `root` recursively. A hint names one changed path,
 * or is null when the watcher cannot say which (no name, a name it cannot
 * read, or its error, which it does not recover from). Replacing the
 * root itself is not followed. Nothing is heard once the source stops.
 */
export function watchDirectory(root: string): ChangeSource {
	return (listener) => {
		let closed = false;
		const report: ChangeListener = (paths) => {
			if (!closed) listener(paths);
		};
		const watcher = watch(
			root,
			{ recursive: true, persistent: false, encoding: 'utf8' },
			(_event, filename) => {
				if (filename === null || filename === '') return report(null);
				// Bun normally supplies a relative name; tolerate an absolute one
				// only when it still names something below this admitted root.
				const path = (
					isAbsolute(filename) ? relative(root, filename) : filename
				)
					.split(sep)
					.join('/');
				// A hidden path is not the folder's data: Git's state, and every
				// unfinished write in `.epicenter` (a staged save, a recording in
				// progress). A save does not echo as a change. A name outside the
				// root is no hidden path of this folder's.
				const outside = path === '..' || path.startsWith('../');
				if (!outside && isHiddenPath(path)) return;
				if (readablePath(path)) return report([path]);
				// Other uninterpretable names leave the scope of the change unknown.
				report(null);
			},
		);
		watcher.on('error', () => report(null));
		return () => {
			closed = true;
			watcher.close();
		};
	};
}
