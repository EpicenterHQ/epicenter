import { expect, test } from 'bun:test';
import { assertNever } from './assert-never.js';

test('an unhandled case throws and names the value', () => {
	expect(() => assertNever({ name: 'Surprise' } as never)).toThrow(
		'Unhandled case: {"name":"Surprise"}',
	);
});
