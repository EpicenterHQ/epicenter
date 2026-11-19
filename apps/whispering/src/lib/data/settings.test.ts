import { expect, test } from 'bun:test';
import { memoryFiles } from '../files/memory';
import { createSettings, readSettings, writeSettings } from './settings';

test('readSettings takes a server and a microphone, each when it is there', () => {
	expect(
		readSettings({ baseUrl: 'http://x', model: 'm', microphone: 'mic-1' }),
	).toEqual({
		server: { baseUrl: 'http://x', model: 'm' },
		microphone: 'mic-1',
	});
	expect(readSettings({ microphone: 'mic-1' })).toEqual({
		server: undefined,
		microphone: 'mic-1',
	});
	expect(readSettings({ microphone: 3 })).toEqual({
		server: undefined,
		microphone: undefined,
	});
	expect(readSettings(null)).toEqual({
		server: undefined,
		microphone: undefined,
	});
});

test('writeSettings reads back as it was written', () => {
	const settings = {
		server: { baseUrl: 'http://x', model: 'm' },
		microphone: 'mic-1',
	};
	expect(readSettings(JSON.parse(writeSettings(settings)))).toEqual(settings);
	expect(JSON.parse(writeSettings({}))).toEqual({});
});

test('update sets its fields and keeps the rest; a missing file sets nothing', async () => {
	const settings = createSettings(memoryFiles());
	expect((await settings.read()).data).toEqual({});
	const server = { baseUrl: 'http://x', model: 'm' };
	await settings.update({ server });
	await settings.update({ microphone: 'mic-1' });
	expect((await settings.read()).data).toEqual({ server, microphone: 'mic-1' });
	await settings.update({ microphone: undefined });
	expect((await settings.read()).data).toEqual({
		server,
		microphone: undefined,
	});
});

test('a settings file that is not JSON is a read failure', async () => {
	const settings = createSettings(memoryFiles({ 'settings.json': '{' }));
	expect((await settings.read()).error?.name).toBe('ReadFailed');
});
