import { expect, test } from 'bun:test';
import { originOf, readServer } from './transcription-server';

test('originOf keeps http and https addresses only', () => {
	expect(originOf('https://api.openai.com/v1')).toBe('https://api.openai.com');
	expect(originOf(' http://localhost:8000/v1/ ')).toBe('http://localhost:8000');
	expect(originOf('https://api.openai.com:443/v1')).toBe(
		'https://api.openai.com',
	);
	expect(originOf('api.openai.com/v1')).toBeUndefined();
	expect(originOf('ftp://example.com')).toBeUndefined();
	expect(originOf('')).toBeUndefined();
});

test('readServer takes a base URL and a model, and nothing else', () => {
	expect(readServer({ baseUrl: 'http://x', model: 'm', extra: 1 })).toEqual({
		baseUrl: 'http://x',
		model: 'm',
	});
	expect(readServer({ baseUrl: 'http://x' })).toBeUndefined();
	expect(readServer(null)).toBeUndefined();
	expect(readServer('http://x')).toBeUndefined();
});
