/**
 * Which action a person meant, and its input (ADR-0841). The longest run of
 * words that names an action is the action, and the rest is its input; when
 * none does, the CLI lists the app's actions. An action's fields become CLI
 * arguments and MCP input alike: both use its schema for defaults and
 * validation, so a command and a tool accept the same values and name the
 * field that needs attention. The action's `positional` list says which
 * fields the command line also reads by position, in order.
 */
import { type Action, type Input, isName } from '@epicenter/app';
import { type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Match the longest action prefix so spaced action keys keep their spelling.
 * Action words are name words, so the first word that cannot be one ends the
 * search. A negative number is a value, not a flag.
 */
export function matchAction(
	actions: object,
	words: string[],
): { key: string; rest: string[] } | undefined {
	let end = words.findIndex((word) => !isName(word));
	if (end < 0) end = words.length;
	for (; end > 0; end--) {
		const key = words.slice(0, end).join(' ');
		if (Object.hasOwn(actions, key)) return { key, rest: words.slice(end) };
	}
	return undefined;
}

/** The fields a caller must give: those TypeBox requires, less any with a default, which fills them. */
export function requiredKeys(input: Input): Set<string> {
	return new Set(
		(Type.Object(input).required ?? []).filter(
			(key) => !Object.hasOwn(input[key] ?? {}, 'default'),
		),
	);
}

/** Turn a field key into the flag a person types. */
export function flagOf(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

type Described = {
	type?: string;
	format?: string;
	enum?: unknown[];
	anyOf?: Described[];
	const?: unknown;
};

/** Whether a field takes `null`, which a collection's `set` reads as "remove it" (ADR-0867). */
export function takesNull(field: TSchema): boolean {
	const schema = field as Described;
	return (
		schema.type === 'null' ||
		(schema.anyOf?.some((choice) => choice.type === 'null') ?? false)
	);
}

/** The schema a field takes besides `null`: `X | null` is `X`. */
function withoutNull(field: TSchema): Described {
	const schema = field as Described;
	const nonNull = schema.anyOf?.filter((choice) => choice.type !== 'null');
	if (nonNull?.length === 1 && nonNull[0] && schema.anyOf?.length === 2)
		return nonNull[0];
	return schema;
}

/** The values a field may take when it is one of a few strings, as `field.select` or `enum` writes it. */
export function choicesOf(field: TSchema): string[] | undefined {
	const schema = withoutNull(field);
	const choices = schema.enum ?? schema.anyOf?.map((choice) => choice.const);
	return choices?.every((choice) => typeof choice === 'string')
		? (choices as string[])
		: undefined;
}

/**
 * Describe the CLI value a schema accepts for usage and field help. `X | null`
 * is described as `X`; `null` is a value any such field takes.
 */
export function fieldKind(field: TSchema): string {
	const schema = withoutNull(field);
	if (schema.type === 'boolean') return 'switch';
	if (schema.type === 'array') return 'list';
	if (schema.type === 'number' || schema.type === 'integer') return 'number';
	if (schema.format === 'date' || schema.format === 'date-time')
		return schema.format;
	return choicesOf(field)?.join('|') ?? 'text';
}

/**
 * Parse flags and positionals, in the action's order, before validating values
 * against its schema. A value is read as its field's type: a number for a
 * number, `true` or `false` for a switch, every value of a repeated flag for a
 * list, and `null` for the word `null` when the field takes `null` (ADR-0867).
 */
export function inputFromArgs(
	action: Action,
	tokens: string[],
): { ok: true; input: Record<string, unknown> } | { error: string } {
	const input: Record<string, unknown> = {};
	const fields = Object.entries(action.input);
	const flags = new Map(
		fields.map(([key, schema]) => [`--${flagOf(key)}`, { key, schema }]),
	);
	const positionals = (action.positional ?? []).map(
		(key) => [key, action.input[key] as TSchema] as const,
	);
	const repeated = (key: string) => `--${flagOf(key)} was given more than once`;
	// `null` for a field that does not take it (one `set` may not remove) is refused, not read as the text "null".
	const noNull = (flag: string, kind: string) =>
		kind === 'switch'
			? `${flag} does not take null: give ${flag}, or ${flag}=false`
			: `${flag} does not take null. For the text "null", give it in --input`;
	function put(
		key: string,
		schema: TSchema,
		raw: string | true,
	): string | undefined {
		const kind = fieldKind(schema);
		if (kind !== 'list' && Object.hasOwn(input, key)) return repeated(key);
		if (raw === 'null' && takesNull(schema)) {
			if (Object.hasOwn(input, key)) return repeated(key);
			input[key] = null;
			return;
		}
		let value: unknown = raw;
		if (kind === 'number') {
			value = Number(raw);
			if (typeof raw !== 'string' || raw.trim() === '' || Number.isNaN(value))
				return `--${flagOf(key)} needs a number`;
		}
		if (kind === 'list')
			input[key] = [...((input[key] as unknown[] | undefined) ?? []), value];
		else input[key] = value;
	}
	let literal = false;
	for (let index = 0; index < tokens.length; index++) {
		const token = tokens[index];
		if (token === undefined) break;
		if (!literal && token === '--') {
			literal = true;
			continue;
		}
		if (!literal && /^--[^=]+|^-[A-Za-z]/.test(token)) {
			const equal = token.indexOf('=');
			const flag = equal < 0 ? token : token.slice(0, equal);
			const field = flags.get(flag);
			if (!field) {
				const negated = flags.get(`--${flag.slice('--no-'.length)}`);
				if (
					flag.startsWith('--no-') &&
					negated &&
					fieldKind(negated.schema) === 'switch'
				)
					return {
						error: `Unknown flag ${flag}; to make it false: --${flagOf(negated.key)}=false`,
					};
				return {
					error: `Unknown flag ${flag}. Flags: ${[...flags.keys()].join(', ') || '(none)'}`,
				};
			}
			const kind = fieldKind(field.schema);
			const value = equal < 0 ? undefined : token.slice(equal + 1);
			if (kind === 'switch' && value !== undefined) {
				const nullable = takesNull(field.schema);
				if (
					value !== 'true' &&
					value !== 'false' &&
					!(nullable && value === 'null')
				)
					return {
						error: `${flag} takes no value, or ${nullable ? '=true, =false, or =null' : '=true or =false'}`,
					};
				if (Object.hasOwn(input, field.key))
					return { error: repeated(field.key) };
				input[field.key] = value === 'null' ? null : value === 'true';
				continue;
			}
			// A switch reads a following `null` the way every other field does.
			if (kind === 'switch' && tokens[index + 1] === 'null') {
				if (!takesNull(field.schema)) return { error: noNull(flag, kind) };
				if (Object.hasOwn(input, field.key))
					return { error: repeated(field.key) };
				input[field.key] = null;
				index++;
				continue;
			}
			let raw: string | true = true;
			if (kind !== 'switch') {
				const next = tokens[index + 1];
				if (equal >= 0) raw = token.slice(equal + 1);
				else if (
					next === undefined ||
					next === '--' ||
					/^--|^-[A-Za-z]/.test(next)
				)
					return { error: `${flag} needs a value` };
				else {
					raw = next;
					index++;
				}
			}
			if (raw === 'null' && !takesNull(field.schema))
				return { error: noNull(flag, kind) };
			const error = put(field.key, field.schema, raw);
			if (error) return { error };
		} else {
			// The first positional still unset takes the word; a list, last, takes every word left.
			const positional = positionals.find(
				([key, schema]) =>
					fieldKind(schema) === 'list' || !Object.hasOwn(input, key),
			);
			if (!positional)
				return { error: `Unexpected positional ${JSON.stringify(token)}` };
			const [key, schema] = positional;
			const error = put(key, schema, token);
			if (error) return { error };
		}
	}
	return { ok: true, input };
}

/** Apply defaults and report the first schema error using the caller's field names. */
export function checkInput(
	action: Action,
	raw: unknown,
	nameOf: (key: string) => string,
): { ok: true; input: Record<string, unknown> } | { error: string } {
	const schema = Type.Object(action.input, { additionalProperties: false });
	const value = Value.Default(schema, structuredClone(raw));
	if (Value.Check(schema, value))
		return { ok: true, input: value as Record<string, unknown> };
	const first = Value.Errors(schema, value)[0];
	const params = first?.params as
		| {
				requiredProperties?: string[];
				additionalProperties?: string[] | string;
		  }
		| undefined;
	const additional = params?.additionalProperties;
	const key =
		first?.instancePath.split('/')[1] ||
		params?.requiredProperties?.[0] ||
		(Array.isArray(additional) ? additional[0] : additional);
	const field = key?.replace(/~1/g, '/').replace(/~0/g, '~');
	const name = field ? nameOf(field) : 'input';
	if (first?.keyword === 'required') return { error: `${name} is needed` };
	const fieldSchema = field ? (action.input[field] as TSchema) : undefined;
	const choices = fieldSchema ? choicesOf(fieldSchema) : undefined;
	if (choices)
		return { error: `${name} must be one of: ${choices.join(', ')}` };
	const wanted = fieldSchema && wantedOf(fieldSchema);
	if (wanted) return { error: `${name} needs ${wanted}` };
	// A pattern is a regular expression; the field's description says it in words.
	const described = (fieldSchema as { description?: string } | undefined)
		?.description;
	if (first?.keyword === 'pattern' && described)
		return { error: `${name} must be ${described}` };
	return { error: `${name}: ${first?.message ?? 'is not accepted'}` };
}

/** What a field takes, said as its help would say it, for the formats and types a person can get wrong by shape. */
const WANTED: Record<string, string> = {
	date: 'a day, as 2026-11-12',
	'date-time': 'a date and time, as 2026-11-12T09:30:00Z',
	uri: 'a URL, as https://example.com',
	email: 'an email address',
	integer: 'a whole number',
	number: 'a number',
};

function wantedOf(field: TSchema): string | undefined {
	const schema = withoutNull(field);
	return (
		(schema.format && WANTED[schema.format]) ||
		(schema.type && WANTED[schema.type]) ||
		undefined
	);
}

/**
 * Render an action's positionals in their order, then its flags in the order
 * its fields declare them. `short` keeps the required flags and folds the rest
 * into `[--flags]`, for listings.
 */
export function usageLine(
	appName: string,
	key: string,
	action: Action,
	{ short = false }: { short?: boolean } = {},
): string {
	const required = requiredKeys(action.input);
	const positional = new Set<string>(action.positional ?? []);
	const args: string[] = [];
	for (const name of positional) {
		const field = action.input[name] as TSchema;
		args.push(
			fieldKind(field) === 'list'
				? `[<${name}>...]`
				: required.has(name)
					? `<${name}>`
					: `[<${name}>]`,
		);
	}
	let folded = false;
	for (const [name, field] of Object.entries(action.input)) {
		if (positional.has(name)) continue;
		const kind = fieldKind(field);
		if (short && (kind === 'switch' || !required.has(name))) {
			folded = true;
			continue;
		}
		const flag = `--${flagOf(name)}`;
		const arg =
			kind === 'switch'
				? flag
				: kind === 'list'
					? `${flag} <text>...`
					: `${flag} <${kind}>`;
		args.push(
			kind === 'switch' || kind === 'list' || !required.has(name)
				? `[${arg}]`
				: arg,
		);
	}
	if (folded) args.push('[--flags]');
	return [`epicenter ${appName} ${key}`, ...args].join(' ');
}

/** A map of fields as the JSON Schema of one object, without TypeBox's internal keywords. */
export function jsonSchema(fields: Input): {
	type: 'object';
	properties?: Record<string, object>;
	[key: string]: unknown;
} {
	const schema = JSON.parse(
		JSON.stringify(
			Type.Object(fields, { additionalProperties: false }),
			(key, value) => (key.startsWith('~') ? undefined : value),
		),
	);
	const required = [...requiredKeys(fields)];
	if (required.length) schema.required = required;
	else delete schema.required;
	return schema;
}

/**
 * The action's input, checked against its fields: from `--input <json>`, one
 * JSON object as MCP and scripts pass it (`-` reads it from stdin), or else
 * from flags and positionals. `--input` stands alone: the object holds every
 * field, positional ones included (ADR-0867).
 */
export async function readInput(action: Action, rest: string[]) {
	const end = rest.indexOf('--');
	const at = rest.indexOf('--input');
	if (at < 0 || (end >= 0 && at > end)) {
		const parsed = inputFromArgs(action, rest);
		if ('error' in parsed) return parsed;
		return checkInput(action, parsed.input, (key) =>
			action.positional?.includes(key) ? `<${key}>` : `--${flagOf(key)}`,
		);
	}
	const given = rest[at + 1];
	if (rest.length !== 2 || given === undefined)
		return {
			error:
				'--input takes the whole input as one JSON object, with nothing beside it; put positional fields in the object',
		};
	let raw: unknown;
	try {
		raw = JSON.parse(given === '-' ? await Bun.stdin.text() : given);
	} catch {
		return { error: '--input is not JSON' };
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return { error: '--input is not a JSON object' };
	return checkInput(action, raw, (key) => key);
}
