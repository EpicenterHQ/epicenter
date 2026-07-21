/**
 * Shared test fixtures for the scalar V1 kernel.
 *
 * `makeLimits` is the one place tests obtain limits, so every test runs against
 * the same mandatory validator the authority uses. The base numbers are a valid
 * self-consistent set for the test grammar; they are test-only and freeze no
 * product constant. Overrides re-run validation, so a test that needs a tight
 * ceiling still proves its limits are internally consistent (or asserts the
 * validator rejects them via `validateLimits` directly).
 *
 * This module is test-only fixtures, not part of the kernel. The
 * `*.test-support.ts` suffix keeps it out of the published package (see the
 * `files` exclusion in package.json, parallel to `*.test.ts`) and out of the
 * `bun test` file set, while still letting `*.test.ts` import it.
 */
import type { Result } from 'wellcrafted/result';

import {
	type AdmittedFactsRequest,
	type AdmittedSubmissionRequest,
	type AuthorityState,
	createAuthority,
	type FactsRequest,
	parseFactsRequest,
	parseSubmissionRequest,
	type ScalarSyncLimits,
	type SubmissionRequest,
	type ValidatedLimits,
	validateLimits,
} from './index.js';

/**
 * Unwrap a Result or throw its message. Kept local so this fixtures module does
 * not depend on `wellcrafted/testing` (a smell in shippable `src`).
 */
function unwrap<T>(result: Result<T, { message: string }>): T {
	if (result.error !== null) throw new Error(result.error.message);
	return result.data;
}

export const BASE_LIMITS: ScalarSyncLimits = {
	jsonDepth: 16,
	propertiesPerObject: 1024,
	maxNamespaceBytes: 128,
	maxTableKeyBytes: 64,
	maxValueKeyBytes: 64,
	maxLifetimeBytes: 64,
	maxFieldKeyBytes: 128,
	maxUnsetKeysPerIntent: 64,
	maxEncodedFactBytes: 4096,
	maxFactsResponseBytes: 262144,
	maxSubmissionBytes: 262144,
	maxSubmissionResponseBytes: 1048576,
	maxSubmissionAddresses: 64,
};

/** Build validated limits from the base set plus overrides. Throws if invalid. */
export function makeLimits(
	overrides: Partial<ScalarSyncLimits> = {},
): ValidatedLimits {
	return unwrap(validateLimits({ ...BASE_LIMITS, ...overrides }));
}

/** Admit a facts request through the real parser, as the authority requires. */
export function admitFacts(
	raw: FactsRequest,
	limits: ValidatedLimits,
): AdmittedFactsRequest {
	return unwrap(parseFactsRequest(raw, limits));
}

/** Admit a submission through the real parser, as the authority requires. */
export function admitSubmission(
	raw: SubmissionRequest,
	limits: ValidatedLimits,
): AdmittedSubmissionRequest {
	return unwrap(parseSubmissionRequest(raw, limits));
}

/** Construct a fresh authority under an admitted lifetime. Throws if invalid. */
export function makeAuthority(
	lifetime: string,
	limits: ValidatedLimits,
): AuthorityState {
	return unwrap(createAuthority(lifetime, limits));
}
