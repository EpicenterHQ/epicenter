import { expect, test } from 'bun:test';
import {
	isRepositoryName,
	parseRepositoryPath,
	parseRepositoryUrl,
	repositoryUrl,
	toRepositoryName,
} from './repositories.js';

test('a directory name becomes a repository name by ADR-0546 rule', () => {
	expect(toRepositoryName('so.epicenter.todos')).toBe('so.epicenter.todos');
	expect(toRepositoryName('Demo Books')).toBe('demo-books');
	expect(toRepositoryName('  _Notes')).toBe('notes');
	expect(toRepositoryName('Café')).toBe('caf-');
	expect(toRepositoryName('backup.git')).toBe('backup');
	expect(toRepositoryName('...')).toBeUndefined();
	expect(toRepositoryName('')).toBeUndefined();
});

test('a stored name is lowercase, starts with a letter or digit, and does not end in .git', () => {
	expect(isRepositoryName('demo-books')).toBe(true);
	expect(isRepositoryName('Demo')).toBe(false);
	expect(isRepositoryName('-demo')).toBe(false);
	expect(isRepositoryName('demo.git')).toBe(false);
	expect(isRepositoryName('a'.repeat(101))).toBe(false);
});

test('a remote names its namespace and repository under the Git audience', () => {
	const path = { namespace: 'abcdefghij12', name: 'demo-books' };
	for (const audience of [
		'https://git.epicenter.so',
		'http://127.0.0.1:8787/git',
	]) {
		const url = repositoryUrl(audience, path);
		expect(parseRepositoryUrl(audience, url)).toEqual(path);
	}
	expect(repositoryUrl('http://127.0.0.1:8787/git', path)).toBe(
		'http://127.0.0.1:8787/git/abcdefghij12/demo-books.git',
	);
	expect(
		parseRepositoryUrl(
			'https://git.epicenter.so',
			'https://example.com/abcdefghij12/demo-books.git',
		),
	).toBeUndefined();
	expect(
		parseRepositoryUrl(
			'http://127.0.0.1:8787/git',
			'http://127.0.0.1:8787/abcdefghij12/demo-books.git',
		),
	).toBeUndefined();
	expect(parseRepositoryPath('abcdefghij12/Demo')).toBeUndefined();
	expect(parseRepositoryPath('abcdefghij12/demo/x')).toBeUndefined();
});
