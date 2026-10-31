/**
 * Todos' order: both variants sort the list they read, the desktop folder's or
 * the repository's, with `openFirst`.
 *
 * Key behaviors:
 * - Open todos come first, then done ones, each oldest first
 */
import { expect, test } from 'bun:test';
import type { Version } from '@epicenter/definition/contract';
import { openFirst, type Todo } from './todos.js';

const todo = (id: string, done: boolean): Todo => ({
	id,
	title: id.toUpperCase(),
	done,
	body: '',
	version: '' as Version,
});

test('open todos come first, then done ones, each oldest first', () => {
	const sorted = [
		todo('c', false),
		todo('a', true),
		todo('d', true),
		todo('b', false),
	].toSorted(openFirst);
	expect(sorted.map(({ id }) => id)).toEqual(['b', 'c', 'a', 'd']);
});
