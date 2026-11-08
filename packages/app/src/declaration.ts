/**
 * The declaration: what an app's `epicenter.json` holds (ADR-0857). One
 * TypeBox schema is both the check `epicenter` runs on loading and the source
 * of the JSON Schema published as `epicenter.schema.json`, so an editor and
 * the command agree on what a declaration is.
 *
 * ```json
 * {
 *   "$schema": "https://epicenter.so/epicenter.schema.json",
 *   "name": "vocab",
 *   "description": "Words I'm learning",
 *   "collections": {
 *     "words": { "path": "words/{stem}.md", "fields": { "type": "object", "properties": {} } }
 *   }
 * }
 * ```
 */
import { Type } from 'typebox';
import { Value } from 'typebox/value';

/** Lowercase letters, digits, and dashes, starting with a letter: an app's name, a collection's, an action's word. */
export const NAME = '^[a-z][a-z0-9-]*$';

/**
 * A relative path with at most one level-1 URI Template placeholder (RFC
 * 6570), such as `words/{stem}.md`, or none, such as `settings.json`.
 */
export const COLLECTION_PATH =
	'^[^/{}][^{}]*(\\{[A-Za-z_][A-Za-z0-9_]*\\}[^{}]*)?$';

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
				description:
					"JSON Schema of each file's fields: its front matter, or a JSON file's contents",
			},
		),
	},
	{ additionalProperties: false },
);

export const DeclarationSchema = Type.Object(
	{
		$schema: Type.Optional(Type.String()),
		name: Type.String({
			pattern: NAME,
			description:
				'The app, as `epicenter <name>` runs it: lowercase letters, digits, and dashes',
		}),
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

/**
 * A declaration as TypeScript reads an imported `epicenter.json`: widened
 * without a generated `epicenter.d.json.ts`, exact with one. Only what
 * `defineApp` needs to know is required.
 */
export type Declaration = {
	readonly $schema?: string;
	readonly name: string;
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
		if (error.keyword === 'additionalProperties' && extra?.length)
			return `epicenter.json at ${at} has ${extra.map((key) => `"${key}"`).join(', ')}, which a declaration does not take`;
		return `epicenter.json at ${at} ${error.message}`;
	});
}

/** The JSON Schema published at `SCHEMA_URL`, as text with a final newline. */
export function declarationJsonSchema(): string {
	return `${JSON.stringify(DeclarationSchema, null, '\t')}\n`;
}
