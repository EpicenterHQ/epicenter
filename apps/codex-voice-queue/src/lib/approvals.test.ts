/** Approval entries remain reachable outside filters, with titles and current-thread exclusion. */
import { expect, test } from 'bun:test';
import type { PendingApproval, ThreadSummary } from './api-types.js';
import { approvalEntries } from './approvals.js';

test('approval entries include hidden threads and exclude only the current thread', () => {
	const approval = (threadId: string): PendingApproval => ({
		id: threadId,
		requestId: 1,
		method: '',
		threadId,
		turnId: '',
		itemId: '',
		kind: 'command',
		changes: null,
		changesTruncated: false,
		createdAt: 0,
	});
	const thread: ThreadSummary = {
		id: 'hidden',
		title: 'Hidden thread',
		preview: '',
		cwd: '/',
		source: 'cli',
		createdAt: 0,
		updatedAt: 0,
		status: { type: 'idle' },
		gitBranch: null,
	};
	expect(
		approvalEntries(
			[approval('current'), approval('hidden'), approval('missing')],
			new Map([['hidden', thread]]),
			'current',
		).map((entry) => entry.title),
	).toEqual(['Hidden thread', 'Unknown conversation']);
});
