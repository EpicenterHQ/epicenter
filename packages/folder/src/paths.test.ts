import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collisionKey, pathProblem } from './paths.js';

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

test('names a case-insensitive disk holds as one fold to one key', () => {
	for (const [left, right] of [
		['Notes.md', 'notes.md'],
		['ΣΟΦΟΣ.md', 'σοφοσ.md'],
		['ς.md', 'σ.md'],
		['ß.md', 'ss.md'],
		['ﬀ.md', 'ff.md'],
		['ſ.md', 's.md'],
		['µm.md', 'μm.md'],
		['caf\u00e9.md', 'cafe\u0301.md'],
	])
		expect(collisionKey(left!)).toBe(collisionKey(right!));
	expect(collisionKey('a.md')).not.toBe(collisionKey('b.md'));
});
