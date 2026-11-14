/**
 * Hosted trusted-origin tests.
 * Separates production application trust from local development origins, rejects
 * extension and wildcard trust, and freezes arrays shared by Worker isolates.
 */
import { describe, expect, test } from 'bun:test';
import { APPS, localUrl } from '@epicenter/definition/site';
import { buildEpicenterTrustedOrigins } from './trusted-origins.js';

const PROD = buildEpicenterTrustedOrigins('https://api.epicenter.so');
const LOCAL = buildEpicenterTrustedOrigins('http://localhost:8787');

describe('buildEpicenterTrustedOrigins', () => {
	test('neither deployment trusts a browser extension or wildcard origin', () => {
		for (const origins of [PROD, LOCAL]) {
			expect(
				origins.filter((o) => o.startsWith('chrome-extension://')),
			).toEqual([]);
			expect(origins.some((o) => o.includes('*'))).toBe(false);
		}
	});

	test('neither deployment trusts a desktop webview origin', () => {
		// No `tauri://` page calls the API; the desktop host relays account
		// traffic with its own bearer token.
		for (const origins of [PROD, LOCAL])
			expect(origins.filter((o) => o.startsWith('tauri://'))).toEqual([]);
	});

	test('a production deployment does not trust localhost dev origins', () => {
		expect(PROD).not.toContain(localUrl(APPS.CAPTURE));
		expect(PROD).not.toContain(localUrl(APPS.API));
		expect(PROD).not.toContain(`http://${new URL(APPS.API.url).host}`);
		expect(PROD.some((o) => o.startsWith('http://localhost'))).toBe(false);
	});

	test('a local deployment trusts the localhost dev origins', () => {
		expect(LOCAL).toContain('http://localhost:5177');
		expect(PROD).not.toContain('http://localhost:5177');
		expect(LOCAL).toContain(localUrl(APPS.CAPTURE));
		expect(LOCAL).toContain('http://127.0.0.1:5186');
		expect(PROD).not.toContain('http://127.0.0.1:5186');
		expect(LOCAL).toContain(localUrl(APPS.API));
		expect(LOCAL).toContain(`http://${new URL(APPS.API.url).host}`);
	});

	test('both deployments trust the production app origins', () => {
		expect(PROD).toContain(APPS.CAPTURE.url);
		expect(PROD).toContain(APPS.TODOS.url);
		expect(LOCAL).toContain(APPS.CAPTURE.url);
		expect(PROD).toContain('https://zhongwen.bradenwong.com');
		expect(LOCAL).toContain('https://zhongwen.bradenwong.com');
		expect(PROD).not.toContain('http://localhost:5207');
		expect(LOCAL).toContain('http://localhost:5207');
		expect(PROD).not.toContain('https://zhongwen.bradenwong.com.attacker.test');
	});

	test('is frozen so Cloudflare isolates cannot accumulate mutations', () => {
		expect(Object.isFrozen(PROD)).toBe(true);
		expect(Object.isFrozen(LOCAL)).toBe(true);
	});
});
