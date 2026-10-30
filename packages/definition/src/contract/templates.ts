/**
 * Path templates: where a contract's collections live in a folder.
 *
 * A template is `/`-separated segments. A segment is a literal
 * (`recordings`) or a pattern of named placeholders and literals
 * (`{id}.md`, `{date}.md`, `{id}.{ext}`, `day-{date}.md`). Two placeholders in
 * one segment are separated by a literal. A placeholder's value never spans a
 * `/`, never starts with `.`, and is never empty, so a filled path cannot
 * escape, hide or blank its segment. A template with no placeholders names
 * exactly one file.
 *
 * RULE: `fill` and `match` are inverses. Where a segment has two
 * placeholders, `match` splits at the first occurrence of the literal between
 * them, and `fill` refuses a value that would put that literal earlier, so
 * every path `fill` writes reads back as the values it was given.
 *
 * Ported from `claude/repository-v2` (`core/templates.ts` at `c32dd466`),
 * extended from one placeholder per segment to several.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { isNotePath } from './storage.js';

/**
 * The placeholder values a template takes, read from its source string:
 * `Params<'recordings/{id}.{ext}'>` is `{ id: string; ext: string }`.
 */
export type Params<TPath extends string> =
	TPath extends `${string}{${infer TName}}${infer TRest}`
		? { [K in TName | keyof Params<TRest>]: string }
		: {};

/**
 * One segment: a literal, or placeholders between literals. `literals` has
 * one more entry than `params`: the prefix, each separator, and the suffix.
 * Separators are never empty; the prefix and suffix may be.
 */
export type Segment =
	| { literal: string }
	| { params: string[]; literals: string[] };

export type Template = {
	source: string;
	segments: Segment[];
	/** Every placeholder name, in order. */
	params: string[];
};

export const TemplateError = defineErrors({
	/** The template's source is not a valid template. */
	Invalid: ({ source, reason }: { source: string; reason: string }) => ({
		message: `The path template '${source}' is invalid: ${reason}`,
		source,
		reason,
	}),
	/** A value given for a placeholder would escape, hide or blur its segment. */
	InvalidValue: ({ param, value }: { param: string; value: unknown }) => ({
		message: `The value ${JSON.stringify(value)} is not usable for {${param}}`,
		param,
		value,
	}),
});
export type TemplateError = InferErrors<typeof TemplateError>;

/** An identifier: a name usable as a property of a typed value. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A path segment, or a placeholder value, that cannot escape, hide, or break its segment. */
function isUsableSegment(value: string) {
	return (
		value !== '' &&
		!value.startsWith('.') &&
		!value.includes('/') &&
		!value.includes('\\') &&
		!CONTROL.test(value)
	);
}

/** Whether `path` is a usable file path: `/`-separated segments, none empty, hidden or relative. */
export const isFilePath = (path: string) =>
	path.split('/').every(isUsableSegment);

const PLACEHOLDER = /\{([^{}]*)\}/g;

export function compileTemplate(
	source: string,
): Result<Template, TemplateError> {
	const invalid = (reason: string) => TemplateError.Invalid({ source, reason });
	if (source === '') return invalid('it is empty');
	if (source.startsWith('/') || source.endsWith('/') || source.includes('//'))
		return invalid('it has an empty segment');
	const seen = new Set<string>();
	const segments: Segment[] = [];
	for (const part of source.split('/')) {
		if (!part.includes('{') && !part.includes('}')) {
			if (!isUsableSegment(part))
				return invalid(`'${part}' is a hidden, relative or unusable segment`);
			segments.push({ literal: part });
			continue;
		}
		const params: string[] = [];
		const literals: string[] = [];
		let at = 0;
		for (const found of part.matchAll(PLACEHOLDER)) {
			literals.push(part.slice(at, found.index));
			params.push(found[1] ?? '');
			at = found.index + found[0].length;
		}
		literals.push(part.slice(at));
		for (const literal of literals) {
			if (literal.includes('{') || literal.includes('}'))
				return invalid(`'${part}' has an unmatched brace`);
			if (CONTROL.test(literal) || literal.includes('\\'))
				return invalid(`'${literal}' is not a usable literal`);
		}
		if (literals[0]?.startsWith('.'))
			return invalid(`'${part}' is a hidden segment`);
		if (literals.slice(1, -1).some((literal) => literal === ''))
			return invalid(
				`'${part}' puts two placeholders side by side; separate them with a literal`,
			);
		for (const param of params) {
			if (!IDENTIFIER.test(param))
				return invalid(`'${param}' is not an identifier`);
			if (seen.has(param)) return invalid(`{${param}} is repeated`);
			seen.add(param);
		}
		segments.push({ params, literals });
	}
	return Ok({ source, segments, params: [...seen] });
}

/** A pattern segment's values for `part`, or null when it does not match. */
function matchSegment(
	{ params, literals }: { params: string[]; literals: string[] },
	part: string,
): Record<string, string> | null {
	const prefix = literals[0] ?? '';
	const suffix = literals.at(-1) ?? '';
	if (
		part.length < prefix.length + suffix.length ||
		!part.startsWith(prefix) ||
		!part.endsWith(suffix)
	)
		return null;
	let rest = part.slice(prefix.length, part.length - suffix.length);
	const out: Record<string, string> = {};
	for (const [index, param] of params.entries()) {
		let value = rest;
		if (index < params.length - 1) {
			const separator = literals[index + 1] ?? '';
			const end = rest.indexOf(separator);
			if (end < 0) return null;
			value = rest.slice(0, end);
			rest = rest.slice(end + separator.length);
		}
		if (!isUsableSegment(value)) return null;
		out[param] = value;
	}
	return out;
}

/** The placeholder values if `path` matches `template`, else null. */
export function match(
	template: Template,
	path: string,
): Record<string, string> | null {
	const parts = path.split('/');
	if (parts.length !== template.segments.length) return null;
	const out: Record<string, string> = {};
	for (const [index, segment] of template.segments.entries()) {
		const part = parts[index] ?? '';
		if ('literal' in segment) {
			if (part !== segment.literal) return null;
			continue;
		}
		const values = matchSegment(segment, part);
		if (values === null) return null;
		Object.assign(out, values);
	}
	return out;
}

/** The path `template` names for these placeholder values; refuses a value `match` could not read back. */
export function fill(
	template: Template,
	params: Record<string, unknown>,
): Result<string, TemplateError> {
	const parts: string[] = [];
	for (const segment of template.segments) {
		if ('literal' in segment) {
			parts.push(segment.literal);
			continue;
		}
		let part = segment.literals[0] ?? '';
		for (const [index, param] of segment.params.entries()) {
			const value = params[param];
			const after = segment.literals[index + 1] ?? '';
			const last = index === segment.params.length - 1;
			if (
				typeof value !== 'string' ||
				!isUsableSegment(value) ||
				(!last && `${value}${after}`.indexOf(after) !== value.length)
			)
				return TemplateError.InvalidValue({ param, value });
			part += value + after;
		}
		parts.push(part);
	}
	return Ok(parts.join('/'));
}

/** Whether one string is a prefix (or, with `end`, a suffix) of the other. */
const agree = (a: string, b: string, end = false) =>
	end ? a.endsWith(b) || b.endsWith(a) : a.startsWith(b) || b.startsWith(a);

/**
 * Whether some path could match both templates, decided segment by segment.
 * Exact where a literal meets anything; where two patterns meet, they are
 * taken to overlap when their prefixes and suffixes agree, which may refuse
 * a pair that never collides but never admits one that does.
 */
export function templatesOverlap(a: Template, b: Template): boolean {
	if (a.segments.length !== b.segments.length) return false;
	return a.segments.every((x, index) => {
		const y = b.segments[index];
		if (y === undefined) return false;
		if ('literal' in x && 'literal' in y) return x.literal === y.literal;
		if ('literal' in x && 'params' in y)
			return matchSegment(y, x.literal) !== null;
		if ('params' in x && 'literal' in y)
			return matchSegment(x, y.literal) !== null;
		if ('params' in x && 'params' in y)
			return (
				agree(x.literals[0] ?? '', y.literals[0] ?? '') &&
				agree(x.literals.at(-1) ?? '', y.literals.at(-1) ?? '', true)
			);
		return false;
	});
}

/** Whether a template names notes: its last segment ends in `.md`. */
export function isNoteTemplate(template: Template) {
	const last = template.segments.at(-1);
	if (last === undefined) return false;
	return isNotePath(
		'literal' in last ? last.literal : (last.literals.at(-1) ?? ''),
	);
}
