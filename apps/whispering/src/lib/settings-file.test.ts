import { expect, test } from 'bun:test';
import { readSettings, writeSettings } from './settings-file';

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
