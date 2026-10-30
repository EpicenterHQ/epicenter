/**
 * App Contract Tests
 *
 * Key behaviors:
 * - A hostname is two or more lowercase DNS labels; no owner or repository name is one
 * - A manifest with a bad hostname or no name is refused where it is defined
 * - An app path starts with one `/`
 * - An app path names a file by its segments, encoded, and back
 */
import { expect, test } from 'bun:test';
import { defineApp } from '@epicenter/repository';
import {
	defineManifest,
	fileOfPath,
	isAppPath,
	isHostname,
	pathOfFile,
} from './index.js';

test('a hostname is two or more lowercase DNS labels, and no owner or repository name is one', () => {
	for (const hostname of [
		'todos.epicenter.so',
		'recipes.pages.dev',
		'a.b',
		'x-1.example.com',
		'1password.com',
	])
		expect(isHostname(hostname)).toBe(true);
	for (const name of ['me', 'home', 'todos', 'wong', 'team-notes'])
		expect(isHostname(name)).toBe(false);
	for (const bad of [
		'',
		'.so',
		'a.',
		'a..b',
		'-a.so',
		'a-.so',
		'Todos.epicenter.so',
		'todos.epicenter.so:5173',
		'a_b.so',
		`${'a'.repeat(64)}.so`,
	])
		expect(isHostname(bad)).toBe(false);
});

test('a manifest with a bad hostname or no name is refused where it is defined', () => {
	const collections = defineApp({});
	expect(
		defineManifest({
			name: 'Files',
			hostname: 'files.epicenter.so',
			collections,
		}).hostname,
	).toBe('files.epicenter.so');
	expect(() =>
		defineManifest({ name: 'Files', hostname: 'files', collections }),
	).toThrow("'files' is not a hostname");
	expect(() =>
		defineManifest({ name: ' ', hostname: 'files.epicenter.so', collections }),
	).toThrow('An app needs a name');
});

test('an app path starts with one slash', () => {
	for (const path of ['/', '/milk', '/notes/pasta.md?as=text'])
		expect(isAppPath(path)).toBe(true);
	for (const path of ['', 'milk', '//evil.example/x'])
		expect(isAppPath(path)).toBe(false);
});

test('an app path names a file by its segments, encoded, and back', () => {
	for (const file of [
		'notes/pasta.md',
		'a b/c?d#e.md',
		'README.md',
		'ünï/ç.md',
	])
		expect(fileOfPath(pathOfFile(file))).toBe(file);
	expect(pathOfFile('a b/c?.md')).toBe('/a%20b/c%3F.md');
	expect(fileOfPath('/notes/pasta.md?as=text')).toBe('notes/pasta.md');
	for (const path of ['/', '/notes/', 'notes/a.md', '/bad%E0.md'])
		expect(fileOfPath(path)).toBeUndefined();
});
