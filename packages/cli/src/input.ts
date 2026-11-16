/**
 * Which action a person meant, and its input (ADR-0841). The longest run of
 * words that names an action is the action, and the rest is its input; when
 * none does, the CLI lists the app's actions. An action's fields become CLI
 * arguments and MCP input alike: both use its schema for
 * validation, so a command and a tool accept the same values and name the
 * field that needs attention. The action's `positional` list says which
 * fields the command line also reads by position, in order. An action that
 * declares `privateInput: true` accepts only JSON stdin, before any
 * arguments can be parsed or echoed in a refusal.
 */
import {
	type Action,
	fileFieldOf,
	type Input,
	isName,
	whatFits,
} from '@epicenter/app';
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

/** The fields a caller must give: those TypeBox requires. */
export function requiredKeys(input: Input): Set<string> {
	return new Set(Type.Object(input).required ?? []);
}

/** Turn a field key into the flag a person types. */
export function flagOf(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

type Described = {
	type?: string;
	items?: Described;
	format?: string;
	minimum?: number;
	maximum?: number;
	enum?: unknown[];
	anyOf?: Described[];
	const?: unknown;
};

/** Whether a field takes `null`, which a collection's `set` reads as "remove it" (ADR-0867). */
function takesNull(field: TSchema): boolean {
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
function choicesOf(field: TSchema): string[] | undefined {
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
 * What one item of a list field is on the command line: its kind, such as
 * `text`, `number`, or `a|b`, or `undefined` when the command line cannot
 * spell it (an object, a list, or a switch), so it is given in `--input`.
 */
function itemKind(field: TSchema): string | undefined {
	const items = withoutNull(field).items as TSchema | undefined;
	if (!items) return 'text';
	const kind = fieldKind(items);
	if (kind === 'switch' || kind === 'list') return undefined;
	if (kind !== 'text') return kind;
	return withoutNull(items).type === 'string' ? kind : undefined;
}

/** How a list field's flag is spelled in usage and help: `--tags <text>...`, or that it is given only in `--input`. */
export function listSpelling(flag: string, field: TSchema): string {
	const each = itemKind(field);
	return each ? `${flag} <${each}>...` : `${flag} (only in --input)`;
}

/**
 * Parse flags and positionals, in the action's order, before validating values
 * against its schema. A value is read as its field's type: a number for a
 * number, `true` or `false` for a switch, every value of a repeated flag for a
 * list, and `null` for the word `null` when the field takes `null` (ADR-0867).
 */
function inputFromArgs(
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
		// A list's words are its items, so each is read as its item's kind.
		const each = kind === 'list' ? itemKind(schema) : kind;
		if (each === undefined)
			return `--${flagOf(key)} is a list the command line cannot spell; give the whole input as one JSON object with --input`;
		let value: unknown = raw;
		if (each === 'number') {
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

/**
 * Report the first schema error using the caller's field names. Nothing is
 * filled: an action made by `defineAction` fills its absent switches and
 * lists itself, and a collection's verb writes only what it was given. An action with private input gets a fixed refusal for its whole input,
 * so even undeclared property names and ordinary fields cannot echo a value.
 */
export function checkInput(
	action: Action,
	raw: unknown,
	nameOf: (key: string) => string,
	{ fileReferences = false }: { fileReferences?: boolean } = {},
): { ok: true; input: Record<string, unknown> } | { error: string } {
	if (!fileReferences) {
		const keys = Object.keys(action.input).filter((key) =>
			fileFieldOf(action.input[key]),
		);
		if (keys.length)
			return {
				error: `This action takes a file (${keys.join(', ')}), which only a run started from its page can give`,
			};
	}
	const schema = Type.Object(action.input, { additionalProperties: false });
	const value = structuredClone(raw);
	if (Value.Check(schema, value))
		return { ok: true, input: value as Record<string, unknown> };
	if (action.privateInput === true)
		return { error: 'The input is not accepted' };
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
	const fieldSchema = field ? action.input[field] : undefined;
	const words =
		field &&
		fieldSchema &&
		whatFits(fieldSchema, (value as Record<string, unknown>)[field]);
	if (words) return { error: `${name} must be ${words}` };
	return { error: `${name}: ${first?.message ?? 'is not accepted'}` };
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
	if (Object.values(action.input).some((schema) => fileFieldOf(schema)))
		return `epicenter ${appName} ${key} (file input: start from its page)`;
	if (action.privateInput === true)
		return `epicenter ${appName} ${key} --input -`;
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
					? listSpelling(flag, field)
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

/** A map of fields as the JSON Schema of one object; TypeBox's internal markers are non-enumerable. */
export function jsonSchema(fields: Input): {
	type: 'object';
	properties?: Record<string, object>;
	[key: string]: unknown;
} {
	const schema = JSON.parse(
		JSON.stringify(Type.Object(fields, { additionalProperties: false })),
	);
	const required = [...requiredKeys(fields)];
	if (required.length) schema.required = required;
	else delete schema.required;
	return schema;
}

/**
 * Read an action from flags and positionals or one JSON object. An action
 * with private input accepts exactly --input -, using the same stdin path as
 * ordinary actions. Refuse other spellings before inspecting their values.
 */
export async function readInput(action: Action, rest: string[]) {
	if (
		action.privateInput === true &&
		!(rest.length === 2 && rest[0] === '--input' && rest[1] === '-')
	)
		return {
			error:
				'This action takes private input. Use the app page or pipe a JSON object to --input -',
		};
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
