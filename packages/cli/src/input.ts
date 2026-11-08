/**
 * An action's fields become CLI arguments and MCP input (ADR-0841). Both use
 * the app's schema for defaults and validation, so a command and a tool accept
 * the same values and name the field that needs attention.
 */
import { type Action, type App, isPositional } from '@epicenter/app';
import { type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Match the longest action prefix so spaced action keys keep their spelling.
 * Action words are name words, so the first word that cannot be one ends the
 * search. A negative number is a value, not a flag.
 */
export function matchAction(
	app: App<Record<string, Action>>,
	words: string[],
): { key: string; rest: string[] } | undefined {
	let end = words.findIndex((word) => !/^[a-z][a-z0-9-]*$/.test(word));
	if (end < 0) end = words.length;
	for (; end > 0; end--) {
		const key = words.slice(0, end).join(' ');
		if (Object.hasOwn(app.actions, key)) return { key, rest: words.slice(end) };
	}
	return undefined;
}

/** Turn a field key into the flag a person types. */
export function flagOf(key: string): string {
	return key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/** Describe the CLI value a schema accepts for usage and field help. */
export function fieldKind(field: TSchema): string {
	const schema = field as {
		type?: string;
		pattern?: string;
		anyOf?: { const?: unknown }[];
	};
	if (schema.type === 'boolean') return 'switch';
	if (schema.type === 'array') return 'list';
	if (schema.type === 'number' || schema.type === 'integer') return 'number';
	if (schema.pattern === '^\\d{4}-\\d{2}-\\d{2}$') return 'date';
	const choices = schema.anyOf;
	if (choices?.every((choice) => typeof choice.const === 'string'))
		return choices.map((choice) => choice.const).join('|');
	return 'text';
}

/** Parse flags and the one positional before validating values against the app's schema. */
export function inputFromArgs(
	action: Action,
	tokens: string[],
): { ok: true; input: Record<string, unknown> } | { error: string } {
	const input: Record<string, unknown> = {};
	const fields = Object.entries(action.input);
	const flags = new Map(
		fields.map(([key, schema]) => [`--${flagOf(key)}`, { key, schema }]),
	);
	const positional = fields.find(([, schema]) => isPositional(schema));
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
			if (kind === 'switch' && equal >= 0)
				return { error: `${flag} takes no value` };
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
			if (!positional)
				return { error: `Unexpected positional ${JSON.stringify(token)}` };
			const [key, schema] = positional;
			if (Object.hasOwn(input, key) && fieldKind(schema) !== 'list')
				return {
					error: `${repeated(key)}; unexpected positional ${JSON.stringify(token)}`,
				};
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

/** Render an action's accepted arguments in the order its fields declare them. */
export function usageLine(
	appName: string,
	key: string,
	action: Action,
): string {
	const schema = Type.Object(action.input);
	const required = new Set(schema.required ?? []);
	const args: string[] = [];
	for (const [name, field] of Object.entries(action.input)) {
		if (!isPositional(field)) continue;
		args.push(
			fieldKind(field) === 'list'
				? `[<${name}>...]`
				: required.has(name)
					? `<${name}>`
					: `[<${name}>]`,
		);
	}
	for (const [name, field] of Object.entries(action.input)) {
		if (isPositional(field)) continue;
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

/** Copy the input as JSON Schema without runner metadata or TypeBox's internal keywords. */
export function inputSchema(action: Action): {
	type: 'object';
	properties?: Record<string, object>;
	[key: string]: unknown;
} {
	return JSON.parse(
		JSON.stringify(
			Type.Object(action.input, { additionalProperties: false }),
			(key, value) =>
				(key === 'positional' && value === true) || key.startsWith('~')
					? undefined
					: value,
		),
	);
}
