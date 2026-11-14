/**
 * A Bun process's hints of what changed in a directory: Node's recursive
 * watcher, its names made relative to the root. A hidden path never hints.
 *
 * Such a watcher starts listening some time after `watch` returns: on macOS
 * Bun starts its FSEvents stream on another thread, and a change made before
 * the stream is live is never reported. That is milliseconds when the
 * machine is idle and seconds under load. So `watchDirectory` writes a probe
 * below the root until it hears one, and answers then: a change made after
 * it answers is heard. When no probe is heard it answers anyway, and says
 * `'all'`, since it cannot tell what it missed.
 */
import { watch } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, sep } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { isHiddenPath } from '@epicenter/definition/contract';
import type { Changed } from '../device/store.js';
import { readablePath } from '../paths.js';
import { saveName } from '../state.js';

/** How long a probe waits to be heard before the next is written, and how many are. */
const PROBE_MS = 25;
const PROBES = 400;

/**
 * Watch the directory at `root` recursively, answering the stop once the
 * watcher is live. A hint names one changed path, or is `'all'` when the
 * watcher cannot say which (no name, a name it cannot read, or its error,
 * which it does not recover from). Replacing the root itself is not
 * followed. Nothing is heard once stopped.
 */
export async function watchDirectory(
	root: string,
	changed: Changed,
): Promise<() => void> {
	let closed = false;
	const live = Promise.withResolvers<void>();
	let isLive = false;
	const report = (paths: readonly string[] | 'all') => {
		if (!closed) changed(paths);
	};
	/** Named like a staged save, so no listing describes it and a sweep removes one a crash left. */
	const probe = saveName();
	const watcher = watch(
		root,
		{ recursive: true, persistent: false, encoding: 'utf8' },
		(_event, filename) => {
			// Linux's watcher can name no file: null in the types, undefined from Bun.
			if (!filename) return report('all');
			// Bun normally supplies a relative name; tolerate an absolute one
			// only when it still names something below this admitted root.
			const path = (isAbsolute(filename) ? relative(root, filename) : filename)
				.split(sep)
				.join('/');
			if (path === probe) {
				isLive = true;
				live.resolve();
				return;
			}
			// A hidden path is not the folder's data: Git's state, a staged
			// save or a recording in progress beside its target. A name outside
			// the root is no hidden path of this folder's.
			const outside = path === '..' || path.startsWith('../');
			if (!outside && isHiddenPath(path)) return;
			if (readablePath(path)) return report([path]);
			// Other uninterpretable names leave the scope of the change unknown.
			report('all');
		},
	);
	watcher.on('error', () => report('all'));
	const stop = () => {
		closed = true;
		watcher.close();
	};
	try {
		for (let tries = 0; !closed && !isLive && tries < PROBES; tries++) {
			await writeFile(`${root}/${probe}`, `${tries}`, { mode: 0o600 });
			await Promise.race([
				live.promise,
				sleep(PROBE_MS, undefined, { ref: false }),
			]);
		}
	} catch {
		// A folder that takes no probe cannot say when the watcher is live.
	}
	await rm(`${root}/${probe}`, { force: true }).catch(() => {});
	if (!isLive) report('all');
	return stop;
}
