/**
 * The declaration: what an app's `epicenter.json` holds (ADR-0857). One
 * TypeBox schema is both the check `epicenter` runs on loading and the source
 * of the JSON Schema published as `epicenter.schema.json`, so an editor and
 * the command agree on what a declaration is.
 *
 * ```json
 * {
 *   "$schema": "https://epicenter.so/epicenter.schema.json",
 *   "description": "Words I'm learning",
 *   "collections": {
 *     "words": { "path": "words/{stem}.md", "fields": { "type": "object", "properties": {} } }
 *   }
 * }
 * ```
 *
 * An app's name is its folder's name in `~/Epicenter`, never a field here
 * (ADR-0864).
 */
import { Type } from 'typebox';
import { Value } from 'typebox/value';

/** Lowercase letters, digits, and dashes, starting with a letter: an app's folder name, a collection's, an action's word. */
export const NAME = '^[a-z][a-z0-9-]*$';

const NAME_PATTERN = new RegExp(NAME);

/** Whether `value` is a name: lowercase letters, digits, and dashes, starting with a letter. */
export function isName(value: unknown): value is string {
	return typeof value === 'string' && NAME_PATTERN.test(value);
}

/**
 * A relative path with at most one level-1 URI Template placeholder (RFC
 * 6570), such as `words/{stem}.md`, or none, such as `settings.md`. It stays
 * inside the folder: no `.` or `..` part, no empty part, no trailing `/`.
 */
export const COLLECTION_PATH =
	'^(?!(.*/)?\\.\\.?(/|$))(?!.*//)(?!.*/$)[^/{}][^{}]*(\\{[A-Za-z_][A-Za-z0-9_]*\\}[^{}]*)?$';

export const SCHEMA_URL = 'https://epicenter.so/epicenter.schema.json';

/** A kind of file in the app: where its files are, and the JSON Schema of their fields. */
export const CollectionSchema = Type.Object(
	{
		path: Type.String({
			pattern: COLLECTION_PATH,
			description:
				'Where its files are, relative to the folder, with at most one placeholder: words/{stem}.md',
		}),
		fields: Type.Object(
			{ type: Type.Literal('object') },
			{
				additionalProperties: true,
				description: "JSON Schema of each file's fields: its front matter",
			},
		),
	},
	{ additionalProperties: false },
);

export const DeclarationSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		description: Type.String({ minLength: 1 }),
		collections: Type.Optional(
			Type.Record(Type.String({ pattern: NAME }), CollectionSchema, {
				additionalProperties: false,
			}),
		),
	},
	{
		$id: SCHEMA_URL,
		title: 'An Epicenter app',
		additionalProperties: false,
	},
);

/** A declaration as TypeScript reads an imported `epicenter.json`, widened. */
export type Declaration = {
	readonly $schema?: string;
	readonly description: string;
	readonly collections?: { readonly [name: string]: Collection };
};

/** A collection as declared in `epicenter.json`: its `fields` are JSON Schema. */
export type Collection = { readonly path: string; readonly fields: object };

/**
 * What is wrong with `value` as the contents of `epicenter.json`, one
 * sentence each, naming the place with a JSON pointer; empty when nothing is.
 */
export function declarationProblems(value: unknown): string[] {
	return Value.Errors(DeclarationSchema, value).map((error) => {
		const at = error.instancePath || '/';
		const extra = (error.params as { additionalProperties?: string[] })
			.additionalProperties;
		if (error.keyword === 'pattern' && /^\/collections\/[^/]+\/path$/.test(at))
			return `epicenter.json at ${at} is not a path inside the folder with at most one placeholder, such as words/{stem}.md`;
		if (
			error.keyword === 'additionalProperties' &&
			at === '/' &&
			extra?.includes('name')
		)
			return 'epicenter.json has "name", which a declaration does not take: an app\'s name is its folder\'s';
		if (error.keyword === 'additionalProperties' && extra?.length)
			return `epicenter.json at ${at} has ${extra.map((key) => `"${key}"`).join(', ')}, which a declaration does not take`;
		return `epicenter.json at ${at} ${error.message}`;
	});
}

/** The JSON Schema published at `SCHEMA_URL`, as text with a final newline. */
export function declarationJsonSchema(): string {
	return `${JSON.stringify(DeclarationSchema, null, '\t')}\n`;
}
