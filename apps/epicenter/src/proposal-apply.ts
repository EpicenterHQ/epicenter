import type { HomeProposalCatalog } from './proposal-contract.ts';

export type HomeProposalApplyResult = {
	proposalId: string;
	admittedChanges: number;
};

export type HomeProposalApplyOutcome =
	| { ok: true; result: HomeProposalApplyResult }
	| { ok: false; cause: unknown; catalog?: HomeProposalCatalog };

/**
 * Refresh authenticated artifact status after a rejected Apply. Apply is
 * incremental, so a rejection may still follow one or more admitted writes.
 */
export async function applyProposalWithStatusRecovery(
	apply: () => Promise<HomeProposalApplyResult>,
	refresh: () => Promise<HomeProposalCatalog>,
): Promise<HomeProposalApplyOutcome> {
	try {
		return { ok: true, result: await apply() };
	} catch (cause) {
		try {
			return { ok: false, cause, catalog: await refresh() };
		} catch {
			return { ok: false, cause };
		}
	}
}
