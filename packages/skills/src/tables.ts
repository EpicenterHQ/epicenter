/**
 * Release-local record lenses for shared Skills data.
 *
 * Structural row ids are allocated by the Data runtime. `sourceId` is the
 * portable agentskills.io identity stored in SKILL.md frontmatter and may be
 * used to match later imports without becoming canonical record identity.
 */

import { defineTable, optional, type RowFor } from '@epicenter/data';
import { field, jsonValue } from '@epicenter/field';
import { Type } from 'typebox';

export const skillsTable = defineTable({
	namespace: 'so.epicenter.skills',
	table: 'skills',
	fields: {
		sourceId: field.string(),
		name: field.string(),
		description: field.string(),
		license: optional(field.string()),
		compatibility: optional(field.string()),
		metadata: optional(field.json(Type.Record(Type.String(), jsonValue))),
		allowedTools: optional(field.string()),
		updatedAt: field.instant(),
	},
});

export const referencesTable = defineTable({
	namespace: 'so.epicenter.skills',
	table: 'references',
	fields: {
		skillId: field.string(),
		path: field.string(),
		updatedAt: field.instant(),
	},
});

export type Skill = RowFor<typeof skillsTable>;
export type Reference = RowFor<typeof referencesTable>;
