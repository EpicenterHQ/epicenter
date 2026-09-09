/** Endpoint labels expose only a host, never URL credentials or an invalid raw value. */
import { expect, test } from 'bun:test';
import { hostFromBaseUrl } from './locality.js';

test('destination strips URL credentials, paths, and query parameters', () => {
	expect(
		hostFromBaseUrl('https://user:secret@models.example:8443/v1?key=secret'),
	).toBe('models.example:8443');
});

test('invalid endpoint never echoes possible credentials into UI copy', () => {
	expect(hostFromBaseUrl('user:secret@bad endpoint')).toBe(
		'an invalid server address',
	);
});
