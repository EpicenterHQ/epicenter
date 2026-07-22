import { type BoundLens, defineLens } from '@epicenter/data/record';
import { referencesTable, skillsTable } from './tables.js';

/** Pure JSON interpretation of the Skills namespace. */
export const skillsLens = defineLens({
	namespace: 'so.epicenter.skills',
	title: 'Skills',
	description: 'Agent skills and their reference documents.',
	collections: {
		skills: skillsTable,
		references: referencesTable,
	},
});

/** The bound capabilities used by Skills services. */
export type SkillsData = BoundLens<typeof skillsLens, never, unknown>;
