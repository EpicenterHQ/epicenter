import type { PendingApproval, ThreadSummary } from './api-types.js';

export function approvalEntries(
	approvals: PendingApproval[],
	threads: ReadonlyMap<string, ThreadSummary>,
	excludeThreadId: string | null = null,
) {
	return approvals
		.filter((approval) => approval.threadId !== excludeThreadId)
		.map((approval) => ({
			approval,
			title: threads.get(approval.threadId)?.title ?? 'Unknown conversation',
		}));
}
