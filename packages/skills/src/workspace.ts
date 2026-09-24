import {
	defineStore,
	defineTable,
	field,
	jsonValue,
	plainText,
	type RowOf,
} from '@epicenter/app';
import type { DeclaredData } from '@epicenter/app/store';

/**
 * Skills' inert data definition: the definition id it owns and the two
 * tables in it.
 *
 * The declaration describes the schema without opening storage or capturing
 * an Account. The `skills` and `skillReferences` property names are durable
 * table names used by row addresses and artifact paths.
 *
 * Structural row ids are minted by the store. `sourceId` is the portable
 * agentskills.io identity kept in SKILL.md frontmatter; it may be used to match
 * a later import, and it never becomes record identity.
 */

const skillsTable = defineTable({
	fields: {
		sourceId: field.string(),
		name: field.string(),
		description: field.string(),
		// Nullable rather than optional. A data definition has no optional
		// fields on purpose: a field has to be one type through the CRDT attribute,
		// the projection column and the row alike, and "absent" is not a SQL type.
		license: field.nullable(field.string()),
		compatibility: field.nullable(field.string()),
		// Opaque passthrough: whatever the frontmatter carried besides the fields
		// above, round-tripped on export. `unknown` values rather than a recursive
		// JSON type because the store's write gate already refuses anything that is
		// not finite JSON, and a second declaration of that rule would be the one
		// that goes stale.
		metadata: field.nullable(field.json(jsonValue)),
		allowedTools: field.nullable(field.string()),
		// Validation-only rather than `string.date.parse`: a parsing form would hand
		// back a `Date` that could not round-trip through the projection.
		updatedAt: field.instant(),
	},
	/**
	 * The markdown a person edits: this row's one live node (ADR-0295).
	 *
	 * `plainText()` is the whole of it. The node IS its text here, so the
	 * platform's codec is the right one rather than a fallback: the values go
	 * to frontmatter under their own names and the markdown goes below the
	 * fence, in both directions, and this package writes nothing to say so.
	 */
	body: plainText(),
});

const referencesTable = defineTable({
	fields: {
		skillId: field.string(),
		path: field.string(),
		updatedAt: field.instant(),
	},
	/**
	 * The markdown a person edits: this row's one live node (ADR-0295).
	 *
	 * `plainText()` is the whole of it. The node IS its text here, so the
	 * platform's codec is the right one rather than a fallback: the values go
	 * to frontmatter under their own names and the markdown goes below the
	 * fence, in both directions, and this package writes nothing to say so.
	 */
	body: plainText(),
});

export const skillsDefinition = defineStore({
	id: 'so.epicenter.skills',
	title: 'Skills',
	kv: {},
	tables: {
		skills: skillsTable,
		skillReferences: referencesTable,
	},
});

/** The typed view of one store through the Skills workspace. */
export type SkillsData = DeclaredData<typeof skillsDefinition>;

export type Skill = RowOf<typeof skillsTable>;
export type Reference = RowOf<typeof referencesTable>;
