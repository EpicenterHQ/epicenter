/**
 * `modelChoices()` Tests
 *
 * Under the `test` condition `@epicenter/local` keeps this computer's
 * settings in memory, so these read and write `models.md` through the same
 * settings the desktop's AppData and the browser's storage answer.
 *
 * Key behaviors:
 * - Once the settings connected, `get` answers the saved choice, else the
 *   app's default, and keeps a choice whose endpoint is gone
 * - A choice is `models.md`, one entry per job, kept beside the others
 * - Another window's write reaches the choices
 * - A `models.md` that does not read answers no choice; the deciding read
 *   fails naming it, and saving a choice replaces it
 */
import { expect, test } from 'bun:test';
import { settings } from '@epicenter/local';
import { outside } from '@epicenter/local/memory';
import { modelChoices } from './choices.js';

const models = settings.file('models.md');
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('a choice is models.md, one entry per job, and is read back as saved', async () => {
	const choices = modelChoices<'chat' | 'transcribe'>({
		chat: { endpoint: 'hosted', model: 'default' },
	});
	await models.connected();
	expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'default' });
	expect(choices.get('transcribe')).toBeNull();
	expect(choices.require('transcribe').error).toMatchObject({
		name: 'NoChoice',
		job: 'transcribe',
	});
	await choices.set('transcribe', { endpoint: 'local-speech', model: 'base' });
	await choices.set('chat', { endpoint: 'gone', model: 'kept' });
	expect(models.text()).toBe(
		'---\nchoices:\n  - endpoint: local-speech\n    job: transcribe\n    model: base\n  - endpoint: gone\n    job: chat\n    model: kept\n---\n',
	);
	expect(choices.require('chat').data).toEqual({
		endpoint: 'gone',
		model: 'kept',
	});
});

test('another window’s write reaches the choices, and listeners hear it', async () => {
	const choices = modelChoices<'chat'>();
	await models.connected();
	let heard = 0;
	const stop = choices.subscribe(() => heard++);
	outside.write(
		'models.md',
		'---\nchoices:\n  - job: chat\n    endpoint: lm-studio\n    model: qwen\n---\n',
	);
	await tick();
	expect(choices.get('chat')).toEqual({ endpoint: 'lm-studio', model: 'qwen' });
	expect(heard).toBeGreaterThan(0);
	stop();
});

test('a models.md that does not read answers no choice, says so by name, and a new choice replaces it', async () => {
	const choices = modelChoices<'chat'>({
		chat: { endpoint: 'hosted', model: 'default' },
	});
	await models.connected();
	outside.write('models.md', '---\nchoices: [\n---\n');
	await tick();
	expect(choices.get('chat')).toBeNull();
	expect(choices.problem()).toMatchObject({ name: 'Invalid', file: 'models.md' });
	expect(choices.require('chat').error).toMatchObject({
		name: 'Invalid',
		file: 'models.md',
	});
	await choices.set('chat', { endpoint: 'hosted', model: 'picked' });
	expect(choices.problem()).toBeNull();
	expect(choices.get('chat')).toEqual({ endpoint: 'hosted', model: 'picked' });
});
