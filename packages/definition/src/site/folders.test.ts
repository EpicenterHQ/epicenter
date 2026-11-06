import { expect, test } from 'bun:test';
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
	expect(folderUrl('https://g.example/', 'abcdefgh01234567')).toBe(
		'https://g.example/folders/abcdefgh01234567',
	);
	expect(folderUrl('https://g.example')).toBe('https://g.example/folders');
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
