/** The single portable owner of the four physical layout candidates. */

export type RelationLayout = 'unified' | 'split';
export type CoordinateLayout = 'inline' | 'normalized';

export type Candidate = {
	id: string;
	relation: RelationLayout;
	coordinates: CoordinateLayout;
};

export const CANDIDATES: readonly Candidate[] = [
	{ id: 'unified-inline', relation: 'unified', coordinates: 'inline' },
	{ id: 'unified-normalized', relation: 'unified', coordinates: 'normalized' },
	{ id: 'split-inline', relation: 'split', coordinates: 'inline' },
	{ id: 'split-normalized', relation: 'split', coordinates: 'normalized' },
];

export const CANDIDATE_IDS = CANDIDATES.map((candidate) => candidate.id);
