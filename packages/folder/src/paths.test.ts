import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathProblem, holdsIgnorable } from './paths.js';

/** The vectors `paths.rs` reads too, so the engine and the desktop shell agree. */
const rules = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			'../../tauri-plugin-epicenter-folder/fixtures/path-rules.json',
		),
		'utf8',
	),
) as { refused: string[]; allowed: string[] };

describe('pathProblem follows the shared path rules', () => {
	test.each(rules.refused)('refuses %p', (path) => {
		expect(pathProblem(path)).toBeString();
	});
	test.each(rules.allowed)('allows %p', (path) => {
		expect(pathProblem(path)).toBeUndefined();
	});
});

test('the ignorable code points are exactly the ones the earlier character class matched', () => {
	// The class this table replaced, built from text so no linter reads it as
	// a pattern that runs combining marks together with their neighbors.
	const earlier = new RegExp(
		'[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180B-\\u180F\\u200B-\\u200F\\u202A-\\u202E\\u2060-\\u206F\\u3164\\uFE00-\\uFE0F\\uFEFF\\uFFA0\\uFFF0-\\uFFF8\\u{1BCA0}-\\u{1BCA3}\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E0FFF}]',
		'u',
	);
	const differ: number[] = [];
	for (let point = 0; point <= 0x10ffff; point++) {
		const char = String.fromCodePoint(point);
		if (earlier.test(char) !== holdsIgnorable(char)) differ.push(point);
	}
	expect(differ).toEqual([]);
	expect(holdsIgnorable('café')).toBe(false);
	expect(holdsIgnorable('a‍b')).toBe(true);
});
