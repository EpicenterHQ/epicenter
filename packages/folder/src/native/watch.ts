/** Storage observations are path hints, never saved bytes or publication receipts. */
import { watch } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { callObserver } from '../observer.js';
import { readablePath } from '../paths.js';

export type FolderObservation = readonly string[] | null;

/** One folder-wide subscription, owned and released by the opened Folder. */
export type FolderWatch = (
	listener: (paths: FolderObservation) => void,
) => () => void;

/**
 * Watch an admitted root recursively. Events only invalidate source; the owner
 * reads paths that a reader or accepted input holds. Root replacement recovery
 * is platform dependent and unsupported; neither inode retention nor reattachment
 * is guaranteed. A terminal watcher error invalidates once without restarting.
 */
export function watchDirectory(root: string): FolderWatch {
	return (listener) => {
		let closed = false;
		const report = (paths: FolderObservation) => {
			if (!closed) callObserver('folder observation', listener, paths);
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
				if (readablePath(path)) return report([path]);
				// Git state does not belong to the folder's readable data. Other
				// uninterpretable names leave the scope of the change unknown.
				if (path.split('/').some((part) => part.toLowerCase() === '.git'))
					return;
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
