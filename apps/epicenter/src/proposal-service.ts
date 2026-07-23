import type { DesktopRecordEpicenterOwner } from '@epicenter/data/desktop-record-owner';
import {
	type LensDefinition,
	parseProposalSelection,
} from '@epicenter/data/record';
import {
	HOME_PROPOSAL_LENSES,
	type HomeProposal,
	type HomeProposalCatalog,
	type HomeProposalLens,
	type HomeProposalLensCatalogEntry,
} from './proposal-contract.ts';

type ProposalOwner = Pick<
	DesktopRecordEpicenterOwner,
	| 'proposals'
	| 'createProposal'
	| 'compileProposal'
	| 'applyProposal'
	| 'deleteProposal'
>;

type ProposalServiceOptions = {
	owner: ProposalOwner;
	lenses: Record<HomeProposalLens, LensDefinition>;
};

/** Own Home's Lens catalog and its trusted desktop Proposal workflow. */
export function createProposalService({
	owner,
	lenses,
}: ProposalServiceOptions) {
	const lensCatalog = HOME_PROPOSAL_LENSES.map((id) => {
		const lens = lenses[id];
		return {
			id,
			title: lens.title,
			description: lens.description,
			namespace: lens.namespace,
			collections: Object.entries(lens.collections).map(([key, definition]) =>
				definition.kind === 'table'
					? { key, title: definition.title, kind: definition.kind }
					: {
							key,
							title: definition.title,
							kind: definition.kind,
							recordKeys: Object.keys(definition.values).sort(),
						},
			),
		} satisfies HomeProposalLensCatalogEntry;
	});

	return Object.freeze({
		async list(): Promise<HomeProposalCatalog> {
			return {
				lenses: structuredClone(lensCatalog),
				proposals: await owner.proposals(),
			};
		},
		async create({
			lens: lensId,
			selection,
		}: {
			lens: HomeProposalLens;
			selection: unknown;
		}): Promise<HomeProposal> {
			const lens = lenses[lensId];
			return owner.createProposal({
				lens,
				selection: parseProposalSelection(lens, selection),
			});
		},
		compile(id: string): Promise<HomeProposal> {
			return owner.compileProposal(id);
		},
		apply(
			id: string,
		): Promise<{ proposalId: string; admittedChanges: number }> {
			return owner.applyProposal(id);
		},
		delete(id: string): Promise<void> {
			return owner.deleteProposal(id);
		},
	});
}

export type ProposalService = ReturnType<typeof createProposalService>;
