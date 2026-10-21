/**
 * Which apps the Folders window offers.
 *
 * Key behaviors:
 * - Every bundled app is offered once, by title, whatever files the folder
 *   holds; each app supplies its own table schemas
 */
import { expect, test } from 'bun:test';
import { bundledOpeners } from './openers.ts';

test('every bundled app is offered once, by title', () => {
	expect(bundledOpeners).toEqual([
		{ app: 'capture', title: 'Capture' },
		{ app: 'honeycrisp', title: 'Honeycrisp' },
		{ app: 'messages', title: 'Messages' },
		{ app: 'todos', title: 'Todos' },
		{ app: 'whispering', title: 'Whispering' },
	]);
});
