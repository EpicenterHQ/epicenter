/**
 * JSON value vocabulary for scalar sync payloads.
 *
 * Fact and intent payloads are arbitrary JSON: a present value fact carries any
 * JSON value, and a present row fact carries a JSON object of top-level fields.
 * `null` and the empty object `{}` are ordinary present data, never a signal for
 * absence; absence is carried by the fact/intent presence axis instead.
 *
 * The structural TypeBox schemas below accept any JSON-shaped value so the
 * discriminated fact/intent schemas stay closed on their own keys. Depth,
 * fan-out, and finiteness are semantic concerns enforced by `isJsonValue` with
 * caller-supplied limits, never frozen into the schema.
 */
import { Type } from 'typebox';

import {
	isDenseDataArray,
	isPlainDataObject,
	isWellFormedString,
	utf8ByteLength,
} from './canonical.js';

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;
export type JsonObject = { [key: string]: JsonValue };

export const JsonValueSchema = Type.Unsafe<JsonValue>({});
export const JsonObjectSchema = Type.Unsafe<JsonObject>(
	Type.Object({}, { additionalProperties: true }),
);

export type JsonLimits = {
	/** Maximum nesting depth of a JSON payload, root inclusive. */
	jsonDepth: number;
	/** Maximum own-property count of any single JSON object. */
	propertiesPerObject: number;
};

type JsonLeaf = 'valid' | 'invalid' | 'container';

function classifyJsonLeaf(value: unknown): JsonLeaf {
	if (value === null || typeof value === 'boolean') return 'valid';
	if (typeof value === 'string') {
		return isWellFormedString(value) ? 'valid' : 'invalid';
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? 'valid' : 'invalid';
	}
	return typeof value === 'object' ? 'container' : 'invalid';
}

/** Snapshot one admitted container's children, or null for an invalid shape. */
function jsonChildren(node: object, limits: JsonLimits): unknown[] | null {
	if (Array.isArray(node)) {
		return isDenseDataArray(node) ? node.slice() : null;
	}
	if (!isPlainDataObject(node)) return null;
	const keys = Object.keys(node);
	return keys.length <= limits.propertiesPerObject
		? keys.map((key) => (node as Record<string, unknown>)[key])
		: null;
}

/**
 * Structural JSON check with bounded depth and object fan-out.
 *
 * Accepts only finite numbers, well-formed strings (no lone surrogates), dense
 * data arrays, and plain enumerable string-keyed data objects forming a tree.
 * Rejects sparse arrays, array-attached or symbol properties, accessors,
 * non-enumerable properties, non-plain objects, cyclic or shared references
 * (wire JSON is a tree, and a shared subtree expands under canonical encoding),
 * and payloads over the supplied depth or property-count limits.
 */
export function isJsonValue(
	value: unknown,
	limits: JsonLimits,
): value is JsonValue {
	try {
		const rootLeaf = classifyJsonLeaf(value);
		if (rootLeaf !== 'container') return rootLeaf === 'valid';
		if (limits.jsonDepth <= 0) return false;

		const root = value as object;
		const rootChildren = jsonChildren(root, limits);
		if (rootChildren === null) return false;
		// A tree visits every container once; a container reached twice is a cycle
		// or a shared reference, both refused by one monotonic set (see
		// `isCanonicalJson`).
		const seen = new Set<object>([root]);
		const stack: Array<{
			children: unknown[];
			index: number;
			depth: number;
		}> = [{ children: rootChildren, index: 0, depth: 0 }];

		while (stack.length > 0) {
			const frame = stack[stack.length - 1];
			if (frame === undefined) break;
			if (frame.index >= frame.children.length) {
				stack.pop();
				continue;
			}

			const child = frame.children[frame.index];
			frame.index += 1;
			const childLeaf = classifyJsonLeaf(child);
			if (childLeaf === 'invalid') return false;
			if (childLeaf === 'valid') continue;

			const childDepth = frame.depth + 1;
			const childNode = child as object;
			if (childDepth >= limits.jsonDepth || seen.has(childNode)) {
				return false;
			}
			const children = jsonChildren(childNode, limits);
			if (children === null) return false;
			seen.add(childNode);
			stack.push({
				children,
				index: 0,
				depth: childDepth,
			});
		}
		return true;
	} catch {
		return false;
	}
}

export function isJsonObject(
	value: unknown,
	limits: JsonLimits,
): value is JsonObject {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		isJsonValue(value, limits)
	);
}

/** Whether a top-level field key is non-empty, well-formed, and within bytes. */
export function isAdmissibleFieldKey(
	key: string,
	maxFieldKeyBytes: number,
): boolean {
	return (
		key.length > 0 &&
		isWellFormedString(key) &&
		utf8ByteLength(key) <= maxFieldKeyBytes
	);
}
