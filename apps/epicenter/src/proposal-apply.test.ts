import { expect, test } from 'bun:test';
import { applyProposalWithStatusRecovery } from './proposal-apply.ts';
import type { HomeProposalCatalog } from './proposal-contract.ts';

test('a partially admitted Apply rejection refreshes authenticated status', async () => {
	const catalog = {
		lenses: [],
		proposals: [
			{
				id: 'a'.repeat(24),
				path: '/tmp/proposal.sqlite3',
				proposalId: 'a'.repeat(24),
				sourceReplicaId: 'r'.repeat(24),
				sourceAuthorityLifetime: null,
				state: 'compiled',
				changeCount: 3,
				appliedCount: 1,
			},
		],
	} satisfies HomeProposalCatalog;
	const calls: string[] = [];
	const failure = new Error('second change collided');

	const outcome = await applyProposalWithStatusRecovery(
		async () => {
			calls.push('apply');
			throw failure;
		},
		async () => {
			calls.push('refresh');
			return catalog;
		},
	);

	expect(calls).toEqual(['apply', 'refresh']);
	expect(outcome).toEqual({ ok: false, cause: failure, catalog });
});

test('a failed status refresh reports that no reconciled catalog is available', async () => {
	const failure = new Error('second change collided');
	const refreshFailure = new Error('catalog unavailable');

	const outcome = await applyProposalWithStatusRecovery(
		async () => {
			throw failure;
		},
		async () => {
			throw refreshFailure;
		},
	);

	expect(outcome).toEqual({ ok: false, cause: failure });
});
