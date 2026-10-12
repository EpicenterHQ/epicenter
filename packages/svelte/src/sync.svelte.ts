/**
 * The state a page keeps around `folder.sync` (ADR-0514, ADR-0516): whether
 * a run or an Apply is in flight, the attempt waiting for the person's
 * choices, and what the folder refused in the last Apply.
 *
 * The review is modal. While an attempt waits, the page shows its review and
 * nothing else takes input: `locked` is true from the start of a run until
 * the attempt ends. Apply ends it unless the folder refuses the choices,
 * which stay as `problems`; Cancel discards it. Nothing outlives an attempt.
 *
 * `run()` and `apply(attempt, choices)` call the folder between the page's
 * `beforeSync` (wait for the open item's saves, so the checkpoint holds
 * them) and `afterSync` (read lists and the open item again).
 *
 * `describeSync` (`@epicenter/svelte/sync-line`, re-exported here) words a
 * result for a person. What else the page shows stays with the page.
 */
import type {
	FolderSync,
	SyncAttempt,
	SyncChoiceProblem,
	SyncChoices,
	SyncOutcome,
} from '@epicenter/folder';
import { SyncError } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';

export { describeSync, type SyncLine } from './sync-line.js';

export type SyncController = ReturnType<typeof createSyncController>;

export function createSyncController({
	folder,
	beforeSync = async () => {},
	afterSync = async () => {},
	refused = () => undefined,
}: {
	folder: { readonly sync: FolderSync };
	/** Runs before each run and Apply, such as waiting for the open item's saves. */
	beforeSync?: () => Promise<unknown>;
	/** Runs after each run and Apply, whatever it answered. */
	afterSync?: () => Promise<unknown>;
	/** Why no sync starts now, if one does not, such as a pending quit. */
	refused?: () => string | undefined;
}) {
	let syncing = $state(false);
	let attempt = $state.raw<SyncAttempt | undefined>();
	let problems = $state.raw<readonly SyncChoiceProblem[]>([]);

	/** Why a run or an Apply cannot start now; nothing is called then. */
	const blocked = () => (syncing ? 'A sync is already running.' : refused());

	/**
	 * One folder call with `syncing` set, between the page's hooks. `settle`
	 * records the result before `afterSync`, so the page reads again with
	 * the lock already in its final state.
	 */
	async function step<T>(
		call: () => Promise<Result<T, SyncError>>,
		settle: (result: Result<T, SyncError>) => void,
	): Promise<Result<T, SyncError>> {
		syncing = true;
		try {
			await beforeSync();
			const result = await call();
			settle(result);
			return result;
		} finally {
			syncing = false;
			await afterSync();
		}
	}

	function end() {
		attempt = undefined;
		problems = [];
	}

	return {
		/** Whether the folder syncs; a desktop folder does not yet. */
		get supported() {
			return folder.sync.supported;
		},
		/** A run or an Apply is in flight. */
		get syncing() {
			return syncing;
		},
		/** The attempt whose review shows, if the last run found conflicts. */
		get attempt() {
			return attempt;
		},
		/** Whether the page takes no other input: a sync runs or a review shows. */
		get locked() {
			return syncing || attempt !== undefined;
		},
		/** What the folder refused in the last Apply. */
		get problems() {
			return problems;
		},
		/** Commit, fetch, merge, and push; conflicts keep an attempt for the review. */
		async run(): Promise<Result<SyncOutcome, SyncError>> {
			const why =
				attempt !== undefined
					? 'Finish or cancel the review first.'
					: blocked();
			if (why !== undefined) return SyncError.Failed({ cause: why });
			return step(
				() => folder.sync.run(),
				(ran) => {
					if (ran.error?.name === 'NeedsChoices') attempt = ran.error.attempt;
				},
			);
		},
		/** Discard the waiting attempt and its choices; nothing is written. */
		cancel() {
			if (!syncing) end();
		},
		/** Resolve with the review's choices. */
		async apply(
			answered: SyncAttempt,
			choices: SyncChoices,
		): Promise<Result<SyncOutcome, SyncError>> {
			const why = blocked();
			if (why !== undefined) return SyncError.Failed({ cause: why });
			return step(
				() => folder.sync.resolve(answered, choices),
				(resolved) => {
					if (resolved.error?.name === 'InvalidChoices')
						problems = resolved.error.problems;
					else if (attempt?.id === answered.id) end();
				},
			);
		},
	};
}
