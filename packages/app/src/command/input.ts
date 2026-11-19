/**
 * Check an action's input, in serve. A page and the command send it as JSON
 * text, which `readInput` reads; an agent sends it as an object, which
 * `checkObject` checks. Both refuse in the same words.
 */

import type { TSchema } from 'typebox';
import { Value } from 'typebox/value';
import { type ObjectSchema, whatFits } from '../field.ts';

/**
 * Check an input against its action's schema, the one check a
 * page, an agent, and the command line share. Nothing is filled: an absent
 * key stays absent, and an action's `run` writes its own default. A key the action does not
 * take is refused, naming the keys it does.
 */
function checkInput(
	schema: ObjectSchema,
	value: unknown,
): { input: Record<string, unknown> } | { error: string } {
	if (Value.Check(schema, value))
		return { input: value as Record<string, unknown> };
	const given =
		typeof value === 'object' && value !== null && !Array.isArray(value)
			? (value as Record<string, unknown>)
			: undefined;
	const unknown = given
		? Object.keys(given).find((key) => !Object.hasOwn(schema.properties, key))
		: undefined;
	if (unknown !== undefined) {
		const keys = Object.keys(schema.properties);
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
	// A key missing inside an object is named by its path: `address.city is needed`.
	if (first?.keyword === 'required')
		return {
			error: `${[...at, params?.requiredProperties?.[0]].filter(Boolean).join('.') || name} is needed`,
		};
	const fieldSchema = field ? schema.properties[field] : undefined;
	const words =
		field && fieldSchema && given && whatFits(fieldSchema, given[field]);
	if (words) return { error: `${name} must be ${words}` };
	return { error: `${name}: ${first?.message ?? 'is not accepted'}` };
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
function exampleInput({ properties, required }: ObjectSchema): string {
	const shown = required.length
		? required
		: Object.keys(properties).slice(0, 1);
	return JSON.stringify(
		Object.fromEntries(
			shown.map((key) => [
				key,
				exampleOf(properties[key] as TSchema as Described),
			]),
		),
	);
}

/**
 * Read an action's input from the JSON text a page or the command sent, and
 * check it. Text that is not one JSON object is refused with an example.
 */
export function readInput(
	schema: ObjectSchema,
	text: string,
): { input: Record<string, unknown> } | { error: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {
			error: `The input is not JSON; give one JSON object, such as ${exampleInput(schema)}`,
		};
	}
	return checkObject(schema, raw);
}

/** Check a value that should be the input object, refusing one that is no object with an example. */
export function checkObject(
	schema: ObjectSchema,
	raw: unknown,
): { input: Record<string, unknown> } | { error: string } {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
		return {
			error: `The input is not a JSON object; give one, such as ${exampleInput(schema)}`,
		};
	return checkInput(schema, raw);
}
