import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHiddenPath, storedWithLfs } from '@epicenter/definition/contract';
import { pathProblem } from './paths.js';

/** The vectors `paths.rs` reads too, so the engine and the desktop shell agree. */
const rules = JSON.parse(
	readFileSync(
		join(
			import.meta.dir,
			'../../tauri-plugin-epicenter-folder/fixtures/path-rules.json',
		),
		'utf8',
	),
) as {
	refused: string[];
	allowed: string[];
	hidden: string[];
	visible: string[];
	byContent: string[];
	byStamp: string[];
};

describe('pathProblem follows the shared path rules', () => {
	test.each(rules.refused)('refuses %p', (path) => {
		expect(pathProblem(path)).toBeString();
	});
	test.each(rules.allowed)('allows %p', (path) => {
		expect(pathProblem(path)).toBeUndefined();
	});
});

describe('isHiddenPath follows the shared path rules', () => {
	test.each(rules.hidden)('hides %p', (path) => {
		expect(isHiddenPath(path)).toBe(true);
	});
	test.each(rules.visible)('shows %p', (path) => {
		expect(isHiddenPath(path)).toBe(false);
	});
});

describe('a listing names a file by its bytes or its stamp as the shell does', () => {
	test.each(rules.byContent)('names %p by its bytes', (path) => {
		expect(storedWithLfs(path)).toBe(false);
	});
	test.each(rules.byStamp)('names %p by its stamp', (path) => {
		expect(storedWithLfs(path)).toBe(true);
	});
});
