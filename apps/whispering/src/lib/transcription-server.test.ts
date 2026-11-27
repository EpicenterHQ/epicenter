import { expect, test } from 'bun:test';
import { originOf } from './transcription-server';

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
