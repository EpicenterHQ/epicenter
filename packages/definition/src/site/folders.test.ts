import { expect, test } from 'bun:test';
import {
	folderRemoteUrl,
	foldersApiUrl,
	folderUrl,
	isFolderId,
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
	expect(folderRemoteUrl('http://127.0.0.1:8787/git', 'abcdefgh01234567')).toBe(
		'http://127.0.0.1:8787/git/folders/abcdefgh01234567.git',
	);
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
