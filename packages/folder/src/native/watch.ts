/**
 * A Bun process's hints of what changed in a directory: Node's recursive
 * watcher, its names made relative to the root. A hidden path never hints.
 *
 * Such a watcher starts listening some time after `watch` returns: on macOS
 * Bun starts its FSEvents stream on another thread, and a change made before
 * the stream is live is never reported. That is milliseconds when the
 * machine is idle and seconds under load, and a file written as an app opens
 * would otherwise stay unseen until the next change. So a watcher writes a
 * probe below the root until it hears one: from then it is live, and it
 * reports a change it cannot name (null), so its readers list again and see
 * whatever changed while it started.
 */
import { watch } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isHiddenPath } from '@epicenter/definition/contract';
import type { ChangeListener, ChangeSource } from '../changes.js';
import { readablePath } from '../paths.js';
import {
	SAVES,
	STATE_DIRECTORY,
	savesDirectory,
	scratchName,
} from '../state.js';

/** How long a probe waits to be heard before the next is written, and how many are. */
const PROBE_MS = 25;
const PROBES = 400;

/**
 * Watch the directory at `root` recursively. A hint names one changed path,
 * or is null when the watcher cannot say which (no name, a name it cannot
 * read, or its error, which it does not recover from), and once when the
 * watcher is live. Replacing the root itself is not followed. Nothing is
 * heard once the source stops.
 */
export function watchDirectory(root: string): ChangeSource {
	return (listener) => {
		let closed = false;
		let live = false;
		const report: ChangeListener = (paths) => {
			if (!closed) listener(paths);
		};
		/** Staged like a save, so the desktop's sweep removes one a crash left. */
		const probe = `${STATE_DIRECTORY}/${SAVES}/${scratchName()}`;
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
				if (!live && path === probe) {
					live = true;
					return report(null);
				}
				if (!outside && isHiddenPath(path)) return;
				if (readablePath(path)) return report([path]);
				// Other uninterpretable names leave the scope of the change unknown.
				report(null);
			},
		);
		watcher.on('error', () => report(null));
		void (async () => {
			try {
				await mkdir(savesDirectory(root), { recursive: true, mode: 0o700 });
				for (let tries = 0; !closed && !live && tries < PROBES; tries++) {
					await writeFile(`${root}/${probe}`, `${tries}`, { mode: 0o600 });
					await sleep(PROBE_MS, undefined, { ref: false });
				}
			} catch {
				// A folder that takes no probe: its readers list again now instead.
			}
			await rm(`${root}/${probe}`, { force: true }).catch(() => {});
			if (!live) report(null);
		})();
		return () => {
			closed = true;
			watcher.close();
		};
	};
}
