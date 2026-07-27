/**
 * The V1 product ceilings (ADR-0163).
 *
 * The kernel deliberately freezes no number: every parser and the authority take
 * `ValidatedLimits`, so tests supply their own. This module is the one place the
 * shipped product chooses them, validated once at import because a malformed
 * product constant is a programming error, not runtime input.
 *
 * ## Where the numbers come from
 *
 * Every coordinate, field-key, JSON, and per-fact ceiling is carried over
 * unchanged from the combined-exchange protocol it replaces, so no user-visible
 * promise moves: a row may still hold 508 KiB of encoded scalar fields, a
 * namespace 128 bytes, a value name 128, a field key 512.
 *
 * ## Why the submission grouping shrank from 64 addresses to 8
 *
 * ADR-0163's settlement inequality is not optional arithmetic. Submission
 * settlement is not paged, and every touched address returns its current fact,
 * so the response ceiling must cover `maxSubmissionAddresses` maximum-size facts
 * plus a full set of parked entries. At the old batch grouping of 64 intents
 * that derives a 31.77 MiB minimum submission response, which no Cloudflare
 * Worker can hold or return.
 *
 * Two ceilings could give: the per-fact size or the address count. Shrinking the
 * per-fact ceiling would shrink how much a row may hold, which is a product
 * promise. Shrinking the address count only resizes a transport group, which
 * ADR-0164 states outright is "never an application commit and carries no
 * product semantics" and "may be resized, renamed, split, or deleted without
 * changing the application contract". Because scalar addresses converge
 * independently, splitting the same pending work across more numbered
 * submissions is semantically free: it costs round trips, never correctness or
 * atomicity, because there was no atomicity to lose.
 *
 * So the count gives. Eight addresses derive a 3.97 MiB minimum, and the
 * configured 5 MiB ceiling clears it with headroom.
 *
 * ## Status
 *
 * ADR-0163 requires a browser, Bun, and Cloudflare scale proof to fix the exact
 * V1 constants before it may become Accepted. These are the derived, coherent
 * set that proof starts from, not its conclusion. They may widen in a later
 * compatible protocol revision but cannot silently shrink.
 */

import type { ScalarSyncLimits, ValidatedLimits } from './limits.js';
import { validateLimits } from './limits.js';

const PRODUCT_LIMITS: ScalarSyncLimits = {
	jsonDepth: 16,
	propertiesPerObject: 1_024,

	// Address coordinates, unchanged from the protocol this replaces.
	maxNamespaceBytes: 128,
	maxTableKeyBytes: 64,
	maxValueKeyBytes: 128,

	/**
	 * An opaque equality-only authority-lifetime identity. Sized for a ULID (26
	 * characters) with room for a longer opaque spelling; nothing parses it.
	 */
	maxLifetimeBytes: 64,

	// Row payload shape, unchanged.
	maxFieldKeyBytes: 512,
	maxUnsetKeysPerIntent: 128,

	/** The row-size promise: 508 KiB of canonical encoded fact. Unchanged. */
	maxEncodedFactBytes: 508 * 1024,

	/**
	 * One facts page. Matches the old page ceiling, and comfortably clears the
	 * derived minimum (one maximum fact plus envelope, ~509 KiB).
	 */
	maxFactsResponseBytes: 8 * 1024 * 1024,

	/** One submission request. Matches the old batch ceiling. */
	maxSubmissionBytes: 768 * 1024,

	/** See the grouping note above: eight addresses derive a 3.97 MiB minimum. */
	maxSubmissionAddresses: 8,
	maxSubmissionResponseBytes: 5 * 1024 * 1024,
};

/**
 * The validated V1 product ceilings.
 *
 * Validation runs at import. These are source constants, so a failure is a bug
 * in this file rather than a condition any caller could handle, and it must stop
 * the process rather than ship a protocol whose response bounds do not hold.
 */
export const SCALAR_V1_LIMITS: ValidatedLimits = (() => {
	const { data, error } = validateLimits(PRODUCT_LIMITS);
	if (error !== null) {
		throw new Error(`V1 product limits are inconsistent: ${error.message}`);
	}
	return data;
})();
