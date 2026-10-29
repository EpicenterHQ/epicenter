/**
 * Name Tests
 *
 * Key behaviors:
 * - An owner or repository name is a letter, then lowercase letters, digits and `-`
 * - No name can be the shell's own segment `-`, or `_app`, where its build serves files
 */
import { expect, test } from 'bun:test';
import { NAME } from './name.js';

test('a name starts with a letter and holds lowercase letters, digits and -', () => {
	for (const name of ['me', 'home', 'team', 'shared-1a2b', 'a']) expect(NAME.test(name)).toBe(true);
	for (const name of ['-', '_app', '', '1home', 'Home', 'my_repo', 'a.b', '-home']) expect(NAME.test(name)).toBe(false);
});
