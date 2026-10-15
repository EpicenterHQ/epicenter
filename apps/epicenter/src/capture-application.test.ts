/**
 * Capture's compiled application contract through the composed Home server.
 *
 * Key behaviors:
 * - The host serves Capture at its declared route with native IPC access
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { CAPTURE_APPLICATION, COMPILED_APPLICATIONS } from './applications.ts';
import { createHomeHost } from './host.ts';
import { BOOTSTRAP_ROUTE, CAPTURE_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import { writeAppsDist } from './test-apps-dist.ts';
import { createTestDesktopAuth } from './test-home-host.ts';

const ORIGIN = 'http://127.0.0.1:49152';
const HOST = new URL(ORIGIN).host;
const LAUNCH_TOKEN = 'launch';
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
	for (const run of cleanups.splice(0).reverse()) await run();
});

function scratch(prefix: string) {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	return directory;
}

async function serve() {
	const host = await createHomeHost({
		model: 'test',
		engine: async function* () {},
	});
	cleanups.push(() => host[Symbol.asyncDispose]());
	const desktopAuth = createTestDesktopAuth();
	cleanups.push(() => desktopAuth[Symbol.dispose]());
	const blobs = scratch('epicenter-capture-blobs-');
	const { app } = createHomeServer({
		host,
		origin: ORIGIN,
		launchToken: LAUNCH_TOKEN,
		staticAssets: await loadStaticAssets(
			writeAppsDist({
				root: scratch('epicenter-capture-dist-'),
				homePage: '<!doctype html><html><body>Home</body></html>',
				applicationPage: ({ title }) =>
					`<!doctype html><html><body>${title} test application</body></html>`,
			}),
			COMPILED_APPLICATIONS,
		),
		blobs: (appId, owner) =>
			createBunBlobStore({ directory: join(blobs, appId, owner ?? 'none') }),
		desktopAuth,
	});
	const bootstrap = await app.request(BOOTSTRAP_ROUTE.url(ORIGIN), {
		method: 'POST',
		headers: {
			host: HOST,
			origin: ORIGIN,
			authorization: `Bearer ${LAUNCH_TOKEN}`,
		},
	});
	const cookie = bootstrap.headers.get('set-cookie')!.split(';')[0]!;
	return { app, cookie };
}

describe('Capture as a compiled application', () => {
	test('is declared and served below its id', async () => {
		const { app, cookie } = await serve();

		expect(CAPTURE_APPLICATION).toEqual({ id: 'capture', title: 'Capture' });
		expect(COMPILED_APPLICATIONS).toContainEqual(CAPTURE_APPLICATION);
		expect(CAPTURE_ROUTE.pattern).toBe('/apps/capture/');

		const page = await app.request(CAPTURE_ROUTE.url(ORIGIN), {
			headers: { host: HOST, cookie },
		});
		expect(page.status).toBe(200);
		expect(await page.text()).toContain('Capture test application');
		// The page can reach the native Folder plugin through Tauri IPC.
		expect(page.headers.get('content-security-policy')).toContain(
			"connect-src 'self' ipc: http://ipc.localhost;",
		);
	});
});
