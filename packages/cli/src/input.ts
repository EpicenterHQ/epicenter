/**
 * Which action a person meant, and its input (ADR-0841, ADR-0925). The longest
 * run of words that names an action is the action; when none does, the CLI
 * lists the app's actions. After the action's words comes at most one more
 * word, the input: one JSON object as text, or `-` to read that text from
 * stdin. A page, an agent, and the command line give the same object, and
 * `checkInput` checks it for all three.
 */
import { type Action, type Input, isName, whatFits } from '@epicenter/app';
import { type TSchema, Type } from 'typebox';
import { Value } from 'typebox/value';

/**
 * Match the longest action prefix so spaced action keys keep their spelling.
 * Action words are name words, so the first word that cannot be one ends the
 * search.
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

/**
 * Check an input against its action's schema, the one check a page, an agent,
 * and the command line share. Nothing is filled: an action made by
 * `defineAction` fills its absent switches and lists itself, and a
 * collection's verb writes only what it was given. A key the action does not
 * take is refused, naming the keys it does.
 */
export function checkInput(
	action: Action,
	raw: unknown,
): { ok: true; input: Record<string, unknown> } | { error: string } {
	const schema = Type.Object(action.input, { additionalProperties: false });
	const value = structuredClone(raw);
	if (Value.Check(schema, value))
		return { ok: true, input: value as Record<string, unknown> };
	const given =
		typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const unknown = given
		? Object.keys(given).find((key) => !Object.hasOwn(action.input, key))
		: undefined;
	if (unknown !== undefined) {
		const keys = Object.keys(action.input);
		return {
			error: `${JSON.stringify(unknown)} is not a key this action takes; ${keys.length ? `it takes ${keys.join(', ')}` : 'it takes none'}`,
		};
	}
	const first = Value.Errors(schema, value)[0];
	const params = first?.params as { requiredProperties?: string[] } | undefined;
	const at = (first?.instancePath.split('/').slice(1) ?? []).map((part) =>
		part.replace(/~1/g, '/').replace(/~0/g, '~'),
	);
	const field = at[0] || params?.requiredProperties?.[0];
	const name = field ?? 'input';
	// A key missing inside an object is named by its path: `edit.new is needed`.
	if (first?.keyword === 'required')
		return {
			error: `${[...at, params?.requiredProperties?.[0]].filter(Boolean).join('.') || name} is needed`,
		};
	const fieldSchema = field ? action.input[field] : undefined;
	const words =
		field && fieldSchema && given && whatFits(fieldSchema, given[field]);
	if (words) return { error: `${name} must be ${words}` };
	return { error: `${name}: ${first?.message ?? 'is not accepted'}` };
}

/**
 * The command an action is called with: `<input>`, or
 * `[<input>]` when no key is required, and nothing for an action with no input.
 */
export function usageLine(
	appName: string,
	key: string,
	action: Action,
): string {
	const command = `epicenter ${appName} ${key}`;
	if (!Object.keys(action.input).length) return command;
	return requiredKeys(action.input).size
		? `${command} <input>`
		: `${command} [<input>]`;
}

type Described = {
	type?: string;
	format?: string;
	minimum?: number;
	minItems?: number;
	items?: Described;
	required?: string[];
	properties?: Record<string, Described>;
	anyOf?: Described[];
	const?: unknown;
	enum?: unknown[];
};

/** A value `field` takes, for an example: its first choice, a day for a date, `"text"` for other text, as many items as a list needs, an object of its required keys. */
function exampleOf(field: Described): unknown {
	const choices =
		field.enum ??
		field.anyOf?.map((choice) =>
			'const' in choice ? choice.const : exampleOf(choice),
		);
	if (choices) return choices.find((choice) => choice !== null) ?? null;
	if (field.type === 'string') {
		if (field.format === 'date') return '2026-11-12';
		if (field.format === 'date-time') return '2026-11-12T09:30:00Z';
		return 'text';
	}
	if (field.type === 'number' || field.type === 'integer')
		return field.minimum ?? 1;
	if (field.type === 'boolean') return true;
	if (field.type === 'array')
		return Array.from({ length: field.minItems ?? 0 }, () =>
			exampleOf(field.items ?? {}),
		);
	if (field.type === 'object')
		return Object.fromEntries(
			(field.required ?? []).map((key) => [
				key,
				exampleOf(field.properties?.[key] ?? {}),
			]),
		);
	return null;
}

/**
 * An input to show: each required key with a value it takes, or the first key
 * when none is required, so the example always shows the object's shape.
 */
function exampleInput(action: Action): string {
	const required = [...requiredKeys(action.input)];
	const shown = required.length
		? required
		: Object.keys(action.input).slice(0, 1);
	return JSON.stringify(
		Object.fromEntries(
			shown.map((key) => [
				key,
				exampleOf(action.input[key] as TSchema as Described),
			]),
		),
	);
}

/** `text` in single quotes for a POSIX shell. */
function quoted(text: string): string {
	return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The command to copy for an action, its example input written as the shell takes it. */
export function exampleCommand(
	appName: string,
	key: string,
	action: Action,
): string {
	const command = `epicenter ${appName} ${key}`;
	return `${command} ${quoted(exampleInput(action))}`;
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
 * Read an action's input from the words after its name: none is `{}`, `-`
 * reads the JSON text from stdin, and any other word is the JSON text itself.
 * Stdin is read only for `-`.
 */
export async function readInput(action: Action, rest: string[]) {
	const example = quoted(exampleInput(action));
	if (rest.length > 1)
		return {
			error: `The input is one argument, a JSON object such as ${example}; quote it whole`,
		};
	const [word] = rest;
	if (word === undefined) return checkInput(action, {});
	let raw: unknown;
	try {
		raw = JSON.parse(word === '-' ? await Bun.stdin.text() : word);
	} catch {
		return {
			error: `The input is not JSON; give one JSON object, such as ${example}`,
		};
	}
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return {
			error: `The input is not a JSON object; give one, such as ${example}`,
		};
	return checkInput(action, raw);
}
