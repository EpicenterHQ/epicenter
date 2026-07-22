/**
 * Data value Svelte adapter tests.
 *
 * Key behaviors:
 * - Initial load reads the bound value
 * - Assigning current writes through the ValueLens
 */

import { expect, test } from 'bun:test';
import type { RecordValueLens } from '@epicenter/data/record';
import { field } from '@epicenter/field';
import { Ok } from 'wellcrafted/result';
import { fromKv } from './from-kv.svelte.js';

(globalThis as unknown as { $state: unknown }).$state = Object.assign(
	<TValue>(value: TValue) => value,
	{ raw: <TValue>(value: TValue) => value },
);

const themeSchema = field.select(['light', 'dark']);

test('value binding loads and writes through the lens', async () => {
	let value: 'light' | 'dark' | undefined = 'light';
	const lens = {
		get: async () => Ok(value),
		set: async (next: 'light' | 'dark') => {
			value = next;
		},
		unset: async () => {
			value = undefined;
		},
		subscribe: () => () => {},
	} satisfies RecordValueLens<typeof themeSchema>;

	const theme = fromKv(lens);
	await theme.whenReady;
	expect(theme.current).toBe('light');

	theme.current = 'dark';
	await Promise.resolve();
	expect(theme.current).toBe('dark');
	expect(String(value)).toBe('dark');
});
