/**
 * This computer's settings (`createSettings`) over a place a test holds.
 *
 * Key behaviors:
 * - The settings connect a turn after the first file is named, reading
 *   every named file once; a read before that throws `SettingsNotOpen`
 * - A write replaces the file, waits for the connection, and is heard by
 *   the file's listeners
 * - A change another window makes is heard and read again, even one made
 *   while the settings connected
 * - Settings that cannot be reached fail, saying why, and retry connects
 */
import { expect, test } from 'bun:test';
import {
	createSettings,
	SettingsNotOpen,
	type SettingsPlace,
} from './settings.js';

/** A place in memory, and the world outside it. */
function placeOf(files: Record<string, string> = {}) {
	const held = new Map(Object.entries(files));
	const listeners = new Set<(names: readonly string[] | 'all') => void>();
	let refused: string | null = null;
	const place: SettingsPlace = {
		async watch(changed) {
			if (refused) throw new Error(refused);
			listeners.add(changed);
			return () => listeners.delete(changed);
		},
		async read(name) {
			if (refused) throw new Error(refused);
			return held.get(name) ?? null;
		},
		async write(name, text) {
			if (text === null) held.delete(name);
			else held.set(name, text);
		},
	};
	return {
		place,
		held,
		refuse(reason: string | null) {
			refused = reason;
		},
		/** Another window writes `name`, and the place says so. */
		write(name: string, text: string) {
			held.set(name, text);
			for (const changed of [...listeners]) changed([name]);
		},
	};
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a named file is read once the settings connect; a read before throws', async () => {
	const { place } = placeOf({ 'models.md': 'saved' });
	const settings = createSettings(place);
	const models = settings.file('models.md');
	expect(settings.state().status).toBe('opening');
	expect(() => models.text()).toThrow(SettingsNotOpen);
	await models.connected();
	expect(settings.state().status).toBe('open');
	expect(models.text()).toBe('saved');
	expect(settings.file('missing.md').text()).toBeNull();
});

test('a write replaces the file and is heard; one made while connecting waits', async () => {
	const { place, held } = placeOf();
	const settings = createSettings(place);
	const models = settings.file('models.md');
	let heard = 0;
	models.subscribe(() => heard++);
	await models.write('first');
	expect(held.get('models.md')).toBe('first');
	expect(models.text()).toBe('first');
	await models.write(null);
	expect(held.has('models.md')).toBe(false);
	expect(models.text()).toBeNull();
	expect(heard).toBe(2);
});

test('another window’s change is heard and read again', async () => {
	const outside = placeOf({ 'models.md': 'one' });
	const settings = createSettings(outside.place);
	const models = settings.file('models.md');
	await models.connected();
	outside.write('models.md', 'two');
	await tick();
	expect(models.text()).toBe('two');
});

test('settings that cannot be reached fail, saying why, and retry connects', async () => {
	const outside = placeOf({ 'models.md': 'saved' });
	outside.refuse('the shell did not answer');
	const settings = createSettings(outside.place);
	const models = settings.file('models.md');
	expect(
		await models.connected().catch((error: unknown) => error),
	).toMatchObject({ name: 'Unavailable' });
	const state = settings.state();
	if (state.status !== 'failed') throw new Error('expected a failure');
	expect(state.error.message).toContain('the shell did not answer');
	outside.refuse(null);
	await state.retry();
	expect(settings.state().status).toBe('open');
	expect(models.text()).toBe('saved');
});
