/**
 * Installed Apps Tests
 *
 * The record over a stand-in for `localStorage`.
 *
 * Key behaviors:
 * - A new device starts with the default apps, each installed like any other, pinned to its hash
 * - The record is the person's: a second open reads what the first installed, and installing twice changes nothing
 * - A hostname this shell cannot install is refused, and nothing is recorded
 * - A record that does not read starts the device again from the defaults
 */
import { expect, test } from 'bun:test';
import { openInstalled, RECORD_KEY, type RecordStorage } from './installed.js';

const BUNDLES: Record<string, { name: string; hash: string }> = {
	'files.epicenter.so': { name: 'Files', hash: 'sha256-f' },
	'todos.epicenter.so': { name: 'Todos', hash: 'sha256-t' },
	'honeycrisp.epicenter.so': { name: 'Honeycrisp', hash: 'sha256-h' },
};
const DEFAULTS = ['files.epicenter.so', 'todos.epicenter.so'];

function memory(): RecordStorage & { items: Map<string, string> } {
	const items = new Map<string, string>();
	return {
		items,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => void items.set(key, value),
	};
}

const open = (storage: RecordStorage) =>
	openInstalled({
		storage,
		installable: (hostname) => BUNDLES[hostname],
		defaults: DEFAULTS,
		now: () => new Date('2026-10-29T12:00:00Z'),
	});

test('a new device starts with the default apps, each pinned to its hash', () => {
	const storage = memory();
	expect(open(storage).apps()).toEqual([
		{
			hostname: 'files.epicenter.so',
			name: 'Files',
			hash: 'sha256-f',
			installedAt: '2026-10-29T12:00:00.000Z',
		},
		{
			hostname: 'todos.epicenter.so',
			name: 'Todos',
			hash: 'sha256-t',
			installedAt: '2026-10-29T12:00:00.000Z',
		},
	]);
	expect(JSON.parse(storage.items.get(RECORD_KEY) ?? '')).toMatchObject({
		version: 1,
		apps: [
			{ hostname: 'files.epicenter.so' },
			{ hostname: 'todos.epicenter.so' },
		],
	});
});

test('the record is kept: a second open reads what the first installed, and installing twice changes nothing', () => {
	const storage = memory();
	const first = open(storage);
	expect(first.install('honeycrisp.epicenter.so').data).toMatchObject({
		name: 'Honeycrisp',
		hash: 'sha256-h',
	});
	const kept = storage.items.get(RECORD_KEY);
	expect(first.install('honeycrisp.epicenter.so').error).toBeNull();
	expect(storage.items.get(RECORD_KEY)).toBe(kept);
	expect(
		open(storage)
			.apps()
			.map(({ hostname }) => hostname),
	).toEqual([
		'files.epicenter.so',
		'todos.epicenter.so',
		'honeycrisp.epicenter.so',
	]);
});

test('a hostname this shell cannot install is refused, and nothing is recorded', () => {
	const storage = memory();
	const installed = open(storage);
	const kept = storage.items.get(RECORD_KEY);
	expect(installed.install('recipes.pages.dev').error).toContain(
		'Installing an app from recipes.pages.dev is not built yet',
	);
	expect(installed.apps()).toHaveLength(2);
	expect(storage.items.get(RECORD_KEY)).toBe(kept);
});

test('a record that does not read starts the device again from the defaults', () => {
	for (const text of [
		'not json',
		'{"version":2,"apps":[]}',
		'{"version":1,"apps":[{"hostname":"x"}]}',
	]) {
		const storage = memory();
		storage.setItem(RECORD_KEY, text);
		expect(
			open(storage)
				.apps()
				.map(({ hostname }) => hostname),
		).toEqual(DEFAULTS);
	}
});
