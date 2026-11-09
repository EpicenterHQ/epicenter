/**
 * An action's fields become CLI arguments and MCP input (ADR-0841, ADR-0857).
 * Both use the app's schema for defaults and validation, so a command and a
 * tool accept the same values and name the field that needs attention. The
 * action's `positional` list says which fields the command line also reads by
 * position, in order.
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

/** Describe the CLI value a schema accepts for usage and field help. */
export function fieldKind(field: TSchema): string {
	const schema = field as {
		type?: string;
		format?: string;
		enum?: unknown[];
		anyOf?: { const?: unknown }[];
	};
	if (schema.type === 'boolean') return 'switch';
	if (schema.type === 'array') return 'list';
	if (schema.type === 'number' || schema.type === 'integer') return 'number';
	if (schema.format === 'date') return 'date';
	const choices = schema.enum ?? schema.anyOf?.map((choice) => choice.const);
	if (choices?.every((choice) => typeof choice === 'string'))
		return choices.join('|');
	return 'text';
}

/** Parse flags and positionals, in the action's order, before validating values against its schema. */
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
	function put(
		key: string,
		schema: TSchema,
		raw: string | true,
	): string | undefined {
		const kind = fieldKind(schema);
		if (kind !== 'list' && Object.hasOwn(input, key)) return repeated(key);
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
			if (!field)
				return {
					error: `Unknown flag ${flag}. Flags: ${[...flags.keys()].join(', ') || '(none)'}`,
				};
			const kind = fieldKind(field.schema);
			const value = equal < 0 ? undefined : token.slice(equal + 1);
			if (kind === 'switch' && value !== undefined) {
				if (value !== 'true' && value !== 'false')
					return { error: `${flag} takes no value, or =true or =false` };
				if (Object.hasOwn(input, field.key))
					return { error: repeated(field.key) };
				input[field.key] = value === 'true';
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
	const name = key
		? nameOf(key.replace(/~1/g, '/').replace(/~0/g, '~'))
		: 'input';
	return {
		error:
			first?.keyword === 'required'
				? `${name} is needed`
				: `${name}: ${first?.message ?? 'is not accepted'}`,
	};
}

/** Render an action's positionals in their order, then its flags in the order its fields declare them. */
export function usageLine(
	appName: string,
	key: string,
	action: Action,
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
	for (const [name, field] of Object.entries(action.input)) {
		if (positional.has(name)) continue;
		const kind = fieldKind(field);
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
