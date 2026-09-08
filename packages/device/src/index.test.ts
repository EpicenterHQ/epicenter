/**
 * The two names an application mints.
 *
 * They are checked where they are minted rather than on every call (ADR-0339),
 * and the mint throws, because a name reaching it is a constant in a build.
 * This test moved here with the mints when the storage half left
 * `@epicenter/app`.
 */

import { expect, test } from 'bun:test';
import { secretLabel } from './index.js';
import { isDatabaseName } from './protocol.js';

test('a database name is checked at the scoped capability boundary', () => {
	expect(isDatabaseName('../mail')).toBe(false);
	expect(isDatabaseName('Mail')).toBe(false);
	expect(isDatabaseName('mail')).toBe(true);

	expect(() => secretLabel('../other')).toThrow('is not valid');
	expect(() => secretLabel('a/b')).toThrow('is not valid');
	expect(String(secretLabel('sub-one'))).toBe('sub-one');
});
