import {
	LOCAL_KEY_PATTERN,
	NAMESPACE_PATTERN,
	VALUES_KEY_PATTERN,
} from '../protocol/v1/addresses.js';

// The protocol owns the grammar strings (one admission law); these predicates
// are the Lens-authoring view of the same law.
const NAMESPACE_REGEXP = new RegExp(NAMESPACE_PATTERN);
const LOCAL_KEY_REGEXP = new RegExp(LOCAL_KEY_PATTERN);
const VALUES_KEY_REGEXP = new RegExp(VALUES_KEY_PATTERN);

/**
 * Returns whether a value matches the reverse-domain namespace grammar
 * `^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$`.
 */
export function isLensNamespace(value: string): boolean {
	return NAMESPACE_REGEXP.test(value);
}

/** Returns whether a value matches the Lens local-key grammar `^[A-Za-z][A-Za-z0-9_]*$`. */
export function isLensLocalKey(value: string): boolean {
	return LOCAL_KEY_REGEXP.test(value);
}

/**
 * Returns whether a value matches the values record-key grammar: one or more
 * dot-separated local-key segments (`transcription.language`). Collection and
 * field keys stay undotted; only a values collection's declared record keys
 * admit dots (ADR-0163's address grammar, widened at W4A1).
 */
export function isLensValuesKey(value: string): boolean {
	return VALUES_KEY_REGEXP.test(value);
}
