/**
 * Release-local Lens for shared Skills data.
 *
 * Structural row ids are allocated by the Data runtime. `sourceId` is the
 * portable agentskills.io identity stored in SKILL.md frontmatter and may be
 * used to match later imports without becoming canonical record identity.
 */

import {
	type BoundLens,
	defineLens,
	defineTable,
	type RowFor,
} from '@epicenter/data/runtime';
import { field, jsonValue } from '@epicenter/field';
import { Type } from 'typebox';

const skillsTable = defineTable({
	title: 'Skills',
	fields: {
		sourceId: field.string(),
		name: field.string(),
		description: field.string(),
		license: field.string(),
		compatibility: field.string(),
		metadata: field.json(Type.Record(Type.String(), jsonValue)),
		allowedTools: field.string(),
		updatedAt: field.instant(),
	},
	optional: ['license', 'compatibility', 'metadata', 'allowedTools'],
});

const referencesTable = defineTable({
	title: 'References',
	fields: {
		skillId: field.string(),
		path: field.string(),
		updatedAt: field.instant(),
	},
});

/** Skills metadata and the records that own instruction and reference documents. */
export const skillsLens = defineLens({
	namespace: 'so.epicenter.skills',
	title: 'Skills',
	description:
		'Stores agent skill metadata, instructions, and reference documents.',
	collections: {
		skills: skillsTable,
		references: referencesTable,
	},
});

export type Skill = RowFor<typeof skillsTable>;
export type Reference = RowFor<typeof referencesTable>;
export type SkillsData = BoundLens<typeof skillsLens>;
