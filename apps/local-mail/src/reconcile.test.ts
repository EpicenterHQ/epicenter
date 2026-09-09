/**
 * The reconciler's drain phase: the only place in Local Mail that writes to
 * Gmail. These pin the delivery contract:
 *
 * - One message's opinions become ONE `messages.modify`, with trash routed to
 *   Gmail's own endpoint at delivery and never smuggled into a label set.
 * - Retirement requires the revision that was delivered, so an act made while a
 *   delivery is in flight survives it.
 * - A refused request is retried one assertion at a time before anything is
 *   resolved, so one impossible label cannot discard the archive that shared its
 *   call; a systemic failure stops delivery and keeps every assertion, with
 *   nothing written down about the failure itself.
 * - An act made mid-delivery wins, because retirement matches the revision that
 *   was actually proved.
 * - Read-only skips delivery entirely.
 *
 * The pull phase is `sync.ts`, tested there; the fake client below returns an
 * empty history so a pass ends quickly.
 */

import { describe, expect, test } from 'bun:test';
import type { MailSession } from './accounts.ts';
import { assertMessageLabels } from './assert.ts';
import { GmailApiError, type GmailClient } from './gmail-client.ts';
import type { IntentStore } from './intent-store.ts';
import { openIntentStore } from './intent-store.ts';
import { type Mailbox, openMailbox, overlayOf } from './mailbox.ts';
import { openPassRecord } from './outbox.ts';
import { reconcileAccount } from './reconcile.ts';
import type { GmailLabel, GmailMessage, HistoryPage } from './schema.ts';
import { openTestSession, type TestSession } from './session.test-support.ts';

const ACCOUNT_ID = 'account-one';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

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

type WriteResult =
	| { data: GmailMessage }
	| {
			error: NonNullable<
				Awaited<ReturnType<GmailClient['modifyMessage']>>['error']
			>;
	  };

type FakeGmail = GmailClient & {
	modifyCalls: {
		id: string;
		addLabelIds: string[];
		removeLabelIds: string[];
	}[];
	trashCalls: string[];
	untrashCalls: string[];
	/** The scripted per-id results, exposed so a test can change Gmail's answer
	 * between two passes. */
	results: Map<string, WriteResult>;
};

const MIRRORED_LABELS: GmailLabel[] = [
	{ id: 'INBOX', name: 'INBOX', type: 'system' },
	{ id: 'UNREAD', name: 'UNREAD', type: 'system' },
	{ id: 'STARRED', name: 'STARRED', type: 'system' },
	{ id: 'TRASH', name: 'TRASH', type: 'system' },
];

/**
 * A Gmail client whose write endpoints are scripted per message id and whose
 * read endpoints report an unchanged mailbox, so the pull phase is a no-op.
 *
 * `onWrite` fires before the scripted result is returned, which is how the
 * racing-act tests slip a real triage act into the middle of a delivery.
 * `onModify` answers by request body rather than by id, which is how the
 * splitting test makes one label acceptable and another not.
 */
function fakeGmail(
	results: Map<string, WriteResult>,
	hooks: {
		/** Awaited, so a racing act can be a real (asynchronous) act. */
		onWrite?: (id: string) => void | Promise<void>;
		onModify?: (body: {
			addLabelIds: string[];
			removeLabelIds: string[];
		}) => WriteResult | null;
	} = {},
): FakeGmail {
	const modifyCalls: FakeGmail['modifyCalls'] = [];
	const trashCalls: string[] = [];
	const untrashCalls: string[] = [];
	const answer = (result: WriteResult) =>
		'error' in result
			? { data: null, error: result.error }
			: { data: result.data, error: null };
	const lookup = async (id: string) => {
		await hooks.onWrite?.(id);
		const result = results.get(id);
		if (!result) return GmailApiError.Http({ status: 404, body: 'not found' });
		return answer(result);
	};
	return {
		modifyCalls,
		trashCalls,
		untrashCalls,
		results,
		async modifyMessage(id, body) {
			modifyCalls.push({ id, ...body });
			const scripted = hooks.onModify?.(body);
			if (scripted) {
				await hooks.onWrite?.(id);
				return answer(scripted);
			}
			return lookup(id);
		},
		async trashMessage(id) {
			trashCalls.push(id);
			return lookup(id);
		},
		async untrashMessage(id) {
			untrashCalls.push(id);
			return lookup(id);
		},
		async listMessageIds() {
			return { data: { ids: [] }, error: null };
		},
		async getMessage() {
			return GmailApiError.Http({ status: 404, body: 'not found' });
		},
		async listHistory(): Promise<{ data: HistoryPage; error: null }> {
			return { data: { historyId: '1' }, error: null };
		},
		async listLabels(): Promise<{ data: GmailLabel[]; error: null }> {
			// The pull phase replaces the mirrored label set with whatever this
			// returns, so hand back the seeded one rather than emptying the table
			// underneath a later act.
			return { data: MIRRORED_LABELS, error: null };
		},
		async getProfile() {
			return { data: { historyId: '1' }, error: null };
		},
	};
}

async function setup(
	client: GmailClient,
	messages: GmailMessage[] = [message('m1', ['INBOX', 'UNREAD'])],
): Promise<{
	deps: MailSession;
	session: TestSession;
	mailbox: Mailbox;
	intents: IntentStore;
	cleanup: () => void;
}> {
	const session = await openTestSession(ACCOUNT_ID);
	const syncedAt = new Date(NOW).toISOString();
	await session.mailbox.ingestFullPullPage(messages, syncedAt);
	await session.mailbox.ingestLabels(MIRRORED_LABELS);
	// A cursor plus a recent sync keeps the pull phase INCREMENTAL, so these
	// tests exercise delivery rather than a full backfill.
	await session.mailbox.finishFullPull('1', syncedAt);
	return {
		deps: {
			mailbox: session.mailbox,
			intents: session.intents,
			passes: session.passes,
			client,
			now: () => NOW,
			sub: ACCOUNT_ID,
		},
		session,
		mailbox: session.mailbox,
		intents: session.intents,
		cleanup: session.close,
	};
}

/**
 * One pass over one account's session.
 *
 * Production reaches this through `reconcileNow`, which adds only the joining
 * of a second caller to a pass already in flight; that is `accounts.test.ts`'
 * subject, and everything below is about what a single pass does.
 */
const pass = (deps: MailSession) => reconcileAccount(deps);

/** Gmail's facts for one message, straight out of the cache column, with no
 * intent overlay: what the reconciler folded, not what a reader would see. */
async function mirroredLabels(
	session: TestSession,
	id: string,
): Promise<string[]> {
	const row = await session.row<{ label_ids: string | null }>(
		`SELECT label_ids FROM messages WHERE id = ?`,
		[id],
	);
	return JSON.parse(row?.label_ids ?? '[]') as string[];
}

describe('drain', () => {
	test('one message with several opinions becomes one modify call', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['STARRED']) }]]),
		);
		const { deps, intents, cleanup } = await setup(client);
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm1', labelId: 'UNREAD', want: false },
					{ messageId: 'm1', labelId: 'STARRED', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(client.modifyCalls).toEqual([
				{
					id: 'm1',
					addLabelIds: ['STARRED'],
					removeLabelIds: ['INBOX', 'UNREAD'],
				},
			]);
			expect(delivery).toMatchObject({
				pending: 3,
				delivered: 3,
				retained: 0,
				failure: null,
			});
			expect(await intents.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("Gmail's response updates the mirror before the assertion is retired", async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
		);
		const { deps, session, cleanup } = await setup(client);
		try {
			await deps.intents.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				new Date(NOW).toISOString(),
			);
			await pass(deps);
			// The overlay is gone and the fact took its place, so the row never
			// flickers back into the inbox between the two writes.
			expect(await mirroredLabels(session, 'm1')).toEqual(['UNREAD']);
			expect(
				await deps.mailbox.listMessages({
					labelId: 'INBOX',
					limit: 10,
					offset: 0,
					overlay: overlayOf(await deps.intents.pending()),
				}),
			).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a TRASH assertion routes to messages.trash and stays out of the label set', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['TRASH']) }]]),
		);
		const { deps, intents, cleanup } = await setup(client);
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'UNREAD', want: false },
					{ messageId: 'm1', labelId: 'TRASH', want: true },
				],
				new Date(NOW).toISOString(),
			);

			await pass(deps);

			expect(client.trashCalls).toEqual(['m1']);
			expect(client.untrashCalls).toEqual([]);
			// Labels are delivered first, and TRASH never appears in either set.
			expect(client.modifyCalls).toEqual([
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['UNREAD'] },
			]);
			expect(await intents.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a TRASH assertion of want=false routes to messages.untrash', async () => {
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['INBOX']) }]]),
		);
		const { deps, intents, cleanup } = await setup(client, [
			message('m1', ['TRASH']),
		]);
		try {
			await intents.assert(
				[{ messageId: 'm1', labelId: 'TRASH', want: false }],
				new Date(NOW).toISOString(),
			);
			await pass(deps);
			expect(client.untrashCalls).toEqual(['m1']);
			expect(client.modifyCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('restoring from trash happens BEFORE the label changes it enables', async () => {
		// The case that made this ordering non-negotiable. A message sits in Gmail
		// Trash, carrying none of the labels a modify would touch, and the user
		// asks for both "restore" and "archive". Delivered labels-first, the modify
		// is a no-op against a trashed message and the untrash then puts INBOX
		// back: both assertions retire and the archive is silently lost.
		const order: string[] = [];
		const client = fakeGmail(new Map(), {
			onWrite: () => undefined,
			onModify: () => {
				order.push('modify');
				return { data: message('m1', ['UNREAD']) };
			},
		});
		const untrashed = client.untrashMessage.bind(client);
		client.untrashMessage = async (id: string) => {
			order.push('untrash');
			return untrashed(id);
		};
		const { deps, intents, session, cleanup } = await setup(client, [
			message('m1', ['TRASH']),
		]);
		client.results.set('m1', { data: message('m1', ['INBOX', 'UNREAD']) });
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'TRASH', want: false },
					{ messageId: 'm1', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(order).toEqual(['untrash', 'modify']);
			expect(client.modifyCalls).toEqual([
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
			]);
			expect(delivery).toMatchObject({ pending: 2, delivered: 2, retained: 0 });
			// Both wishes held: out of Trash, and out of the inbox.
			expect(await mirroredLabels(session, 'm1')).toEqual(['UNREAD']);
			expect(await intents.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('moving to trash happens AFTER the label changes it would swallow', async () => {
		const order: string[] = [];
		const client = fakeGmail(new Map(), {
			onModify: () => {
				order.push('modify');
				return { data: message('m1', ['STARRED', 'UNREAD']) };
			},
		});
		const trashed = client.trashMessage.bind(client);
		client.trashMessage = async (id: string) => {
			order.push('trash');
			return trashed(id);
		};
		const { deps, intents, cleanup } = await setup(client);
		client.results.set('m1', { data: message('m1', ['TRASH']) });
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'TRASH', want: true },
					{ messageId: 'm1', labelId: 'STARRED', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			// The star is applied while the message can still carry it, then it goes
			// to Trash. Reversed, the star would land on a trashed message.
			expect(order).toEqual(['modify', 'trash']);
			expect(delivery).toMatchObject({ pending: 2, delivered: 2, retained: 0 });
		} finally {
			cleanup();
		}
	});

	test('a re-assert during the untrash keeps the newer wish and still delivers the labels', async () => {
		let store: IntentStore | undefined;
		let reasserted = false;
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['INBOX']) }]]),
			{
				onWrite: async () => {
					// The user changes their mind about trash while the untrash is on the
					// wire; the archive they also asked for is untouched by that.
					if (reasserted) return;
					reasserted = true;
					await store?.assert(
						[{ messageId: 'm1', labelId: 'TRASH', want: true }],
						new Date(NOW).toISOString(),
					);
				},
			},
		);
		const created = await setup(client, [message('m1', ['TRASH'])]);
		const { intents } = created;
		store = intents;
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'TRASH', want: false },
					{ messageId: 'm1', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(created.deps);

			expect(client.untrashCalls).toEqual(['m1']);
			// The untrash proved the old revision and retires nothing; the archive is
			// unrelated and lands.
			expect(delivery).toMatchObject({ pending: 2, delivered: 1, retained: 1 });
			expect(await intents.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'TRASH', want: true },
			]);
		} finally {
			created.cleanup();
		}
	});

	test("a group past Gmail's per-request label cap still lands, one at a time", async () => {
		// The act path caps ONE act at 100 labels per direction; two acts can still
		// accumulate past it for the same message. Nothing pre-empts that: Gmail
		// refuses the oversized request and the split retry delivers every
		// assertion individually.
		const client = fakeGmail(new Map(), {
			onModify: (body) =>
				body.addLabelIds.length > 100
					? {
							error: GmailApiError.Http({
								status: 400,
								body: 'Too many labels',
							}).error,
						}
					: { data: message('m1', ['INBOX']) },
		});
		const { deps, intents, cleanup } = await setup(client);
		try {
			await intents.assert(
				Array.from({ length: 101 }, (_, i) => ({
					messageId: 'm1',
					labelId: `Label_${i}`,
					want: true,
				})),
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			// One refused group, then 101 single-assertion deliveries.
			expect(client.modifyCalls).toHaveLength(102);
			expect(delivery).toMatchObject({
				pending: 101,
				delivered: 101,
				discarded: [],
				retained: 0,
			});
			expect(await intents.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('archive then undo, racing an in-flight drain, keeps the undo', async () => {
		// The whole point of revision matching, driven through the public act path rather
		// than the store: the user archives, the drain picks it up, and the undo
		// lands while that delivery is on the wire.
		let undo: (() => Promise<void>) | null = null;
		const client = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
			{ onWrite: () => undo?.() },
		);
		const created = await setup(client);
		const { deps, intents, session, cleanup } = created;
		try {
			const archive = () =>
				assertMessageLabels({
					deps,
					input: { ids: ['m1'], addLabels: [], removeLabels: ['INBOX'] },
				});
			const unarchive = () =>
				assertMessageLabels({
					deps,
					input: { ids: ['m1'], addLabels: ['INBOX'], removeLabels: [] },
				});

			expect((await archive()).error).toBeNull();
			undo = async () => {
				undo = null;
				expect((await unarchive()).error).toBeNull();
			};

			const first = await pass(deps);

			// Gmail was told to archive, and answered. But the undo carries a newer
			// revision, so that answer proves nothing about it: nothing is retired,
			// and the mailbox the user sees is back in the inbox on the strength of
			// the still-pending assertion.
			expect(client.modifyCalls).toEqual([
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
			]);
			expect(first.delivery).toMatchObject({
				pending: 1,
				delivered: 0,
				retained: 1,
			});
			expect(await mirroredLabels(session, 'm1')).toEqual(['UNREAD']);
			expect(
				(
					await deps.mailbox.listMessages({
						labelId: 'INBOX',
						limit: 10,
						offset: 0,
						overlay: overlayOf(await deps.intents.pending()),
					})
				).map((r) => r.id),
			).toEqual(['m1']);

			// The next pass delivers the undo. That second call is the redundant
			// modify this design accepts: one wasted request, and no lost choice.
			client.results.set('m1', { data: message('m1', ['INBOX', 'UNREAD']) });
			const second = await pass(deps);

			expect(client.modifyCalls).toHaveLength(2);
			expect(client.modifyCalls[1]).toEqual({
				id: 'm1',
				addLabelIds: ['INBOX'],
				removeLabelIds: [],
			});
			expect(second.delivery).toMatchObject({ delivered: 1, retained: 0 });
			expect(await intents.pending()).toEqual([]);
			expect(await mirroredLabels(session, 'm1')).toEqual(['INBOX', 'UNREAD']);
		} finally {
			cleanup();
		}
	});

	test('a rejected group is retried one assertion at a time', async () => {
		// Gmail refuses the request because of ONE label in it. Retiring the whole
		// group on that basis would throw away the archive the user also asked for,
		// so the group is split and only the individually rejected pair resolves.
		const client = fakeGmail(new Map(), {
			onModify: (body) =>
				body.addLabelIds.includes('Label_gone')
					? {
							error: GmailApiError.Http({
								status: 400,
								body: 'Invalid label: Label_gone',
							}).error,
						}
					: { data: message('m1', ['UNREAD']) },
		});
		const { deps, intents, session, cleanup } = await setup(client);
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm1', labelId: 'Label_gone', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			// One grouped attempt, then one attempt per assertion.
			expect(client.modifyCalls).toEqual([
				{
					id: 'm1',
					addLabelIds: ['Label_gone'],
					removeLabelIds: ['INBOX'],
				},
				{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
				{ id: 'm1', addLabelIds: ['Label_gone'], removeLabelIds: [] },
			]);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 1,
				retained: 0,
				failure: null,
			});
			// The refusal is reported for this pass and nowhere else: the message,
			// the label, the presence that was wanted, and Gmail's own words.
			expect(delivery.discarded).toEqual([
				{
					messageId: 'm1',
					labelId: 'Label_gone',
					want: true,
					status: 400,
					reason: expect.stringContaining('Invalid label: Label_gone'),
				},
			]);
			expect(await intents.pending()).toEqual([]);
			// The archive really landed; only the impossible label was dropped.
			expect(await mirroredLabels(session, 'm1')).toEqual(['UNREAD']);
		} finally {
			cleanup();
		}
	});

	test('a systemic failure during a split retry stops the pass and keeps everything', async () => {
		let attempts = 0;
		const client = fakeGmail(new Map(), {
			onModify: () => {
				attempts += 1;
				// The group is refused, and the first split retry hits a throttle.
				return attempts === 1
					? {
							error: GmailApiError.Http({ status: 400, body: 'bad request' })
								.error,
						}
					: {
							error: GmailApiError.Throttled({
								retries: 5,
								status: 429,
								body: 'Too many requests',
							}).error,
						};
			},
		});
		const { deps, intents, cleanup } = await setup(client);
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm1', labelId: 'STARRED', want: true },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(delivery.failure?.name).toBe('Throttled');
			expect(delivery).toMatchObject({
				delivered: 0,
				discarded: [],
				retained: 2,
			});
			expect(await intents.pending()).toHaveLength(2);
		} finally {
			cleanup();
		}
	});

	test('a per-target refusal resolves that assertion and delivery continues', async () => {
		const client = fakeGmail(
			new Map<string, WriteResult>([
				[
					'm1',
					{ error: GmailApiError.Http({ status: 404, body: 'gone' }).error },
				],
				['m2', { data: message('m2', []) }],
			]),
		);
		const { deps, intents, cleanup } = await setup(client, [
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
		]);
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm2', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery } = await pass(deps);

			expect(client.modifyCalls.map((call) => call.id)).toEqual(['m1', 'm2']);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 1,
				retained: 0,
				failure: null,
			});
			// The refusal is reported for this pass and nowhere else: the message,
			// the label, the presence that was wanted, and Gmail's own words.
			expect(delivery.discarded).toEqual([
				{
					messageId: 'm1',
					labelId: 'INBOX',
					want: false,
					status: 404,
					reason: expect.stringContaining('Gmail API returned 404'),
				},
			]);
			// Nothing about the refusal is written down: the store holds wishes, not
			// a dead-letter queue, and the report above is the whole record of it.
			expect(await intents.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('a systemic failure stops delivery and keeps every undelivered assertion', async () => {
		const client = fakeGmail(
			new Map<string, WriteResult>([
				[
					'm1',
					{
						error: GmailApiError.Throttled({
							retries: 5,
							status: 429,
							body: 'Too many requests',
						}).error,
					},
				],
				['m2', { data: message('m2', []) }],
			]),
		);
		const { deps, intents, cleanup } = await setup(client, [
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
		]);
		try {
			await intents.assert(
				[
					{ messageId: 'm1', labelId: 'INBOX', want: false },
					{ messageId: 'm2', labelId: 'INBOX', want: false },
				],
				new Date(NOW).toISOString(),
			);

			const { delivery, pull } = await pass(deps);

			// m2 was never attempted: the connection, not the target, is the problem.
			expect(client.modifyCalls.map((call) => call.id)).toEqual(['m1']);
			expect(delivery).toMatchObject({
				pending: 2,
				delivered: 0,
				discarded: [],
				retained: 2,
			});
			expect(delivery.failure?.name).toBe('Throttled');
			expect(await intents.pending()).toHaveLength(2);
			// The pull still runs: a failure to write is not a reason to stop reading.
			expect(pull.failure).toBeNull();
		} finally {
			cleanup();
		}
	});

	test('a pass with nothing pending calls no write endpoint at all', async () => {
		const client = fakeGmail(new Map());
		const { deps, cleanup } = await setup(client);
		try {
			const { delivery } = await pass(deps);
			expect(delivery).toEqual({
				pending: 0,
				delivered: 0,
				discarded: [],
				retained: 0,
				failure: null,
			});
			expect(client.modifyCalls).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("folding Gmail's answer", () => {
	test('an omitted labelIds is folded as an empty set, not skipped', async () => {
		// Gmail's JSON encoding omits empty repeated fields, so removing a message's
		// last label comes back as a Message with no `labelIds` key at all. Treating
		// that as "no answer" and skipping the fold would retire the assertion while
		// the mirror still claimed the old label, and the next pull is exactly what
		// fails when anything is wrong, so the stale fact would resurface.
		const client = fakeGmail(
			new Map([['m1', { data: { id: 'm1', threadId: 't-m1' } }]]),
		);
		const { deps, session, intents, cleanup } = await setup(client, [
			message('m1', ['INBOX']),
		]);
		try {
			await intents.assert(
				[{ messageId: 'm1', labelId: 'INBOX', want: false }],
				new Date(NOW).toISOString(),
			);

			const outcome = await pass(deps);
			expect(outcome.delivery.delivered).toBe(1);
			expect(await intents.pending()).toEqual([]);

			// Gmail's answer, folded: the message carries nothing now.
			expect(await mirroredLabels(session, 'm1')).toEqual([]);
			// And with the assertion retired there is no overlay left to hide the row,
			// so this is the whole of what keeps it out of the inbox.
			expect(
				await deps.mailbox.listMessages({
					labelId: 'INBOX',
					limit: 10,
					offset: 0,
					overlay: overlayOf(await deps.intents.pending()),
				}),
			).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe('across a restart', () => {
	test('an act made offline survives the process and lands on the next pass', async () => {
		// The product headline, end to end: archive on a plane, quit, reopen on the
		// ground, and the archive reaches Gmail. Everything else in this file tests
		// one seam; this tests that the seams hold across the only event the design
		// exists to survive, which is the surface going away between the act and
		// the delivery.
		//
		// A restart is modelled as two sets of handles over the same two databases,
		// because that is exactly what it is: the databases are what survives, and
		// `openMailbox` and `openIntentStore` hold no state of their own.
		const session = await openTestSession(ACCOUNT_ID);
		const syncedAt = new Date(NOW).toISOString();
		await session.mailbox.ingestFullPullPage(
			[message('m1', ['INBOX', 'UNREAD'])],
			syncedAt,
		);
		await session.mailbox.ingestLabels(MIRRORED_LABELS);
		await session.mailbox.finishFullPull('1', syncedAt);

		// Session one: offline. Every Gmail write fails with a network error, which
		// is systemic, so nothing may be retired and nothing may be written down
		// about the failure.
		const offline = fakeGmail(new Map());
		offline.modifyMessage = async () =>
			GmailApiError.Network({ cause: new Error('offline') });
		const firstDeps: MailSession = {
			mailbox: session.mailbox,
			intents: session.intents,
			passes: session.passes,
			client: offline,
			now: () => NOW,
			sub: ACCOUNT_ID,
		};

		expect(
			(
				await assertMessageLabels({
					deps: firstDeps,
					input: { ids: ['m1'], addLabels: [], removeLabels: ['INBOX'] },
				})
			).error,
		).toBeNull();
		// The act is already true for every reader, before Gmail has heard.
		expect(
			await session.mailbox.listMessages({
				labelId: 'INBOX',
				limit: 10,
				offset: 0,
				overlay: overlayOf(await session.intents.pending()),
			}),
		).toEqual([]);

		const offlinePass = await pass(firstDeps);
		expect(offlinePass.delivery.delivered).toBe(0);
		expect(offlinePass.delivery.retained).toBe(1);
		expect(offlinePass.delivery.failure).not.toBeNull();
		expect(offlinePass.delivery.discarded).toEqual([]);

		// Session two: fresh handles over the same durable databases, as a new
		// window would open, and Gmail is reachable again.
		const online = fakeGmail(
			new Map([['m1', { data: message('m1', ['UNREAD']) }]]),
		);
		const restarted = openMailbox(session.mailboxDatabase);
		const restartedIntents = openIntentStore(session.localDatabase, ACCOUNT_ID);
		const restartedPasses = openPassRecord(session.localDatabase, ACCOUNT_ID);
		const secondDeps: MailSession = {
			mailbox: restarted,
			intents: restartedIntents,
			passes: restartedPasses,
			client: online,
			now: () => NOW,
			sub: ACCOUNT_ID,
		};

		// The change was still owed when the new handles opened.
		expect(await restartedIntents.count()).toBe(1);

		const landed = await pass(secondDeps);
		expect(landed.delivery.delivered).toBe(1);
		expect(landed.delivery.retained).toBe(0);
		expect(landed.delivery.failure).toBeNull();
		expect(online.modifyCalls).toEqual([
			{ id: 'm1', addLabelIds: [], removeLabelIds: ['INBOX'] },
		]);
		// Gmail's own answer is now the cache's fact, and nothing is overlaid on
		// it any more, so the reader's answer is unchanged by the delivery.
		expect(await mirroredLabels(session, 'm1')).toEqual(['UNREAD']);
		expect(
			await restarted.listMessages({
				labelId: 'INBOX',
				limit: 10,
				offset: 0,
				overlay: overlayOf(await restartedIntents.pending()),
			}),
		).toEqual([]);

		session.close();
	});
});
