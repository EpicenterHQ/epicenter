import { defineErrors, type InferErrors } from 'wellcrafted/error';

import type { JsonObject, JsonValue } from '../protocol/v1/index.js';

export type ConformanceIssue = {
	field: string;
	kind: 'missing' | 'invalid';
	message: string;
};

export const LensParseError = defineErrors({
	InvalidShape: ({ path, expected }: { path: string; expected: string }) => ({
		message: `${path} must be ${expected}`,
		path,
		expected,
	}),
	InvalidNamespace: ({ namespace }: { namespace: string }) => ({
		message: `Invalid Lens namespace '${namespace}'`,
		namespace,
	}),
	InvalidLocalKey: ({ path, key }: { path: string; key: string }) => ({
		message: `${path} has invalid local key '${key}'`,
		path,
		key,
	}),
	ReservedName: ({ path, key }: { path: string; key: string }) => ({
		message: `${path} uses reserved name '${key}'`,
		path,
		key,
	}),
	UnrecognizedField: ({ path }: { path: string }) => ({
		message: `${path} must use the field.* vocabulary`,
		path,
	}),
	NestedReservedProperty: ({
		path,
		property,
	}: {
		path: string;
		property: string;
	}) => ({
		message: `${path} contains reserved property '${property}'`,
		path,
		property,
	}),
	UnknownOptionalField: ({ path, field }: { path: string; field: string }) => ({
		message: `${path} names unknown field '${field}'`,
		path,
		field,
	}),
	DuplicateOptionalField: ({
		path,
		field,
	}: {
		path: string;
		field: string;
	}) => ({
		message: `${path} repeats field '${field}'`,
		path,
		field,
	}),
});
export type LensParseError = InferErrors<typeof LensParseError>;

export const LensReadError = defineErrors({
	NonconformingRow: ({
		key,
		id,
		raw,
		issues,
	}: {
		key: string;
		id: string;
		raw: JsonObject;
		issues: readonly ConformanceIssue[];
	}) => ({
		message: `Stored row '${key}.${id}' does not satisfy the current definition`,
		key,
		id,
		raw,
		issues,
	}),
	NonconformingValue: ({ key, raw }: { key: string; raw: JsonValue }) => ({
		message: `Stored value '${key}' does not satisfy the current definition`,
		key,
		raw,
	}),
});
export type LensReadError = InferErrors<typeof LensReadError>;
export type NonconformingRowError = Extract<
	LensReadError,
	{ name: 'NonconformingRow' }
>;
export type NonconformingValueError = Extract<
	LensReadError,
	{ name: 'NonconformingValue' }
>;
