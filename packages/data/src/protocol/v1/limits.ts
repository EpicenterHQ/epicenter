/**
 * Parameterized V1 admission limits and their mandatory validator.
 *
 * ADR-0163 fixes the shape of the scalar protocol but deliberately leaves the
 * exact byte and count ceilings open until the Wave 2e browser, Bun, and
 * Cloudflare scale proof measures them. So the kernel never freezes a numeric
 * product constant: every parser, byte measurement, and the authority reference
 * model take limits, and tests supply their own.
 *
 * But a raw limits object cannot be trusted, and it arrives as unknown input.
 * `validateLimits` is total: a non-plain object, a missing or extra key, a
 * non-number value, or even a throwing proxy returns a typed `Invalid` instead
 * of throwing. It is also the single mandatory gate: it proves the ceilings are
 * safe non-negative integers and,
 * crucially, that the response ceilings actually fit the worst case they must
 * carry. The response envelope is derived here arithmetically from fixed
 * canonical skeleton costs plus the byte ceilings, never trusted as a
 * caller-asserted constant and never allocated proportional to a raw ceiling, so
 * even a `Number.MAX_SAFE_INTEGER` ceiling refuses cleanly instead of throwing
 * or exhausting memory. The derivation models the worst-case canonical
 * expansion of an opaque control-character lifetime and the terminal
 * `hasMore:false` spelling. Only `validateLimits` mints the opaque, sealed
 * `ValidatedLimits` that every authority operation and parser requires.
 */
import { Ok, type Result } from 'wellcrafted/result';

import {
	canonicalize,
	deepFreeze,
	isPlainDataObject,
	utf8ByteLength,
} from './canonical.js';
import { catchAsInvalid, ScalarProtocolError } from './errors.js';
import type { JsonLimits } from './json.js';

export type ScalarSyncLimits = JsonLimits & {
	/** Maximum UTF-8 bytes of a namespace key. */
	maxNamespaceBytes: number;
	/** Maximum UTF-8 bytes of a table key. */
	maxTableKeyBytes: number;
	/** Maximum UTF-8 bytes of a value key. */
	maxValueKeyBytes: number;
	/** Maximum UTF-8 bytes of an opaque authority-lifetime identity. */
	maxLifetimeBytes: number;
	/** Maximum UTF-8 bytes of a top-level field key inside a row payload. */
	maxFieldKeyBytes: number;
	/** Maximum number of unset field keys in one row-present intent. */
	maxUnsetKeysPerIntent: number;
	/** Maximum canonical-encoded bytes of one fact. */
	maxEncodedFactBytes: number;
	/** Maximum canonical-encoded bytes of one facts response. */
	maxFactsResponseBytes: number;
	/** Maximum canonical-encoded bytes of one submission request. */
	maxSubmissionBytes: number;
	/** Maximum canonical-encoded bytes of one submission response. */
	maxSubmissionResponseBytes: number;
	/** Maximum number of distinct addresses in one submission. */
	maxSubmissionAddresses: number;
};

declare const validated: unique symbol;

/**
 * Limits proven consistent by `validateLimits`. Only that function mints this
 * type, so every operation that requires it is guaranteed self-consistent
 * limits without re-checking. The runtime value is deep-frozen.
 */
export type ValidatedLimits = Readonly<ScalarSyncLimits> & {
	readonly [validated]: true;
};

/**
 * A derived minimum that overflowed the JSON-safe integer range. Reported as
 * positive infinity so a capacity check against any real (safe-integer) ceiling
 * always fails, forcing `validateLimits` to reject rather than throw or allocate.
 */
const NOT_REPRESENTABLE = Number.POSITIVE_INFINITY;

/** Sum that saturates to NOT_REPRESENTABLE outside the safe-integer range. */
function checkedAdd(left: number, right: number): number {
	const sum = left + right;
	return Number.isSafeInteger(sum) ? sum : NOT_REPRESENTABLE;
}

/** Product that saturates to NOT_REPRESENTABLE outside the safe-integer range. */
function checkedMul(left: number, right: number): number {
	const product = left * right;
	return Number.isSafeInteger(product) ? product : NOT_REPRESENTABLE;
}

// Fixed canonical skeleton costs, measured once from empty-lifetime, empty-array
// values, so no string is ever allocated proportional to a raw byte ceiling.
// The facts envelope uses the terminal `hasMore:false`, whose spelling is one
// byte longer than `true`, so a terminal maximum-size fact still fits.
const FACTS_ENVELOPE_SKELETON = utf8ByteLength(
	canonicalize({ authorityLifetime: '', facts: [], hasMore: false }),
);
const SUBMISSION_ENVELOPE_SKELETON = utf8ByteLength(
	canonicalize({ authorityLifetime: '', facts: [], parked: [] }),
);
const PARKED_SKELETON = utf8ByteLength(
	canonicalize({
		address: { kind: 'row', namespace: '', rowId: 'a'.repeat(24), table: '' },
		code: 'fact-too-large',
		limitBytes: Number.MAX_SAFE_INTEGER,
		measuredBytes: Number.MAX_SAFE_INTEGER,
	}),
);
// A NUL is one UTF-8 byte but escapes to six canonical bytes, the largest
// per-byte expansion of a well-formed string, so the opaque lifetime content
// costs at most six bytes per lifetime byte.
const LIFETIME_CANONICAL_EXPANSION = 6;

/** Canonical-encoded content bytes of the worst-case opaque lifetime. */
function worstLifetimeBytes(maxLifetimeBytes: number): number {
	return checkedMul(LIFETIME_CANONICAL_EXPANSION, maxLifetimeBytes);
}

/**
 * Canonical-encoded bytes of the worst-case parked entry: a maximal row address
 * (ASCII namespace and table canonicalize byte-for-byte) with maximal integer
 * measurements. Computed arithmetically from the fixed skeleton.
 */
function worstParkedEntryBytes(limits: ScalarSyncLimits): number {
	return checkedAdd(
		checkedAdd(PARKED_SKELETON, limits.maxNamespaceBytes),
		limits.maxTableKeyBytes,
	);
}

/**
 * The smallest facts-response ceiling that can carry one maximum-size terminal
 * fact plus the response envelope at a worst-case maximal lifetime. Returns
 * `NOT_REPRESENTABLE` (positive infinity) when the derived minimum overflows the
 * safe-integer range.
 */
export function minimumFactsResponseBytes(limits: ScalarSyncLimits): number {
	return checkedAdd(
		checkedAdd(
			FACTS_ENVELOPE_SKELETON,
			worstLifetimeBytes(limits.maxLifetimeBytes),
		),
		limits.maxEncodedFactBytes,
	);
}

/**
 * The smallest submission-response ceiling that can carry one maximum-size fact
 * for every touched address plus a full set of maximum parked entries and the
 * response envelope at a worst-case maximal lifetime. This is the ADR-0163
 * settlement inequality, derived arithmetically rather than trusted. Returns
 * `NOT_REPRESENTABLE` when the derived minimum overflows the safe-integer range.
 */
export function minimumSubmissionResponseBytes(
	limits: ScalarSyncLimits,
): number {
	const count = limits.maxSubmissionAddresses;
	const commas = Math.max(0, count - 1);
	const factsPart = checkedAdd(
		checkedMul(count, limits.maxEncodedFactBytes),
		commas,
	);
	const parkedPart = checkedAdd(
		checkedMul(count, worstParkedEntryBytes(limits)),
		commas,
	);
	return checkedAdd(
		checkedAdd(
			checkedAdd(
				SUBMISSION_ENVELOPE_SKELETON,
				worstLifetimeBytes(limits.maxLifetimeBytes),
			),
			factsPart,
		),
		parkedPart,
	);
}

function isNonNegativeSafeInteger(value: number): boolean {
	return Number.isSafeInteger(value) && value >= 0;
}

/** Keys whose ceiling has no meaningful zero and must be at least one. */
const POSITIVE_LIMIT_KEYS = [
	'jsonDepth',
	'maxNamespaceBytes',
	'maxTableKeyBytes',
	'maxValueKeyBytes',
	'maxLifetimeBytes',
	'maxFieldKeyBytes',
	'maxEncodedFactBytes',
	'maxFactsResponseBytes',
	'maxSubmissionBytes',
	'maxSubmissionResponseBytes',
	'maxSubmissionAddresses',
] as const satisfies readonly (keyof ScalarSyncLimits)[];

/** Keys whose zero is meaningful (an empty allowance). */
const NON_NEGATIVE_LIMIT_KEYS = [
	'propertiesPerObject',
	'maxUnsetKeysPerIntent',
] as const satisfies readonly (keyof ScalarSyncLimits)[];

function exhaustiveLimitKeys<
	const Keys extends readonly (keyof ScalarSyncLimits)[],
>(
	keys: Keys &
		(Exclude<keyof ScalarSyncLimits, Keys[number]> extends never
			? unknown
			: never),
): Keys {
	return keys;
}

/** The exact set of limits keys. The two groups partition it with none spare. */
const ALL_LIMIT_KEYS = exhaustiveLimitKeys([
	...POSITIVE_LIMIT_KEYS,
	...NON_NEGATIVE_LIMIT_KEYS,
]);

/**
 * Validate an untrusted limits object into opaque, sealed `ValidatedLimits`.
 *
 * Total over unknown input: a non-plain object, a missing or extra key, a
 * non-number value, or a throwing proxy returns a typed `Invalid` rather than
 * throwing. On a well-shaped object it proves that every ceiling is a safe
 * non-negative integer, that the fields with no meaningful zero are at least
 * one, that the facts response can hold one maximum terminal fact, and that the
 * submission response satisfies the settlement inequality with maximum parked
 * metadata. A derived minimum that overflows the safe-integer range refuses (its
 * capacity check fails against the finite ceiling). Returns a fresh, detached,
 * deep-frozen, branded value built from the validated numbers, never the
 * caller's object.
 */
export function validateLimits(
	raw: unknown,
): Result<ValidatedLimits, ScalarProtocolError> {
	return catchAsInvalid('limits', () => {
		// Exact shape over unknown input. `raw` must be a plain data object (no
		// prototype tricks, symbol keys, or accessors) with exactly the limits
		// keys. A throwing proxy trips a reflection trap in `isPlainDataObject` or
		// `Object.keys` and is converted to a typed Invalid by `catchAsInvalid`, so
		// nothing below ever sees hostile input.
		if (typeof raw !== 'object' || raw === null || !isPlainDataObject(raw)) {
			return ScalarProtocolError.Invalid({ boundary: 'limits' });
		}
		const record = raw as Record<string, unknown>;
		if (Object.keys(record).length !== ALL_LIMIT_KEYS.length) {
			return ScalarProtocolError.Invalid({ boundary: 'limits' });
		}
		// Read each expected own key into a fresh, detached object; every value must
		// be a number. Exactly N own keys plus every expected key present leaves no
		// key missing or extra. Define immutable data properties directly so a
		// polluted Object.prototype setter cannot intercept construction.
		const clean = {} as Record<keyof ScalarSyncLimits, number>;
		for (const key of ALL_LIMIT_KEYS) {
			if (!Object.hasOwn(record, key)) {
				return ScalarProtocolError.Invalid({ boundary: `limits.${key}` });
			}
			const value = record[key];
			if (typeof value !== 'number') {
				return ScalarProtocolError.Invalid({ boundary: `limits.${key}` });
			}
			Object.defineProperty(clean, key, {
				configurable: false,
				enumerable: true,
				value,
				writable: false,
			});
		}
		for (const key of POSITIVE_LIMIT_KEYS) {
			if (!isNonNegativeSafeInteger(clean[key]) || clean[key] < 1) {
				return ScalarProtocolError.Invalid({ boundary: `limits.${key}` });
			}
		}
		for (const key of NON_NEGATIVE_LIMIT_KEYS) {
			if (!isNonNegativeSafeInteger(clean[key])) {
				return ScalarProtocolError.Invalid({ boundary: `limits.${key}` });
			}
		}
		const candidate = clean as ScalarSyncLimits;
		if (
			candidate.maxFactsResponseBytes < minimumFactsResponseBytes(candidate)
		) {
			return ScalarProtocolError.Invalid({
				boundary: 'limits.factsResponseCapacity',
			});
		}
		if (
			candidate.maxSubmissionResponseBytes <
			minimumSubmissionResponseBytes(candidate)
		) {
			return ScalarProtocolError.Invalid({
				boundary: 'limits.submissionResponseCapacity',
			});
		}
		// Detached (a fresh object, never the caller's) and deep-frozen before
		// branding, so no post-admission mutation can reach the validated limits.
		return Ok(deepFreeze(clean) as ValidatedLimits);
	});
}
