/**
 * The act path: turning a triage intent into durable local state, and nothing
 * else. What these pin down:
 *
 * - An act is offline. It records label IDs without consulting the cache or calling Gmail, so `deps` here carries no client at all.
 * - EVERY valid opinion is recorded at a fresh revision, including one the
 *   mirror already agrees with. The mirror lags Gmail and lags in-flight
 *   delivery, so treating agreement as "nothing to do" would silently drop a
 *   user's choice; a redundant label modify is the cheaper mistake.
 * - An inverse act replaces the pending one rather than erasing it.
 * - The read-only gate refuses before anything is recorded.
 */

import { describe, expect, test } from 'bun:test';
import { type AssertDeps, assertMessageLabels } from './assert.ts';
import type { Mailbox } from './mailbox.ts';
import type { GmailMessage } from './schema.ts';
import { openTestSession } from './session.test-support.ts';

const ACTED_AT = '2026-08-01T12:00:00.000Z';

function message(id: string, labelIds: string[]): GmailMessage {
	return {
		id,
		threadId: `t-${id}`,
		labelIds,
		snippet: `snippet ${id}`,
		internalDate: '1700000000000',
		payload: { headers: [{ name: 'Subject', value: `Subject ${id}` }] },
	};
}

async function setup(
	messages: GmailMessage[] = [message('m1', ['INBOX', 'UNREAD'])],
): Promise<{
	deps: AssertDeps;
	/** The cache, for the one test that needs to change
	 * Gmail's facts underneath an act. */
	mailbox: Mailbox;
	cleanup: () => void;
}> {
	const session = await openTestSession();
	const syncedAt = '2026-08-01T00:00:00.000Z';
	await session.mailbox.ingestFullPullPage(messages, syncedAt);
	await session.mailbox.ingestLabels([
		{ id: 'INBOX', name: 'INBOX', type: 'system' },
		{ id: 'UNREAD', name: 'UNREAD', type: 'system' },
		{ id: 'TRASH', name: 'TRASH', type: 'system' },
		{ id: 'Label_7', name: 'Altered Trajectories', type: 'user' },
	]);
	return {
		deps: {
			intents: session.intents,
			now: () => Date.parse(ACTED_AT),
		},
		mailbox: session.mailbox,
		cleanup: session.close,
	};
}

const act = (
	deps: AssertDeps,
	input: { ids: string[]; addLabels?: string[]; removeLabels?: string[] },
) =>
	assertMessageLabels({
		deps,
		input: {
			ids: input.ids,
			addLabels: input.addLabels ?? [],
			removeLabels: input.removeLabels ?? [],
		},
	});

describe('assertMessageLabels', () => {
	test('archiving a mirrored inbox message records one assertion', async () => {
		const { deps, cleanup } = await setup();
		try {
			const { data, error } = await act(deps, {
				ids: ['m1'],
				removeLabels: ['INBOX'],
			});
			expect(error).toBeNull();
			expect(data).toEqual({ asserted: 1 });
			expect(await deps.intents.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
			]);
		} finally {
			cleanup();
		}
	});

	test('an inverse act overwrites the pending one at a newer revision', async () => {
		const { deps, cleanup } = await setup();
		try {
			await act(deps, { ids: ['m1'], removeLabels: ['INBOX'] });
			const first = (await deps.intents.pending())[0];

			const { data } = await act(deps, { ids: ['m1'], addLabels: ['INBOX'] });

			// One row, not two, and not zero: the store keeps the latest answer for
			// the pair, and the newer revision is what invalidates the retirement of
			// any delivery still carrying the older one.
			expect(data).toEqual({ asserted: 1 });
			const pending = await deps.intents.pending();
			expect(pending).toHaveLength(1);
			expect(pending[0]).toMatchObject({ labelId: 'INBOX', want: true });
			expect(pending[0]?.revision).toBeGreaterThan(first?.revision ?? 0);
		} finally {
			cleanup();
		}
	});

	test('an act the mirror already agrees with is still recorded', async () => {
		const { deps, cleanup } = await setup();
		try {
			// The mirror says INBOX is present. It can be wrong in both directions:
			// stale against Gmail, or simply not yet folded from a delivery this
			// machine already sent. Judging the act redundant against it would throw
			// the user's choice away on the strength of a guess.
			const { data } = await act(deps, { ids: ['m1'], addLabels: ['INBOX'] });
			expect(data).toEqual({ asserted: 1 });
			expect(await deps.intents.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: true },
			]);
		} finally {
			cleanup();
		}
	});

	test('a stale mirror does not stop the user from asserting the opposite', async () => {
		// Gmail has moved on (the message was un-archived elsewhere) but this
		// mirror still shows the pre-change facts. The user, looking at some other
		// view or simply at reality, asks for INBOX off, and that has to be kept.
		const { deps, cleanup } = await setup([message('m1', [])]);
		try {
			const { data } = await act(deps, {
				ids: ['m1'],
				removeLabels: ['INBOX'],
			});
			expect(data).toEqual({ asserted: 1 });
			expect(await deps.intents.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
			]);
		} finally {
			cleanup();
		}
	});

	test('system labels resolve with an empty mirror label table', async () => {
		// Before the first pull, and for the whole window after a mirror rebuild,
		// the mirrored label table is empty. Gmail's system ids are protocol
		// constants, so triage keeps working: refusing to archive because the
		// disposable copy has not been repopulated would be refusing a concrete id.
		const session = await openTestSession();
		try {
			expect(await session.mailbox.listLabels()).toEqual([]);
			const deps: AssertDeps = {
				intents: session.intents,
				now: () => Date.parse(ACTED_AT),
			};

			const archived = await act(deps, {
				ids: ['m1'],
				removeLabels: ['INBOX'],
			});
			expect(archived.error).toBeNull();
			const trashed = await act(deps, {
				ids: ['m1'],
				addLabels: ['TRASH'],
				removeLabels: ['UNREAD', 'STARRED'],
			});
			expect(trashed.error).toBeNull();

			expect(
				(await session.intents.pending()).map((i) => [i.labelId, i.want]),
			).toEqual([
				['INBOX', false],
				['TRASH', true],
				['UNREAD', false],
				['STARRED', false],
			]);
		} finally {
			session.close();
		}
	});

	test('a captured custom label ID can be recorded while the cache is empty', async () => {
		const session = await openTestSession();
		try {
			expect(await session.mailbox.listLabels()).toEqual([]);
			const result = await act(
				{ intents: session.intents, now: () => Date.parse(ACTED_AT) },
				{ ids: ['m1'], addLabels: ['Label_7'] },
			);
			expect(result.error).toBeNull();
			expect(await session.intents.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'Label_7', want: true },
			]);
		} finally {
			session.close();
		}
	});

	test('one act cannot both add and remove the same label', async () => {
		const { deps, cleanup } = await setup();
		try {
			const byId = await act(deps, {
				ids: ['m1'],
				addLabels: ['Label_7'],
				removeLabels: ['Label_7'],
			});
			expect(byId.error?.name).toBe('ContradictoryLabel');

			expect(await deps.intents.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('an act over several ids snapshots exactly those ids', async () => {
		const { deps, cleanup } = await setup([
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
			message('m3', ['INBOX']),
		]);
		try {
			await act(deps, { ids: ['m1', 'm2'], removeLabels: ['INBOX'] });
			// m3 arrived in the same view and the same thread; it was not acted on,
			// so nothing about it is owed.
			expect((await deps.intents.pending()).map((i) => i.messageId)).toEqual([
				'm1',
				'm2',
			]);
		} finally {
			cleanup();
		}
	});

	test('an id the mirror has never seen is recorded like any other', async () => {
		const { deps, cleanup } = await setup();
		try {
			const { data } = await act(deps, {
				ids: ['ghost'],
				removeLabels: ['INBOX'],
			});
			expect(data).toEqual({ asserted: 1 });
		} finally {
			cleanup();
		}
	});

	test("Gmail's per-direction label cap is enforced here, not only at MCP", async () => {
		const { deps, cleanup } = await setup();
		try {
			const labels = Array.from({ length: 101 }, (_, i) => `Label_${i}`);
			// The cap is checked before label resolution, so it does not depend on
			// the mirror knowing these names: an assertion no `messages.modify` could
			// ever carry is refused rather than made durable.
			const added = await act(deps, { ids: ['m1'], addLabels: labels });
			expect(added.error?.name).toBe('TooManyLabels');
			expect(added.error?.message).toContain('at most 100 labels added');

			const removed = await act(deps, { ids: ['m1'], removeLabels: labels });
			expect(removed.error?.name).toBe('TooManyLabels');
			expect(removed.error?.message).toContain('at most 100 labels removed');

			expect(await deps.intents.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('repeating an act that the mirror agrees with never shrinks what is owed', async () => {
		const { deps, mailbox, cleanup } = await setup();
		try {
			await act(deps, { ids: ['m1'], removeLabels: ['INBOX'] });
			// Pretend the reconciler delivered it and the pull folded Gmail's answer,
			// but the retirement has not happened yet. The mirror now agrees with the
			// pending assertion, which is exactly when a cancellation rule would fire.
			await mailbox.patchMessageLabels(
				'm1',
				['UNREAD'],
				'2026-08-01T12:00:01.000Z',
			);
			await act(deps, { ids: ['m1'], removeLabels: ['INBOX'] });
			await act(deps, { ids: ['m1'], removeLabels: ['INBOX'] });

			expect(await deps.intents.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
			]);
		} finally {
			cleanup();
		}
	});

	test('empty and oversized acts are refused', async () => {
		const { deps, cleanup } = await setup();
		try {
			expect(
				(await act(deps, { ids: [], removeLabels: ['INBOX'] })).error?.name,
			).toBe('NoMessageIds');
			expect((await act(deps, { ids: ['m1'] })).error?.name).toBe(
				'EmptyLabelMutation',
			);
			expect(
				(
					await act(deps, {
						ids: Array.from({ length: 501 }, (_, i) => `m${i}`),
						removeLabels: ['INBOX'],
					})
				).error?.name,
			).toBe('TooManyMessageIds');
		} finally {
			cleanup();
		}
	});
});
