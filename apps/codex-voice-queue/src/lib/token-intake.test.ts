/**
 * Fragment intake preserves access tokens independently of API URL validation.
 * Verifies token trimming, origin normalization, and rejection of unsafe API URLs.
 */
import { expect, test } from 'bun:test';
import {
	loadCredentials,
	parseFragment,
	resolveCredentials,
} from './token-intake.js';

test('token-only fragments trim the token', () => {
	expect(parseFragment('token=%20secret%20')).toEqual({
		token: 'secret',
		api: null,
		error: null,
	});
});

test('token and API fragments return the API origin', () => {
	for (const protocol of ['http', 'https']) {
		expect(
			parseFragment(`token=secret&api=${protocol}://gateway.test:5190/path`),
		).toEqual({
			token: 'secret',
			api: `${protocol}://gateway.test:5190`,
			error: null,
		});
	}
});

test('invalid API URLs preserve the token and return a validation error', () => {
	for (const api of [
		'',
		'invalid',
		'/relative',
		'ftp://gateway.test',
		'https://user@gateway.test',
		'https://:secret@gateway.test',
	]) {
		expect(
			parseFragment(`token=secret&api=${encodeURIComponent(api)}`),
		).toEqual({
			token: 'secret',
			api: null,
			error: 'API URL must use HTTP or HTTPS without credentials',
		});
	}
});

test('empty fragments yield no token, API, or error', () => {
	expect(parseFragment('')).toEqual({ token: null, api: null, error: null });
});

test('unrelated parameters yield no token, API, or error', () => {
	expect(parseFragment('view=thread')).toEqual({
		token: null,
		api: null,
		error: null,
	});
});

test('empty and whitespace-only tokens yield null', () => {
	for (const fragment of ['token=', 'token=%20%09']) {
		expect(parseFragment(fragment)).toEqual({
			token: null,
			api: null,
			error: null,
		});
	}
});

test('API-only links never reuse a credential from another origin', () => {
	const saved = { apiOrigin: '', token: 'secret' };
	expect(
		resolveCredentials(parseFragment('api=https://evil.example'), saved),
	).toEqual({
		credentials: null,
		pendingApiOrigin: 'https://evil.example',
		error: null,
	});
	expect(
		resolveCredentials(parseFragment('api=https://gateway.test'), {
			...saved,
			apiOrigin: 'https://gateway.test',
		}).credentials?.token,
	).toBe('secret');
});

test('fragment tokens bind to their origin, or same origin when API is absent or invalid', () => {
	expect(
		resolveCredentials(
			parseFragment('token=new&api=https://gateway.test'),
			null,
		).credentials,
	).toEqual({ apiOrigin: 'https://gateway.test', token: 'new' });
	expect(
		resolveCredentials(parseFragment('token=new'), {
			apiOrigin: 'https://old.test',
			token: 'old',
		}).credentials,
	).toEqual({ apiOrigin: '', token: 'new' });
	const invalid = resolveCredentials(
		parseFragment('token=new&api=invalid'),
		null,
	);
	expect(invalid.credentials).toEqual({ apiOrigin: '', token: 'new' });
	expect(invalid.error).toBe(
		'API URL must use HTTP or HTTPS without credentials',
	);
});

test('no fragment preserves saved credentials and invalid API does not redirect them', () => {
	const saved = { apiOrigin: 'https://gateway.test', token: 'secret' };
	expect(resolveCredentials(parseFragment(''), saved).credentials).toBe(saved);
	expect(
		resolveCredentials(parseFragment('api=invalid'), saved).credentials,
	).toBe(saved);
});

test('migration keeps only legacy tokens that had no API origin and removes both old keys', () => {
	for (const oldApi of [null, 'https://old.test']) {
		const values = new Map([['codex-voice-queue:token', 'legacy']]);
		if (oldApi) values.set('codex-voice-queue:api', oldApi);
		const storage = {
			getItem: (key: string) => values.get(key) ?? null,
			setItem: (key: string, value: string) => {
				values.set(key, value);
			},
			removeItem: (key: string) => {
				values.delete(key);
			},
		};
		expect(loadCredentials(storage)).toEqual(
			oldApi ? null : { apiOrigin: '', token: 'legacy' },
		);
		expect(values.has('codex-voice-queue:token')).toBe(false);
		expect(values.has('codex-voice-queue:api')).toBe(false);
	}
});
