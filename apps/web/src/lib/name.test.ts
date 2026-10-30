/**
 * Name Tests
 *
 * Key behaviors:
 * - An owner or repository name is a letter, then lowercase letters, digits and `-`
 * - No name can be `_app`, where the build serves files, or an app's hostname
 */
import { expect, test } from 'bun:test';
import { isHostname } from '@epicenter/app';
import { NAME } from './name.js';

test('a name starts with a letter and holds lowercase letters, digits and -', () => {
	for (const name of ['me', 'home', 'team', 'shared-1a2b', 'a'])
		expect(NAME.test(name)).toBe(true);
	for (const name of [
		'-',
		'_app',
		'',
		'1home',
		'Home',
		'my_repo',
		'a.b',
		'-home',
	])
		expect(NAME.test(name)).toBe(false);
});

test('no name is an app hostname, so an address names an owner, a repository, then an app', () => {
	for (const name of ['me', 'home', 'todos', 'files'])
		expect(isHostname(name)).toBe(false);
	for (const hostname of ['todos.epicenter.so', 'files.epicenter.so'])
		expect(NAME.test(hostname)).toBe(false);
});
