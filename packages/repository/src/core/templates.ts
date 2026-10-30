/**
 * Path templates. A template is `/`-separated segments; each segment is a
 * literal (`projects`) or one parameter with an optional literal suffix
 * (`{stem}.md`). A parameter never spans a `/`, never starts with `.`, and a
 * template without parameters names exactly one file.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

/** The parameter object a template takes, read from its source string. */
export type Params<TPath extends string> =
	TPath extends `${string}{${infer TName}}${infer TRest}`
		? { [K in TName | keyof Params<TRest>]: string }
		: {};

/** A call's parameter arguments: none for a template without parameters. */
export type ParamsArg<TPath extends string> = [keyof Params<TPath>] extends [
	never,
]
	? []
	: [params: Params<TPath>];

type Segment = { literal: string } | { param: string; suffix: string };

export type Template = {
	source: string;
	segments: Segment[];
	params: string[];
};

export const TemplateError = defineErrors({
	/** The template's source is not a valid template. */
	Invalid: ({ source, reason }: { source: string; reason: string }) => ({
		message: `The template '${source}' is invalid: ${reason}`,
		source,
		reason,
	}),
	/** A value given for a parameter would escape or hide its segment. */
	InvalidValue: ({ param, value }: { param: string; value: unknown }) => ({
		message: `The value ${JSON.stringify(value)} is not usable for {${param}}`,
		param,
		value,
	}),
});
export type TemplateError = InferErrors<typeof TemplateError>;

/** An identifier: a name usable as a property, a SQL column and a view. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A path segment value that cannot escape, hide, or break its segment. */
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
		const found = /^\{([^{}]+)\}([^{}/]*)$/.exec(part);
		if (found === null)
			return invalid(
				`'${part}' must be a literal or one {name} with an optional suffix`,
			);
		const [, param = '', suffix = ''] = found;
		if (!IDENTIFIER.test(param))
			return invalid(`'${param}' is not an identifier`);
		if (CONTROL.test(suffix) || suffix.includes('\\'))
			return invalid(`'${suffix}' is not a usable suffix`);
		if (seen.has(param)) return invalid(`{${param}} is repeated`);
		seen.add(param);
		segments.push({ param, suffix });
	}
	return Ok({ source, segments, params: [...seen] });
}

/** The parameters if `path` matches, else null. */
export function matchTemplate(
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
		if (!part.endsWith(segment.suffix)) return null;
		const value = part.slice(0, part.length - segment.suffix.length);
		if (!isUsableSegment(value)) return null;
		out[segment.param] = value;
	}
	return out;
}

/** Build a path from parameters; refuses values that would escape their segment. */
export function buildPath(
	template: Template,
	params: Record<string, unknown>,
): Result<string, TemplateError> {
	const parts: string[] = [];
	for (const segment of template.segments) {
		if ('literal' in segment) {
			parts.push(segment.literal);
			continue;
		}
		const value = params[segment.param];
		if (typeof value !== 'string' || !isUsableSegment(value))
			return TemplateError.InvalidValue({ param: segment.param, value });
		parts.push(value + segment.suffix);
	}
	return Ok(parts.join('/'));
}

/** Whether a literal segment is a path a parameter segment could produce. */
function literalFits(literal: string, suffix: string) {
	return (
		literal.endsWith(suffix) &&
		isUsableSegment(literal.slice(0, literal.length - suffix.length))
	);
}

/** Can some path match both templates? Decided segment by segment. */
export function templatesOverlap(a: Template, b: Template): boolean {
	if (a.segments.length !== b.segments.length) return false;
	return a.segments.every((x, index) => {
		const y = b.segments[index];
		if (y === undefined) return false;
		if ('literal' in x && 'literal' in y) return x.literal === y.literal;
		if ('literal' in x && 'param' in y) return literalFits(x.literal, y.suffix);
		if ('param' in x && 'literal' in y) return literalFits(y.literal, x.suffix);
		if ('param' in x && 'param' in y)
			return x.suffix.endsWith(y.suffix) || y.suffix.endsWith(x.suffix);
		return false;
	});
}

/** The template's last segment's suffix or literal, to classify its file kind. */
export function templateEnds(template: Template, ending: string) {
	const last = template.segments.at(-1);
	if (last === undefined) return false;
	return 'literal' in last
		? last.literal.endsWith(ending)
		: last.suffix.endsWith(ending);
}
