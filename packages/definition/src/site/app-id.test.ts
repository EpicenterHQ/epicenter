/**
 * What the app id grammar admits, and the question it now answers with a
 * refusal.
 *
 * `app-data.test.ts` covers the path-escape refusals because that is where the
 * damage would land. This file exists for the property those tests cannot
 * state: that reverse domain is REQUIRED, not merely what every first-party id
 * happens to look like. Nothing else can keep that true, because every id in
 * the repository already satisfies it, so a validator loosened back to bare
 * labels would pass every other check here.
 */

import { describe, expect, test } from 'bun:test';
import { isAppId } from './app-id.js';

describe('an app id is reverse domain (ADR-0204)', () => {
	test('every first-party application id is admitted', () => {
		for (const id of [
			'so.epicenter.honeycrisp',
			'so.epicenter.vocab',
			'so.epicenter.whispering',
			'so.epicenter.local-mail',
			'so.epicenter.local-books',
		]) {
			expect({ id, admitted: isAppId(id) }).toEqual({ id, admitted: true });
		}
	});

	test('a bare label is refused, however reasonable it looks', () => {
		// The predicate used to admit these, and the prose beside it explained
		// that an admitted folder names itself (ADR-0179). ADR-0204 withdrew that
		// clause and ADR-0227 refused the installed-app plane outright, so the
		// laxity was describing `local-books`, which had not taken ADR-0204's
		// rename, rather than a second issuer that still exists.
		for (const id of ['local-books', 'field-notes', 'notes', 'a']) {
			expect({ id, admitted: isAppId(id) }).toEqual({ id, admitted: false });
		}
	});

	test('two labels are enough, and no suffix is checked', () => {
		// Reverse domain is a shape, not a lookup. Nothing resolves DNS or demands
		// a registered suffix, because the id names a directory and a namespace,
		// not a host anyone connects to.
		expect(isAppId('a.b')).toBe(true);
		expect(isAppId('not.a.real.tld.at.all')).toBe(true);
	});
});

describe('the refusals that keep an id inside its root', () => {
	test('an id that could leave the data root is refused', () => {
		// `appDataDir` joins an id onto one root, so these are the cases that
		// would hand a caller a path outside it or hide an app as a dotfile.
		// Requiring a dot does not subsume these: `..` has one.
		for (const id of ['', '.', '..', '../escape', '/absolute', 'a/b', 'a\\b']) {
			expect({ id, admitted: isAppId(id) }).toEqual({ id, admitted: false });
		}
	});

	test('every label starts and ends alphanumeric', () => {
		for (const id of [
			'.hidden',
			'trailing.',
			'so..epicenter',
			'so.-lead',
			'so.trail-',
		]) {
			expect({ id, admitted: isAppId(id) }).toEqual({ id, admitted: false });
		}
	});

	test('an id is lowercase, and separators are dot and hyphen only', () => {
		for (const id of [
			'So.Epicenter.Vocab',
			'so.epicenter.local_mail',
			'so epicenter',
		]) {
			expect({ id, admitted: isAppId(id) }).toEqual({ id, admitted: false });
		}
	});
});
