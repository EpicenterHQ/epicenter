/**
 * Check an action's input, in serve: the one check a page, an agent and the
 * command share. Nothing is filled: an absent key stays absent,
 * and an action's `run` writes its own default.
 */

import { Value } from 'typebox/value';
import { type ObjectSchema, whatFits } from '../field.ts';
import { isPlainObject } from '../json.ts';

/**
 * Why `value` is not an input `schema` takes, in words a caller reads, or
 * undefined when it is one. A key the action does not take is refused,
 * naming the keys it does.
 */
export function inputProblem(schema: ObjectSchema, value: unknown) {
	if (Value.Check(schema, value)) return undefined;
	if (!isPlainObject(value)) return 'The input is not one JSON object';
	const keys = Object.keys(schema.properties);
	const unknown = Object.keys(value).find((key) => !keys.includes(key));
	if (unknown !== undefined)
		return `${JSON.stringify(unknown)} is not a key this action takes; ${keys.length ? `it takes ${keys.join(', ')}` : 'it takes none'}`;
	const first = Value.Errors(schema, value)[0];
	const params = first?.params as { requiredProperties?: string[] } | undefined;
	const at = (first?.instancePath.split('/').slice(1) ?? []).map((part) =>
		part.replace(/~1/g, '/').replace(/~0/g, '~'),
	);
	const field = at[0] || params?.requiredProperties?.[0];
	const name = field ?? 'input';
	// A key missing inside an object is named by its path: `address.city is needed`.
	if (first?.keyword === 'required')
		return `${[...at, params?.requiredProperties?.[0]].filter(Boolean).join('.') || name} is needed`;
	const fieldSchema = field ? schema.properties[field] : undefined;
	const words = field && fieldSchema && whatFits(fieldSchema, value[field]);
	if (words) return `${name} must be ${words}`;
	return `${name}: ${first?.message ?? 'is not accepted'}`;
}
