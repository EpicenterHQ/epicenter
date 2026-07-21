/**
 * Bind the modular trace to the private Scalar Sync V1 kernel.
 *
 * The frozen pilot requires that "representative generated facts" are the private
 * V1 parser's admitted facts, not a look-alike corpus. This module is that gate.
 * For a bounded, deterministic sample of the trace's final facts and its build/
 * aging events, it proves three things against the real kernel:
 *
 * 1. every generated fact is accepted by `parseFact` under real `ValidatedLimits`
 *    and round-trips structurally (the trace cannot emit a fact the protocol
 *    would reject on the wire);
 * 2. the trace's own byte oracle equals the kernel's:
 *    `utf8Len(canonicalFactRecord(fact)) === encodedFactBytes(fact)`; and
 * 3. every generated fact fits `maxEncodedFactBytes`.
 *
 * It also asserts that all four fact shapes (present/absent row, present/absent
 * value) were actually exercised, so a corpus that silently stopped producing a
 * shape cannot pass the gate vacuously.
 *
 * The kernel's `parseFact` runs the canonical-JSON tree gate, the closed schema
 * check, and semantic admission, so a pass here is exactly the wire admission the
 * authority would perform. Hashing and byte measurement stay portable; only this
 * binding reaches into the kernel, and it is pure (no SQLite, no wall clock).
 */

import { canonicalize } from '../../../packages/data/src/protocol/v1/canonical.js';
import {
	encodedFactBytes,
	parseFact,
} from '../../../packages/data/src/protocol/v1/facts.js';
import {
	minimumFactsResponseBytes,
	minimumSubmissionResponseBytes,
	type ScalarSyncLimits,
	type ValidatedLimits,
	validateLimits,
} from '../../../packages/data/src/protocol/v1/limits.js';
import {
	canonicalFactRecord,
	type Fact,
	type Trace,
	utf8Len,
} from './trace.js';

/**
 * Generous, self-consistent pilot limits. The pilot measures physical layout,
 * not V1 constant selection (Wave 2e owns that), so these ceilings only need to
 * admit the trace's representative facts. `validateLimits` still proves the
 * settlement inequality, so these are real `ValidatedLimits`, never a bypass.
 */
export function pilotLimits(
	overrides: Partial<ScalarSyncLimits> = {},
): ValidatedLimits {
	// Ceilings that do not depend on the response derivation. `maxEncodedFactBytes`
	// (64 KiB) comfortably admits the trace's largest calibrated fact at any pilot
	// profile while keeping the derived submission-response bound modest.
	const core: ScalarSyncLimits = {
		jsonDepth: 32,
		propertiesPerObject: 4096,
		maxNamespaceBytes: 128,
		maxTableKeyBytes: 128,
		maxValueKeyBytes: 128,
		maxLifetimeBytes: 128,
		maxFieldKeyBytes: 128,
		maxUnsetKeysPerIntent: 256,
		maxEncodedFactBytes: 64 << 10,
		maxSubmissionBytes: 8 << 20,
		maxSubmissionAddresses: 64,
		// Placeholders, replaced below by the kernel's own minimums so the limits are
		// self-consistent for whatever fact ceiling and address count survive overrides.
		maxFactsResponseBytes: 0,
		maxSubmissionResponseBytes: 0,
		...overrides,
	};
	const base: ScalarSyncLimits = {
		...core,
		maxFactsResponseBytes:
			overrides.maxFactsResponseBytes ?? minimumFactsResponseBytes(core),
		maxSubmissionResponseBytes:
			overrides.maxSubmissionResponseBytes ??
			minimumSubmissionResponseBytes(core),
	};
	const { data, error } = validateLimits(base);
	if (error !== null) {
		throw new Error(`pilot limits are not self-consistent: ${error.message}`);
	}
	return data;
}

export type V1BindingReport = {
	/** True only when every checked fact admitted, byte-agreed, and all shapes appeared. */
	bound: boolean;
	/** Number of distinct facts checked against the kernel. */
	checkedFacts: number;
	/** How many of each fact shape were exercised. */
	shapes: {
		rowPresent: number;
		rowAbsent: number;
		valuePresent: number;
		valueAbsent: number;
	};
	/** First few human-readable reasons the binding failed, empty when bound. */
	failures: string[];
};

export type V1BindingOptions = {
	/** Upper bound on final facts and event facts sampled (each). */
	sampleSize: number;
};

const DEFAULT_OPTIONS: V1BindingOptions = { sampleSize: 4096 };

function shapeOf(fact: Fact): keyof V1BindingReport['shapes'] {
	if (fact.address.kind === 'row') {
		return fact.presence === 'present' ? 'rowPresent' : 'rowAbsent';
	}
	return fact.presence === 'present' ? 'valuePresent' : 'valueAbsent';
}

/**
 * Check one fact against the kernel, accumulating shape coverage and up to a few
 * failure messages. Returns whether this fact passed.
 */
function checkFact(
	fact: Fact,
	limits: ValidatedLimits,
	shapes: V1BindingReport['shapes'],
	failures: string[],
): boolean {
	shapes[shapeOf(fact)] += 1;
	const record = canonicalFactRecord(fact);
	const traceBytes = utf8Len(record);
	const kernelBytes = encodedFactBytes(fact);
	let ok = true;
	if (traceBytes !== kernelBytes) {
		ok = false;
		if (failures.length < 8) {
			failures.push(
				`byte oracle disagreed at sequence ${fact.sequence}: trace ${traceBytes} vs kernel ${kernelBytes}`,
			);
		}
	}
	if (kernelBytes > limits.maxEncodedFactBytes) {
		ok = false;
		if (failures.length < 8) {
			failures.push(
				`fact at sequence ${fact.sequence} is ${kernelBytes} bytes, over the ${limits.maxEncodedFactBytes} ceiling`,
			);
		}
	}
	const { data, error } = parseFact(fact, limits);
	if (error !== null) {
		ok = false;
		if (failures.length < 8) {
			failures.push(
				`parseFact rejected the fact at sequence ${fact.sequence}: ${error.message}`,
			);
		}
	} else if (canonicalize(data) !== record) {
		ok = false;
		if (failures.length < 8) {
			failures.push(
				`parseFact did not round-trip the fact at sequence ${fact.sequence}`,
			);
		}
	}
	return ok;
}

/** Strided, deterministic indices covering [0, count) up to `sampleSize`. */
function stridedIndices(count: number, sampleSize: number): number[] {
	if (count <= 0) return [];
	if (count <= sampleSize) return Array.from({ length: count }, (_, i) => i);
	const step = count / sampleSize;
	const out: number[] = [];
	for (let k = 0; k < sampleSize; k += 1) out.push(Math.floor(k * step));
	return out;
}

/**
 * Verify that the trace's representative facts are admissible V1 facts and that
 * its byte oracle equals the kernel's. Deterministic: same trace and options
 * produce the same report.
 */
export function verifyTraceV1Binding(
	trace: Trace,
	limits: ValidatedLimits,
	options: V1BindingOptions = DEFAULT_OPTIONS,
): V1BindingReport {
	const shapes = {
		rowPresent: 0,
		rowAbsent: 0,
		valuePresent: 0,
		valueAbsent: 0,
	};
	const parseChecked = {
		rowPresent: false,
		rowAbsent: false,
		valuePresent: false,
		valueAbsent: false,
	};
	const failures: string[] = [];
	let checkedFacts = 0;
	let allPassed = true;

	// Walk the whole final corpus to count the true final-shape distribution (cheap:
	// finalFactAt is O(1) and this runs no parser). Parse-check every strided index
	// AND the FIRST occurrence of each of the four shapes, so all four wire shapes
	// (present/absent row, present/absent value) are admitted by the real kernel
	// parser, never assumed. This makes the binding non-vacuous for every shape the
	// corpus contains rather than only the present ones.
	const strideSet = new Set(
		stridedIndices(trace.options.facts, options.sampleSize),
	);
	for (let index = 0; index < trace.options.facts; index += 1) {
		const fact = trace.finalFactAt(index);
		const shape = shapeOf(fact);
		shapes[shape] += 1;
		const firstOfShape = !parseChecked[shape];
		if (firstOfShape || strideSet.has(index)) {
			if (!checkFact(fact, limits, shapes, failures)) allPassed = false;
			parseChecked[shape] = true;
			checkedFacts += 1;
		}
	}

	// Build/aging events: a prefix so the pre-final present facts (initial payload,
	// phase-1 rewrites, phase-2 resurrections) are parse-checked too, not only final
	// state. Their shape hits accumulate in a separate counter so the reported
	// distribution stays exactly the final-corpus scan above.
	let seen = 0;
	const eventShapes = {
		rowPresent: 0,
		rowAbsent: 0,
		valuePresent: 0,
		valueAbsent: 0,
	};
	for (const fact of trace.events()) {
		if (seen >= options.sampleSize) break;
		if (!checkFact(fact, limits, eventShapes, failures)) allPassed = false;
		checkedFacts += 1;
		seen += 1;
	}

	// A corpus that never exercised a shape must not pass vacuously: require all
	// four wire shapes to have been both present in the final corpus and admitted.
	const missingShapes: string[] = [];
	for (const shape of [
		'rowPresent',
		'rowAbsent',
		'valuePresent',
		'valueAbsent',
	] as const) {
		if (shapes[shape] === 0 || !parseChecked[shape]) missingShapes.push(shape);
	}
	if (missingShapes.length > 0) {
		allPassed = false;
		failures.push(
			`fact shapes never exercised or admitted: ${missingShapes.join(', ')}`,
		);
	}

	return { bound: allPassed, checkedFacts, shapes, failures };
}
