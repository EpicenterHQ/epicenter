import { expect, test } from 'bun:test';
import type { GitObject } from '../../git/raw-objects.js';
import { includesCommit } from './ancestry.js';

test('ancestry follows second parents and distinguishes a missing parent from exclusion', () => {
	const commit = (parents: string[]): GitObject => ({
		type: 'commit',
		bytes: new TextEncoder().encode(
			`tree ${'f'.repeat(40)}\n${parents.map((parent) => `parent ${parent}\n`).join('')}\n`,
		),
	});
	const tip = 'a'.repeat(40),
		missing = 'b'.repeat(40),
		target = 'c'.repeat(40),
		other = 'd'.repeat(40);
	const objects = new Map([[tip, commit([missing, target])]]);
	expect(includesCommit({ tip, target, objects })).toBe('included');
	expect(includesCommit({ tip, target: other, objects })).toBe('unknown');
	objects.set(missing, commit([]));
	objects.set(target, commit([]));
	expect(includesCommit({ tip, target: other, objects })).toBe('excluded');
});
