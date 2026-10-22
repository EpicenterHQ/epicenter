/**
 * Commit Subject Golden Vector Tests
 *
 * `fixtures/commit-subjects.txt` pins the subjects `commitSubject` writes, so
 * changing one is a reviewed change to that file.
 *
 * Key behaviors:
 * - The committed fixture equals the output of the current `commitSubject`
 * - The fixture exercises the 72 UTF-16 code unit limit on both sides of it
 */
import { describe, expect, test } from 'bun:test';
import { renderVectors, VECTORS_PATH } from './commit-subject-vectors.js';
import { commitSubject, escapePath, messageProblem } from './messages.js';

test('the committed fixture is what commitSubject produces now', async () => {
	expect(await Bun.file(VECTORS_PATH).text()).toBe(renderVectors());
});

test('the fixture holds subjects at the limit and fallbacks just past it', () => {
	const decode = (hex: string) =>
		new TextDecoder().decode(
			Uint8Array.from(hex.match(/../g) ?? [], (byte) =>
				Number.parseInt(byte, 16),
			),
		);
	const subjects = renderVectors()
		.split('\n')
		.filter((line) => line !== '' && !line.startsWith('#'))
		.map((line) => line.split('\t')[0] ?? '')
		.filter((subject) => subject !== '-')
		.map(decode);
	expect(
		subjects.filter((subject) => subject.length === 72).length,
	).toBeGreaterThan(3);
	expect(
		subjects.filter((subject) => subject === 'Update 1 file').length,
	).toBeGreaterThan(3);
	expect(Math.max(...subjects.map((subject) => subject.length))).toBe(72);
});

describe('commit subjects', () => {
	test('name one path by its change and count several', () => {
		expect(commitSubject([{ path: 'todos/a.md', kind: 'add' }])).toBe(
			'Add todos/a.md',
		);
		expect(commitSubject([{ path: 'todos/a.md', kind: 'modify' }])).toBe(
			'Update todos/a.md',
		);
		expect(commitSubject([{ path: 'todos/a.md', kind: 'delete' }])).toBe(
			'Delete todos/a.md',
		);
		expect(
			commitSubject([
				{ path: 'todos/a.md', kind: 'delete' },
				{ path: 'todos/b.md', kind: 'add' },
			]),
		).toBe('Update 2 files');
		expect(commitSubject([])).toBeUndefined();
	});

	test('escape control characters and fall back past 72 characters', () => {
		expect(escapePath('a\nb\\c')).toBe('a\\x0ab\\\\c');
		expect(commitSubject([{ path: 'x\ny.md', kind: 'add' }])).toBe(
			'Add x\\x0ay.md',
		);
		expect(
			commitSubject([{ path: `${'a'.repeat(70)}.md`, kind: 'modify' }]),
		).toBe('Update 1 file');
	});

	test('user messages must be nonempty and free of control characters', () => {
		expect(messageProblem('  ')).toBeDefined();
		expect(messageProblem('ok\x00')).toBeDefined();
		expect(messageProblem('Fix typo\n\nDetails')).toBeUndefined();
	});
});
