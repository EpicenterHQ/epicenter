/**
 * Sync Transport URL Tests
 *
 * Verifies cloud sync URL construction for the rooms WebSocket endpoint.
 *
 * Key behaviors:
 * - Single URL form: `/api/rooms/<guid>` in every deployment.
 * - `guid` is `encodeURIComponent`-encoded.
 * - Trailing slashes on `baseURL` are stripped.
 * - `http` origins become `ws`; `https` origins become `wss`.
 */

import { describe, expect, test } from 'bun:test';
import { roomWsUrl } from './transport.js';

describe('roomWsUrl', () => {
	test('builds the public room URL without a principal path segment', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com',
				guid: 'epicenter-fuji',
			}),
		).toBe('wss://api.example.com/api/rooms/epicenter-fuji');
	});

	test('encodes the guid and strips trailing slashes', () => {
		expect(
			roomWsUrl({
				baseURL: 'https://api.example.com/',
				guid: 'a/b?c#d',
			}),
		).toBe('wss://api.example.com/api/rooms/a%2Fb%3Fc%23d');
	});

	test('converts http origins to ws and https origins to wss', () => {
		expect(
			roomWsUrl({
				baseURL: 'http://localhost:8787',
				guid: 'epicenter-fuji',
			}),
		).toBe('ws://localhost:8787/api/rooms/epicenter-fuji');
	});
});
