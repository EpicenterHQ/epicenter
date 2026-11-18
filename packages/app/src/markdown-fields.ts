import type { Static, TSchema } from 'typebox';
import { Value } from 'typebox/value';
import type { Problem } from './errors.ts';
import { absentValue, type FilledKeys, whatFits } from './field.ts';
import type { readMarkdown } from './front-matter.ts';

/** Declared front matter fields, each a TypeBox schema. */
export type Fields = Record<string, TSchema>;

type ValueOf<F extends Fields, K extends keyof F> = Exclude<
	Static<F[K]>,
	undefined
>;
type OptionalKeys<F> = {
	[K in keyof F]: F[K] extends { '~optional': true } ? K : never;
}[keyof F];
type MayLack<F> = Exclude<OptionalKeys<F>, FilledKeys<F>>;

/** Required fields, filled switches and lists, and possibly absent optional fields. */
export type Fitting<F extends Fields> = {
	-readonly [K in Exclude<keyof F, MayLack<F>>]-?: ValueOf<F, K>;
} & { -readonly [K in MayLack<F>]?: ValueOf<F, K> };

/** Fields that fit, with invalid or missing fields absent. */
export type Loose<F extends Fields> = {
	-readonly [K in keyof F]?: ValueOf<F, K>;
};

export const isOptional = (schema: TSchema) =>
	(schema as { '~optional'?: boolean })['~optional'] === true;

/**
 * Why a supplied field value does not fit its schema. `withoutValue` leaves the value
 * out, giving the kind of problem that many files can share.
 */
export function misfit(
	key: string,
	schema: TSchema,
	value: unknown,
	withoutValue = false,
): string {
	const quoted = withoutValue ? key : `${key}: ${JSON.stringify(value)}`;
	const words = whatFits(schema, value);
	if (words) return `${quoted} is not ${words}`;
	const [error] = Value.Errors(schema, value);
	return `${quoted} ${error?.message ?? 'does not fit'}`;
}

function notJsonProblem(
	key: string,
	schema: TSchema,
	{ line, text }: { line?: number; text: string },
	withoutValue: boolean,
): string {
	const which = `${key}${line === undefined ? '' : ` on line ${line}`} is not JSON`;
	if (text.trim() === '')
		return `${which}: it has no value; give it one as JSON, or remove the line`;
	if (Value.Check(schema, text))
		return `${which}; write ${withoutValue ? 'its text in double quotes' : `${key}: ${JSON.stringify(text)}`}`;
	const words = whatFits(schema, text);
	return words
		? `${which}; ${key} takes ${words}, written as JSON`
		: `${which}; write its value as JSON`;
}

const UNREADABLE =
	'its front matter is not key: value lines between two --- lines, each key once';

/**
 * Project one file's declared fields, retaining every diagnostic for repair.
 * Each problem's `kind` is its line without the file's values.
 */
export function projectFields(
	fields: Fields,
	found: ReturnType<typeof readMarkdown>,
) {
	const values: Record<string, unknown> = {};
	const problems: Problem[] = [];
	const problem = (line: string, kind = line) => problems.push({ line, kind });
	if (!found.readable) problem(UNREADABLE);
	const notJson = new Map(found.notJson.map((each) => [each.key, each]));
	for (const [key, schema] of Object.entries(fields)) {
		const value = found.fields[key];
		const bare = notJson.get(key);
		if (bare) {
			problem(
				notJsonProblem(key, schema, bare, false),
				notJsonProblem(key, schema, { text: bare.text }, true),
			);
		} else if (!Object.hasOwn(found.fields, key)) {
			const absent = absentValue(schema);
			if (absent !== undefined) values[key] = structuredClone(absent);
			else if (found.readable && !isOptional(schema))
				problem(`${key} is missing`);
		} else if (Value.Check(schema, value)) values[key] = value;
		else problem(misfit(key, schema, value), misfit(key, schema, value, true));
	}
	return { fields: values, problems };
}
