/**
 * What the Folders window says about each synced folder, from the CLI's own
 * words: the folder's `epicenter status --json` line and its last round of
 * `epicenter sync --json`, joined by the shell (`synced_folders.rs`).
 */
import type { SyncedFolder } from '../ui/bindings.gen';

/**
 * The shell's event when a round ended, the service changed, or a request
 * arrived: `SYNCED_FOLDERS_CHANGED` in `src-tauri/src/synced_folders.rs`,
 * sent to the Folders window alone. It carries nothing; the window lists
 * again.
 */
export const SYNCED_FOLDERS_CHANGED = 'epicenter://synced-folders-changed';

export type SyncTone = 'synced' | 'waiting' | 'retry' | 'stopped' | 'problem';

/** The status line of a folder's row: its tone, a few words, and the CLI's reason. */
export type SyncLine = {
	tone: SyncTone;
	label: string;
	detail: string | null;
};

/** The CLI's reasons a registered folder cannot be read, as a row says them. */
const PROBLEMS: Record<string, string> = {
	'not on disk': 'Missing from disk',
	'not in a Git repository': 'Not a Git repository',
	'its repository is not set up for sync': 'Not set up for sync',
};

const ROUND = {
	retry: 'Will try again',
	stopped: 'Stopped',
} as const;

export function describeSync(folder: SyncedFolder, now: number): SyncLine {
	if (folder.problem !== null)
		return {
			tone: 'problem',
			label: PROBLEMS[folder.problem] ?? folder.problem,
			detail: null,
		};
	const last = folder.last;
	if (last === null)
		return {
			tone: 'waiting',
			label: 'Waiting for the first sync',
			detail: null,
		};
	if (last.status !== 'synced')
		return {
			tone: last.status,
			label: ROUND[last.status],
			detail: last.message ?? null,
		};
	return {
		tone: 'synced',
		label: `Synced ${ago(last.endedAt ?? now, now)}`,
		detail:
			folder.changes === 0
				? null
				: `${folder.changes} ${folder.changes === 1 ? 'change' : 'changes'} not synced yet`,
	};
}

/** How long ago `then` was, as a person would say it. */
export function ago(then: number, now: number): string {
	const minutes = Math.floor((now - then) / 60_000);
	if (minutes < 1) return 'just now';
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return `on ${new Date(then).toLocaleDateString()}`;
}

/** Where a folder syncs to: `owner/name` for a URL, a folder name for a path. */
export function remoteName(remote: string | null): string {
	if (remote === null) return 'This computer only';
	const path = URL.canParse(remote) ? new URL(remote).pathname : remote;
	const segments = path
		.replace(/\.git\/?$/, '')
		.split('/')
		.filter((segment) => segment !== '');
	if (!URL.canParse(remote) || segments.length < 2)
		return segments.at(-1) ?? remote;
	return segments.slice(-2).join('/');
}
