/**
 * Which action a person meant, and its input (ADR-0841). The longest run of
 * words that names an action is the action, and the rest is its input; when
 * none does, the CLI lists the app's actions. An action's fields become CLI
 * arguments and MCP input alike: both use its schema for defaults and
 * validation, so a command and a tool accept the same values and name the
 * field that needs attention. The action's `positional` list says which
 * fields the command line also reads by position, in order. A `writeOnly`
 * field is a secret: the command line never reads it from its arguments, which
 * the shell's history keeps, and asks for it instead without echo (ADR-0870).
 */
import {
	type Action,
	type Input,
	isName,
	isWriteOnly,
	whatFits,
	writeOnlyKeys,
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
			if (isWriteOnly(field.schema))
				return { error: writeOnlyOnCommandLine(flag) };
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
			if (!positional) {
				// A word typed where a secret was meant is not repeated back.
				const secret = writeOnlyKeys(action.input)[0];
				return {
					error: secret
						? `Unexpected positional. --${flagOf(secret)} is a secret, so leave it out to be asked for it`
						: `Unexpected positional ${JSON.stringify(token)}`,
				};
			}
			const [key, schema] = positional;
			const error = put(key, schema, token);
			if (error) return { error };
		}
	}
	return { ok: true, input };
}

/** Why a secret given among the arguments is refused, naming its flag and never its value. */
function writeOnlyOnCommandLine(flag: string) {
	return `${flag} is a secret, so it is not read from the command line, where the shell's history keeps it. Leave it out to be asked for it, or pipe the input to --input -`;
}

/**
 * Apply defaults and report the first schema error using the caller's field
 * names. A refusal never quotes a value, and for a `writeOnly` field it says
 * no more than what the field takes, so a mistyped secret is not repeated.
 */
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
	const fieldSchema = field ? action.input[field] : undefined;
	const words =
		field &&
		fieldSchema &&
		whatFits(fieldSchema, (value as Record<string, unknown>)[field]);
	if (words) return { error: `${name} must be ${words}` };
	if (fieldSchema && isWriteOnly(fieldSchema))
		return { error: `${name} is not accepted` };
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
		if (positional.has(name) || isWriteOnly(field)) continue;
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

/** Asks a person for a secret and resolves with what they typed, or `undefined` when no one can be asked or they stopped. */
export type AskSecret = (label: string) => Promise<string | undefined>;

/** A terminal's input and where its prompt goes, as `askSecret` uses them. */
type Terminal = {
	input: Pick<
		NodeJS.ReadStream,
		'isTTY' | 'setRawMode' | 'setEncoding' | 'resume' | 'pause' | 'on' | 'off'
	>;
	output: { write(text: string): unknown };
};

/**
 * Ask for a secret at the terminal without echo: the prompt goes to stderr,
 * so stdout holds only the answer, and what is typed is never written back.
 * Enter ends it; Backspace removes a character; Ctrl-C, or Ctrl-D on an empty
 * line, stops it. Resolves `undefined` when stdin is not a terminal.
 */
export function askSecret(
	label: string,
	{ input, output }: Terminal = {
		input: process.stdin,
		output: process.stderr,
	},
): Promise<string | undefined> {
	if (!input.isTTY || typeof input.setRawMode !== 'function')
		return Promise.resolve(undefined);
	output.write(`${label} (typing is not shown): `);
	input.setRawMode(true);
	input.setEncoding('utf8');
	input.resume();
	return new Promise((resolve) => {
		let value = '';
		const finish = (result: string | undefined) => {
			input.off('data', onData);
			input.setRawMode(false);
			input.pause();
			output.write('\n');
			resolve(result);
		};
		const onData = (chunk: string) => {
			for (const char of chunk) {
				if (char === '\r' || char === '\n') return finish(value);
				if (char === '\u0003' || (char === '\u0004' && value === ''))
					return finish(undefined);
				if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
				else value += char;
			}
		};
		input.on('data', onData);
	});
}

/**
 * The action's input, checked against its fields: from `--input <json>`, one
 * JSON object as MCP and scripts pass it (`-` reads it from stdin), or else
 * from flags and positionals. `--input` stands alone: the object holds every
 * field, positional ones included (ADR-0867). A `writeOnly` field is never
 * read from the arguments: from flags, `ask` asks for each one missing, and
 * `--input` takes one only from stdin.
 */
export async function readInput(
	action: Action,
	rest: string[],
	ask: AskSecret = askSecret,
) {
	const end = rest.indexOf('--');
	const at = rest.indexOf('--input');
	const secrets = writeOnlyKeys(action.input);
	if (at < 0 || (end >= 0 && at > end)) {
		const parsed = inputFromArgs(action, rest);
		if ('error' in parsed) return parsed;
		for (const key of secrets) {
			if (Object.hasOwn(parsed.input, key)) continue;
			const given = await ask(key);
			if (given !== undefined) parsed.input[key] = given;
			else if (requiredKeys(action.input).has(key))
				return {
					error: `--${flagOf(key)} is needed, and it is a secret, so it is asked for only in a terminal. Or pipe the input to --input -`,
				};
		}
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
	const inline =
		given === '-' ? undefined : secrets.find((key) => Object.hasOwn(raw, key));
	if (inline)
		return {
			error: `${inline} is a secret, so it is not read from the command line, where the shell's history keeps it. Pipe the input to --input -, or give the other fields as flags to be asked for it`,
		};
	return checkInput(action, raw, (key) => key);
}
