/**
 * Typed refusal shapes for the scalar V1 kernel.
 *
 * Two concerns, two error groups:
 *
 * - `ScalarProtocolError` covers parsing and admission of untrusted wire input.
 *   One `Invalid` variant names the boundary that rejected, mirroring the
 *   existing protocol package convention.
 * - `AuthorityError` covers the reference authority's semantic refusals against
 *   otherwise well-formed requests: a superseded lifetime, a replica fork, a
 *   skipped submission number, or a corrupt sequence-ahead read. These are not
 *   parse failures; they describe how live authority state rejected the caller.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';

export const ScalarProtocolError = defineErrors({
	Invalid: ({ boundary }: { boundary: string }) => ({
		message: `Invalid scalar V1 ${boundary}`,
		boundary,
	}),
});
export type ScalarProtocolError = InferErrors<typeof ScalarProtocolError>;

/**
 * Run a parse/admission body and convert any thrown reflection, canonicalization,
 * or structuredClone failure into a typed `Invalid` result. This is what makes
 * every public admission boundary total: a throwing Proxy, a value
 * `structuredClone` cannot own, or any other host exception becomes a typed
 * refusal instead of escaping the boundary.
 */
export function catchAsInvalid<T>(
	boundary: string,
	run: () => Result<T, ScalarProtocolError>,
): Result<T, ScalarProtocolError> {
	try {
		return run();
	} catch {
		return ScalarProtocolError.Invalid({ boundary });
	}
}

export const AuthorityError = defineErrors({
	/** The request's authority lifetime does not equal the live authority's. */
	LifetimeMismatch: ({
		requested,
		active,
	}: {
		requested: string;
		active: string;
	}) => ({
		message: 'Request lifetime does not match the active authority lifetime',
		requested,
		active,
	}),
	/** A facts read asked for a sequence beyond the live authority in the same lifetime. */
	SequenceAhead: ({
		requestedAfterSequence,
		activeSequence,
	}: {
		requestedAfterSequence: number;
		activeSequence: number;
	}) => ({
		message: 'Facts read is ahead of the active authority sequence',
		requestedAfterSequence,
		activeSequence,
	}),
	/** A submission reused a completed number with different semantic content. */
	SubmissionFork: ({ submissionNumber }: { submissionNumber: number }) => ({
		message: 'Submission number was reused with different content',
		submissionNumber,
	}),
	/** A submission skipped ahead of, or fell behind, the expected next number. */
	SubmissionGap: ({
		submissionNumber,
		expectedNumber,
	}: {
		submissionNumber: number;
		expectedNumber: number;
	}) => ({
		message: 'Submission number is not the expected next number',
		submissionNumber,
		expectedNumber,
	}),
	/** Assigning the next sequence would exceed the JSON-safe integer range. */
	SequenceExhausted: ({ nextSequence }: { nextSequence: number }) => ({
		message: 'Authority sequence space is exhausted',
		nextSequence,
	}),
});
export type AuthorityError = InferErrors<typeof AuthorityError>;
