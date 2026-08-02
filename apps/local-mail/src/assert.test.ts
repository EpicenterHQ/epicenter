/**
 * The act path: turning a triage intent into durable local state, and nothing
 * else. What these pin down:
 *
 * - An act is offline. It resolves label names against the mirror and never
 *   calls Gmail, so `deps` here carries no client at all.
 * - Assertions record DIVERGENCE from Gmail's facts, so asking for what Gmail
 *   already has cancels a pending act instead of queueing an opposite one.
 * - The read-only gate refuses before anything is recorded.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type AssertDeps, assertMessageLabels } from './assert.ts';
import { openMailDb } from './db.ts';
import { openIntentDb } from './intent.ts';
import type { GmailMessage } from './schema.ts';

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

function setup(
	messages: GmailMessage[] = [message('m1', ['INBOX', 'UNREAD'])],
): {
	deps: AssertDeps;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), 'local-mail-assert-'));
	const db = openMailDb({ dataDir: dir, accountEmail: 'you@example.com' });
	const intent = openIntentDb({
		dataDir: dir,
		accountEmail: 'you@example.com',
	});
	const syncedAt = '2026-08-01T00:00:00.000Z';
	db.ingestFullPullPage(messages, syncedAt);
	db.ingestLabels(
		[
			{ id: 'INBOX', name: 'INBOX', type: 'system' },
			{ id: 'UNREAD', name: 'UNREAD', type: 'system' },
			{ id: 'TRASH', name: 'TRASH', type: 'system' },
			{ id: 'Label_7', name: 'Altered Trajectories', type: 'user' },
		],
		syncedAt,
	);
	return {
		deps: { db, intent },
		cleanup: () => {
			intent.close();
			db.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

const act = (
	deps: AssertDeps,
	input: { ids: string[]; addLabels?: string[]; removeLabels?: string[] },
	readOnly = false,
) =>
	assertMessageLabels({
		deps,
		input: {
			ids: input.ids,
			addLabels: input.addLabels ?? [],
			removeLabels: input.removeLabels ?? [],
		},
		readOnly,
	});

describe('assertMessageLabels', () => {
	test('archiving a mirrored inbox message records one assertion', () => {
		const { deps, cleanup } = setup();
		try {
			const { data, error } = act(deps, {
				ids: ['m1'],
				removeLabels: ['INBOX'],
			});
			expect(error).toBeNull();
			expect(data).toEqual({ asserted: 1, withdrawn: 0 });
			expect(deps.intent.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'INBOX', want: false },
			]);
		} finally {
			cleanup();
		}
	});

	test('the inverse act before delivery cancels the assertion outright', () => {
		const { deps, cleanup } = setup();
		try {
			act(deps, { ids: ['m1'], removeLabels: ['INBOX'] });
			const { data } = act(deps, { ids: ['m1'], addLabels: ['INBOX'] });

			// Gmail's fact is still INBOX, so wanting INBOX is not a divergence: the
			// pending act disappears and Gmail is never told about either half.
			expect(data).toEqual({ asserted: 0, withdrawn: 1 });
			expect(deps.intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('asking for what Gmail already has records nothing', () => {
		const { deps, cleanup } = setup();
		try {
			const { data } = act(deps, { ids: ['m1'], addLabels: ['INBOX'] });
			expect(data).toEqual({ asserted: 0, withdrawn: 0 });
			expect(deps.intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('label names resolve to ids at act time', () => {
		const { deps, cleanup } = setup();
		try {
			act(deps, { ids: ['m1'], addLabels: ['Altered Trajectories'] });
			expect(deps.intent.pending()).toMatchObject([
				{ messageId: 'm1', labelId: 'Label_7', want: true },
			]);
		} finally {
			cleanup();
		}
	});

	test('an unknown label name is refused and records nothing', () => {
		const { deps, cleanup } = setup();
		try {
			const { error } = act(deps, { ids: ['m1'], addLabels: ['Nope'] });
			expect(error?.name).toBe('UnknownLabel');
			expect(deps.intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('read-only refuses before anything is recorded', () => {
		const { deps, cleanup } = setup();
		try {
			const { error } = act(
				deps,
				{ ids: ['m1'], removeLabels: ['INBOX'] },
				true,
			);
			expect(error?.name).toBe('ReadOnly');
			expect(deps.intent.pending()).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test('an act over several ids snapshots exactly those ids', () => {
		const { deps, cleanup } = setup([
			message('m1', ['INBOX']),
			message('m2', ['INBOX']),
			message('m3', ['INBOX']),
		]);
		try {
			act(deps, { ids: ['m1', 'm2'], removeLabels: ['INBOX'] });
			// m3 arrived in the same view and the same thread; it was not acted on,
			// so nothing about it is owed.
			expect(deps.intent.pending().map((i) => i.messageId)).toEqual([
				'm1',
				'm2',
			]);
		} finally {
			cleanup();
		}
	});

	test('an id the mirror has never seen is asserted, not cancelled', () => {
		const { deps, cleanup } = setup();
		try {
			const { data } = act(deps, { ids: ['ghost'], removeLabels: ['INBOX'] });
			// There is no fact to agree with, so the wish stands and gets delivered.
			expect(data).toEqual({ asserted: 1, withdrawn: 0 });
		} finally {
			cleanup();
		}
	});

	test('empty and oversized acts are refused', () => {
		const { deps, cleanup } = setup();
		try {
			expect(act(deps, { ids: [], removeLabels: ['INBOX'] }).error?.name).toBe(
				'NoMessageIds',
			);
			expect(act(deps, { ids: ['m1'] }).error?.name).toBe('EmptyLabelMutation');
			expect(
				act(deps, {
					ids: Array.from({ length: 501 }, (_, i) => `m${i}`),
					removeLabels: ['INBOX'],
				}).error?.name,
			).toBe('TooManyMessageIds');
		} finally {
			cleanup();
		}
	});
});
