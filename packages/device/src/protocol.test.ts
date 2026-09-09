import { isLibraryReplica } from '@epicenter/principal';
/**
 * SQLite account wire validation.
 * Only explicit null selects local storage. Account identity requires two
 * nonempty path segments, while punctuation used in existing identities survives.
 */
import { expect, test } from 'bun:test';
import { isSqliteAccount } from './protocol.js';

test('explicit null and path-safe identities are valid SQL accounts', () => {
	expect(isSqliteAccount(null)).toBe(true);
	expect(isSqliteAccount({ authorityId: 'cloud', principalId: 'alice' })).toBe(
		true,
	);
	expect(isSqliteAccount({ authorityId: 'a:%"', principalId: 'b:[]' })).toBe(
		true,
	);
});

test.each([
	undefined,
	false,
	0,
	'',
	{},
	{ kind: 'local' },
	{ authorityId: 'cloud' },
	{ principalId: 'alice' },
])('omitted or malformed account %j is rejected', (account) => {
	expect(isSqliteAccount(account)).toBe(false);
});

test('an array cannot be a SQL account', () => {
	expect(isSqliteAccount([])).toBe(false);
});

test.each([
	'',
	'.',
	'..',
	'a/b',
	'a\\b',
	'a\0b',
	null,
	1,
])('unsafe account segment %j is rejected in either identity field', (segment) => {
	expect(isSqliteAccount({ authorityId: segment, principalId: 'alice' })).toBe(
		false,
	);
	expect(isSqliteAccount({ authorityId: 'cloud', principalId: segment })).toBe(
		false,
	);
});

test('replica addressing requires a selected library and its actor', () => {
	const account = { authorityId: 'server', principalId: 'alice' };
	expect(isLibraryReplica({ library: 'local' })).toBe(true);
	expect(isLibraryReplica({ library: 'personal', account })).toBe(true);
	expect(isLibraryReplica({ library: 'shared', account })).toBe(true);
	for (const invalid of [
		null,
		account,
		{ account },
		{ library: 'shared' },
		{ library: 'local', account },
		{ library: null, account },
		{ library: 'other', account },
	])
		expect(isLibraryReplica(invalid)).toBe(false);
});
