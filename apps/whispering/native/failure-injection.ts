/**
 * Repeatable publication and commit failures, for a debug shell only.
 *
 * Publication failures are counted: arming "fail the next N row writes" makes
 * exactly the next N attempts fail and then publication works again, so a test
 * can exercise failure and retry in a fixed order.
 *
 * A recording is published by the page as two writes, each the folder's own
 * operation: the audio file, then the row. The page's folder engine makes
 * them, not this host, and nothing here publishes or answers for it. Just before
 * the page makes one of those writes it asks for an obstacle, naming the
 * write's step, the recording's stem, and, for the audio, its path. An armed
 * failure for that step puts an empty directory at the path and hands back a
 * name for it; the page makes its write and then has the obstacle removed.
 * The folder refuses that write itself. An obstructed audio write leaves
 * nothing written; an obstructed row write leaves the audio the first write
 * saved. A path that is already occupied is left alone and the failure is
 * not counted, since the folder refuses it without help.
 *
 * Only those two paths can be obstructed: the recording's row, and audio at
 * `recordings/<stem>.<extension>`, where a capture of that stem is saved.
 * Each is checked before it is joined onto the root. A directory on the way
 * that is a symbolic link is refused. Removing an obstacle removes the empty
 * directory this host made and the empty parents it had to create, and
 * nothing else.
 *
 * Commit failures are real: a lock file is created on the branch ref, where an
 * interrupted Git process leaves one, so Git refuses to move the branch and
 * the commit fails while file saves keep working. The branch is the one
 * `HEAD` names when the lock is taken, so the lock can only be taken once the
 * page has opened the folder, which initializes Git. A lock asked for at launch waits
 * for the page to say the folder is open.
 *
 * That lock path belongs to Git. The injected lock is created exclusively, so
 * it never replaces a lock another process holds, and it carries a marker
 * unique to this host. Only a lock whose content is that marker is ever
 * removed. A lock this host did not create is left exactly as found, including
 * one left by an earlier debug host that stopped without cleaning up.
 *
 * A release shell never constructs this.
 */
import { randomUUID } from 'node:crypto';
import {
	lstat,
	mkdir,
	readFile,
	rmdir,
	unlink,
	writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathProblem, rowPath } from '@epicenter/folder';
import { RECORDINGS } from '../src/lib/definition.js';

type InjectionState = {
	/** How many upcoming recording row writes fail. The audio written before each stays. */
	rowWrites: number;
	/** How many upcoming recording audio writes fail. Nothing is written by those attempts. */
	audioWrites: number;
	/** Whether the branch ref is locked, so commits cannot be recorded. */
	commitsBlocked: boolean;
};

/** Starts the content of every lock a debug host creates. */
export const LOCK_MARKER_PREFIX = 'whispering-debug-lock';

const count = (value: unknown) =>
	typeof value === 'number' && Number.isInteger(value) && value >= 0
		? value
		: undefined;
const codeOf = (cause: unknown) => (cause as { code?: string })?.code;

export function createFailureInjection({
	root,
	launch = {},
}: {
	root: string;
	/** What the launch environment armed. The branch lock waits for `armLaunch`. */
	launch?: Partial<InjectionState>;
}) {
	const state: InjectionState = {
		rowWrites: count(launch.rowWrites) ?? 0,
		audioWrites: count(launch.audioWrites) ?? 0,
		commitsBlocked: false,
	};
	let lockAtLaunch = launch.commitsBlocked === true;
	/** The lock this host created, at the path it was created at. */
	let heldLock: string | undefined;
	/** Obstacles in place now, by the name the page was given. */
	const obstacles = new Map<string, () => Promise<void>>();

	/** What this host writes into a lock it creates. Git never writes this. */
	const marker = `${LOCK_MARKER_PREFIX} ${randomUUID()}\n`;

	/** The lock path of the branch `HEAD` names. Refuses a folder with no Git yet. */
	async function branchLock(): Promise<string> {
		let head: string;
		try {
			head = await readFile(join(root, '.git', 'HEAD'), 'utf8');
		} catch {
			throw new Error(
				'The folder has no Git history yet, so there is no branch to lock. Lock it once the app has opened the folder.',
			);
		}
		const branch = /^ref: refs\/heads\/(.+)$/.exec(head.trim())?.[1];
		// The name is joined onto a path, so it is held to the folder's path rule.
		if (branch === undefined || pathProblem(branch) !== undefined)
			throw new Error(
				'HEAD does not name a branch, so there is no branch to lock.',
			);
		return `${join(root, '.git', 'refs', 'heads', ...branch.split('/'))}.lock`;
	}

	/** Create the lock, or refuse because one is already there. */
	async function lockBranch(lock: string) {
		await mkdir(dirname(lock), { recursive: true });
		try {
			await writeFile(lock, marker, { flag: 'wx' });
		} catch (cause) {
			if (codeOf(cause) !== 'EEXIST') throw cause;
			const found = await readFile(lock, 'utf8').catch(() => '');
			throw new Error(
				found.startsWith(LOCK_MARKER_PREFIX)
					? `${lock} is a lock left by an earlier debug session. It was not replaced. Remove it by hand if no other Whispering is running.`
					: `${lock} is held by another Git process. It was not replaced.`,
			);
		}
		heldLock = lock;
	}

	/** Remove the lock only when it is the one this host created. */
	async function unlockBranch(): Promise<void> {
		const lock = heldLock;
		if (lock === undefined) return;
		let found: string;
		try {
			found = await readFile(lock, 'utf8');
		} catch (cause) {
			if (codeOf(cause) !== 'ENOENT') throw cause;
			heldLock = undefined;
			return;
		}
		// Someone removed ours and took the lock: it is theirs now.
		if (found === marker) await unlink(lock);
		heldLock = undefined;
	}

	async function arm(change: Record<string, unknown>): Promise<InjectionState> {
		state.rowWrites = count(change.rowWrites) ?? state.rowWrites;
		state.audioWrites = count(change.audioWrites) ?? state.audioWrites;
		if (
			typeof change.commitsBlocked === 'boolean' &&
			change.commitsBlocked !== state.commitsBlocked
		) {
			if (change.commitsBlocked) await lockBranch(await branchLock());
			else await unlockBranch();
			state.commitsBlocked = change.commitsBlocked;
		}
		return { ...state };
	}

	/**
	 * Make every missing directory above `path`, one at a time, and return
	 * the ones made. Undefined when something on the way is not a directory,
	 * which the folder refuses without help.
	 */
	async function makeParents(path: string): Promise<string[] | undefined> {
		const parts = path.split('/').slice(0, -1);
		const made: string[] = [];
		let current = root;
		for (const part of parts) {
			current = join(current, part);
			const stats = await lstat(current).catch((cause) => {
				if (codeOf(cause) === 'ENOENT') return undefined;
				throw cause;
			});
			if (stats === undefined) {
				await mkdir(current);
				made.push(current);
				continue;
			}
			if (stats.isSymbolicLink())
				throw new Error(
					`'${path}' passes through a symbolic link. Nothing was put in its way.`,
				);
			if (!stats.isDirectory()) {
				await removeEmpty(made);
				return undefined;
			}
		}
		return made;
	}

	/** Remove directories this host made, deepest first, while they are still empty. */
	async function removeEmpty(made: readonly string[]) {
		for (const directory of [...made].reverse())
			await rmdir(directory).catch(() => {});
	}

	/**
	 * Put an empty directory in the way of one write of a recording's
	 * publication, when a failure is armed for that step. Returns the
	 * obstacle's name, or null when nothing was placed.
	 */
	async function obstruct(write: {
		step?: unknown;
		stem?: unknown;
		path?: unknown;
	}): Promise<string | null> {
		const { step, stem, path } = write;
		// A stem is one literal segment whose row path stays inside the folder.
		if (
			typeof stem !== 'string' ||
			stem.includes('/') ||
			pathProblem(rowPath(RECORDINGS, stem)) !== undefined
		)
			throw new Error('An obstacle needs the stem of a recording row.');

		let target: { counter: 'audioWrites' | 'rowWrites'; path: string };
		switch (step) {
			case 'audio': {
				const extension =
					typeof path === 'string' && path.startsWith(`${RECORDINGS}/${stem}.`)
						? path.slice(`${RECORDINGS}/${stem}.`.length)
						: undefined;
				if (
					typeof path !== 'string' ||
					extension === undefined ||
					extension === '' ||
					extension.includes('/') ||
					extension === 'md' ||
					pathProblem(path) !== undefined
				)
					throw new Error(
						'An obstacle needs the audio path a capture of this recording is saved at.',
					);
				target = { counter: 'audioWrites', path };
				break;
			}
			case 'row':
				target = { counter: 'rowWrites', path: rowPath(RECORDINGS, stem) };
				break;
			default:
				throw new Error(
					'An obstacle names the audio write or the row write of a recording.',
				);
		}
		if (state[target.counter] === 0) return null;
		// Taken before anything is awaited, so overlapping calls cannot both
		// spend the last armed failure. Given back when nothing is placed.
		state[target.counter] -= 1;
		let obstacle: string | null = null;
		try {
			const made = await makeParents(target.path);
			if (made === undefined) return null;
			const placed = join(root, ...target.path.split('/'));
			try {
				await mkdir(placed);
			} catch (cause) {
				await removeEmpty(made);
				if (codeOf(cause) === 'EEXIST') return null;
				throw cause;
			}
			obstacle = randomUUID();
			obstacles.set(obstacle, () => removeEmpty([...made, placed]));
			return obstacle;
		} finally {
			if (obstacle === null) state[target.counter] += 1;
		}
	}

	/** Remove one obstacle. A name this host does not hold removes nothing. */
	async function clear(obstacle: unknown): Promise<void> {
		if (typeof obstacle !== 'string') return;
		const remove = obstacles.get(obstacle);
		obstacles.delete(obstacle);
		await remove?.();
	}

	return {
		get state(): InjectionState {
			return { ...state };
		},
		arm,
		/**
		 * Take the branch lock the launch environment asked for. The page calls
		 * this once it has opened the folder, which is when Git exists.
		 * A folder with no Git yet keeps the request for the next call; a lock
		 * someone else holds is theirs, and the request is dropped.
		 */
		async armLaunch(): Promise<InjectionState> {
			if (!lockAtLaunch) return { ...state };
			const lock = await branchLock();
			lockAtLaunch = false;
			await lockBranch(lock);
			state.commitsBlocked = true;
			return { ...state };
		},
		obstruct,
		clear,
		/** Remove what this host put in the folder when it stops. Nothing else is touched. */
		async release() {
			for (const obstacle of [...obstacles.keys()]) await clear(obstacle);
			await unlockBranch().catch(() => {});
			state.commitsBlocked = false;
		},
	};
}

export type FailureInjection = ReturnType<typeof createFailureInjection>;
