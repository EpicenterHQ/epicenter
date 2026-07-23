export const HOME_PROPOSAL_LENSES = [
	'chat',
	'honeycrisp',
	'whispering',
] as const;

export type HomeProposalLens = (typeof HOME_PROPOSAL_LENSES)[number];

export type HomeProposal =
	| {
			id: string;
			path: string;
			proposalId: string;
			sourceReplicaId: string;
			sourceAuthorityLifetime: string | null;
			state: 'draft' | 'compiled';
			changeCount: number;
			appliedCount: number;
	  }
	| { id: string; path: string; state: 'invalid'; message: string };

export type HomeProposalLensCatalogEntry = {
	id: HomeProposalLens;
	title: string;
	description: string;
	namespace: string;
	collections: (
		| { key: string; title: string; kind: 'table' }
		| { key: string; title: string; kind: 'values'; recordKeys: string[] }
	)[];
};

export type HomeProposalCatalog = {
	lenses: HomeProposalLensCatalogEntry[];
	proposals: HomeProposal[];
};

export function isHomeProposalLens(value: unknown): value is HomeProposalLens {
	return HOME_PROPOSAL_LENSES.some((lens) => lens === value);
}
