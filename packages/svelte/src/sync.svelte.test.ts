/**
 * Sync Controller Tests
 *
 * Drives `createSyncController` over a stand-in `folder.sync` whose answers
 * each test chooses.
 *
 * Key behaviors:
 * - A run and an Apply call the folder between `beforeSync` and
 *   `afterSync`, with `syncing` set only in between
 * - A run that needs choices keeps its attempt and locks the page until
 *   Apply ends it or Cancel discards it; no run starts meanwhile
 * - Refused choices stay with the attempt as `problems`; any other Apply
 *   result ends it
 * - A refusal, or a sync already running, calls nothing
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type {
	FolderSync,
	SyncAttempt,
	SyncError as SyncErrorType,
	SyncOutcome,
} from '@epicenter/folder';
import { SyncError } from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';

const { createSyncController, describeSync } = await import('./sync.svelte.ts');

const attempt: SyncAttempt = {
	id: 'attempt-1',
	local: 'a'.repeat(40),
	incoming: 'b'.repeat(40),
	conflicts: [
		{
			id: 'theme',
			kind: 'setting',
			path: 'kv.json',
			key: 'theme',
			base: { present: true, value: 'light' },
			local: { present: true, value: 'dark' },
			incoming: { present: true, value: 'sepia' },
		},
	],
};
const SYNCED: SyncOutcome = { kind: 'synced', head: 'c'.repeat(40) };

function setup(answers: {
	run?: () => Result<SyncOutcome, SyncErrorType>;
	resolve?: () => Result<SyncOutcome, SyncErrorType>;
}) {
	const log: string[] = [];
	let refusal: string | undefined;
	const sync: FolderSync = {
		supported: true,
		async run() {
			log.push(`run syncing=${controller.syncing}`);
			return answers.run?.() ?? Ok(SYNCED);
		},
		async resolve() {
			log.push('resolve');
			return answers.resolve?.() ?? Ok(SYNCED);
		},
	};
	const controller = createSyncController({
		folder: { sync },
		beforeSync: async () => log.push('before'),
		afterSync: async () => log.push(`after syncing=${controller.syncing}`),
		refused: () => refusal,
	});
	return {
		controller,
		log,
		refuse(why: string | undefined) {
			refusal = why;
		},
	};
}

test('a run calls the folder between the hooks, with syncing set only in between', async () => {
	const { controller, log } = setup({});
	expect((await controller.run()).data).toEqual(SYNCED);
	expect(log).toEqual(['before', 'run syncing=true', 'after syncing=false']);
	expect(controller.attempt).toBeUndefined();
	expect(controller.locked).toBe(false);
});

test('a waiting attempt locks the page until Cancel discards it, and no run starts meanwhile', async () => {
	let next: Result<SyncOutcome, SyncErrorType> = SyncError.NeedsChoices({
		attempt,
	});
	const { controller, log } = setup({ run: () => next });
	await controller.run();
	expect(controller.attempt).toBe(attempt);
	expect(controller.locked).toBe(true);

	next = Ok(SYNCED);
	log.length = 0;
	expect((await controller.run()).error?.name).toBe('Failed');
	expect(log).toEqual([]);
	expect(controller.attempt).toBe(attempt);

	controller.cancel();
	expect(controller.attempt).toBeUndefined();
	expect(controller.locked).toBe(false);
	expect((await controller.run()).data).toEqual(SYNCED);
});

test('refused choices stay with the attempt; any other Apply result ends it', async () => {
	let resolved: Result<SyncOutcome, SyncErrorType> = SyncError.InvalidChoices({
		problems: [
			{ conflictId: 'theme', reason: 'missing', message: 'No choice' },
		],
	});
	const { controller } = setup({
		run: () => SyncError.NeedsChoices({ attempt }),
		resolve: () => resolved,
	});
	await controller.run();
	await controller.apply(attempt, {});
	expect(controller.attempt).toBe(attempt);
	expect(controller.problems.map((problem) => problem.conflictId)).toEqual([
		'theme',
	]);

	resolved = SyncError.Stale({ reason: 'changed' });
	await controller.apply(attempt, { theme: { kind: 'take', side: 'local' } });
	expect(controller.attempt).toBeUndefined();
	expect(controller.locked).toBe(false);
	expect(controller.problems).toEqual([]);
});

test('a refusal, or a sync already running, calls nothing', async () => {
	const { controller, log, refuse } = setup({});
	refuse('Quitting');
	expect((await controller.run()).error?.name).toBe('Failed');
	expect((await controller.apply(attempt, {})).error?.name).toBe('Failed');
	expect(log).toEqual([]);

	const gate = Promise.withResolvers<void>();
	let calls = 0;
	const slow = createSyncController({
		folder: {
			sync: {
				supported: true,
				async run() {
					calls++;
					await gate.promise;
					return Ok(SYNCED);
				},
				async resolve() {
					calls++;
					return Ok(SYNCED);
				},
			},
		},
	});
	const running = slow.run();
	expect(slow.syncing).toBe(true);
	expect((await slow.run()).error?.name).toBe('Failed');
	expect((await slow.apply(attempt, {})).error?.name).toBe('Failed');
	gate.resolve();
	await running;
	expect(calls).toBe(1);
});

test('describeSync words outcomes and refusals for a person', () => {
	expect(describeSync(Ok(SYNCED))).toEqual({
		label: 'Synced',
		detail: 'ccccccc',
		tone: 'good',
	});
	expect(describeSync(SyncError.NeedsChoices({ attempt })).label).toBe(
		'1 change needs your choice',
	);
	expect(describeSync(SyncError.Stale({ reason: 'replaced' })).tone).toBe(
		'warning',
	);
	expect(
		describeSync(
			Ok({
				kind: 'saved',
				head: 'c'.repeat(40),
				push: undefined,
				changedSince: true,
			}),
		).detail,
	).toBe('Files were saved during the sync. Sync again to send them.');
});
