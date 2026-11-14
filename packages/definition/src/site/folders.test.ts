import { expect, test } from 'bun:test';
import { resolveOAuthAudiences } from './apps.ts';
import {
	foldersApiUrl,
	folderUrl,
	isFolderId,
	isMarkName,
	isPersonEmail,
} from './folders.ts';

test('a folder is addressed by its id under the audience, and joined or made at the folders address', () => {
	expect(isFolderId('abcdefgh01234567')).toBe(true);
	expect(isFolderId('ABCDEFGH01234567')).toBe(false);
	expect(isFolderId('abc')).toBe(false);
	expect(folderUrl('https://api.example/folders/', 'abcdefgh01234567')).toBe(
		'https://api.example/folders/abcdefgh01234567',
	);
	expect(folderUrl('https://api.example/folders')).toBe(
		'https://api.example/folders',
	);
});

test('every deployment serves the folders audience at <origin>/folders', () => {
	expect(resolveOAuthAudiences('https://api.epicenter.so')).toEqual({
		api: 'https://api.epicenter.so',
		folders: 'https://api.epicenter.so/folders',
	});
	expect(resolveOAuthAudiences('http://localhost:8787/x')).toEqual({
		api: 'http://localhost:8787',
		folders: 'http://localhost:8787/folders',
	});
});

test('the folder routes on the API encode each segment', () => {
	expect(foldersApiUrl('https://api.example/')).toBe(
		'https://api.example/api/folders',
	);
	expect(
		foldersApiUrl(
			'https://api.example',
			'abcdefgh01234567',
			'members',
			'jess+a@example.com',
		),
	).toBe(
		'https://api.example/api/folders/abcdefgh01234567/members/jess%2Ba%40example.com',
	);
});

test('a person is named by an email address', () => {
	expect(isPersonEmail('jess@example.com')).toBe(true);
	expect(isPersonEmail('jess')).toBe(false);
	expect(isPersonEmail('a/b@example.com')).toBe(false);
	expect(isPersonEmail('a b@example.com')).toBe(false);
});

test('a mark is a name a tag can carry too', () => {
	for (const name of ['v1', 'release/1.0', 'draft_2', 'A-b.c'])
		expect(isMarkName(name)).toBe(true);
	for (const name of [
		'',
		'-v',
		'a..b',
		'a/',
		'/a',
		'v.lock',
		'a./b',
		'a b',
		'x'.repeat(101),
	])
		expect(isMarkName(name)).toBe(false);
});
