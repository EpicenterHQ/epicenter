/**
 * Derived App Catalog Tests
 *
 * Verifies the ADR-0153 proof slice on the Bun origin: the catalog is derived
 * from validated static output (never authored), every member is served below
 * `/apps/<id>/` by the contained resolver, and the security-sensitive
 * containment and ID rules stay visible. The committed `hello-http` fixture is
 * itself derived here so the live-drive artifact cannot rot.
 *
 * Key behaviors:
 * - Only directories satisfying the output contract become catalog members
 * - Reserved built-in surface IDs are never derived as members
 * - Titles come from the app document with the ID as fallback
 * - The resolver serves real files, SPA-falls-back only for extensionless
 *   routes, and refuses traversal, smuggled separators, and symlink escape
 * - The Home server serves members at /apps/<id>/, 404s unknown apps, and
 *   keeps the legacy Home and Whispering routes intact
 * - /api/apps requires a browser session and lists {id, title}
 *
 * See also:
 * - `server.test.ts` for the legacy closed-layout serving and session shell
 */

import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME } from '@epicenter/data/desktop-record-owner';
import { BOOTSTRAP_ROUTE, SURFACE_ROUTES } from './routes.ts';
import { createHomeServer, type HomeServerOptions } from './server.ts';
import {
	type AppCatalog,
	deriveAppCatalog,
	isValidAppId,
	loadStaticAssets,
} from './static-assets.ts';
import {
	createOwnedTestHomeHost,
	createTestDesktopAuth,
} from './test-home-host.ts';

const RESERVED_IDS = Object.keys(SURFACE_ROUTES);
const COMMITTED_FIXTURE_ROOT = fileURLToPath(
	new URL('../test-fixtures/app-catalog', import.meta.url),
);
const TOKEN = 'per-launch-secret';
const HOME_PAGE = '<!doctype html><html><body>Home test page</body></html>';
const WHISPERING_PAGE =
	'<!doctype html><html><body>Whispering test application</body></html>';
const closedRecordOwner = {
	execute: async () => ({
		result: null,
		error: {
			name: EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME,
			message: 'Desktop record operation failed' as const,
		},
	}),
} satisfies HomeServerOptions['recordOwner'];

function tempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

/** One valid app output: `<root>/<id>/index.html` plus optional files. */
function writeApp(
	root: string,
	id: string,
	{
		page = `<!doctype html><title>${id}</title>`,
		files = {},
	}: { page?: string; files?: Record<string, string> } = {},
): void {
	mkdirSync(join(root, id), { recursive: true });
	writeFileSync(join(root, id, 'index.html'), page);
	for (const [name, content] of Object.entries(files)) {
		const path = join(root, id, ...name.split('/'));
		mkdirSync(join(path, '..'), { recursive: true });
		writeFileSync(path, content);
	}
}

async function derive(root: string): Promise<AppCatalog> {
	return deriveAppCatalog(root, { reservedIds: RESERVED_IDS });
}

describe('isValidAppId', () => {
	test('accepts direct folder names matching [a-z0-9-]+ and nothing else', () => {
		for (const accepted of ['hello-http', 'a', 'notes2', 'x-y-z']) {
			expect(isValidAppId(accepted)).toBe(true);
		}
		for (const denied of [
			'',
			'Hello',
			'hello_http',
			'hello.http',
			'hello/http',
			'..',
			'hello http',
			'héllo',
		]) {
			expect(isValidAppId(denied)).toBe(false);
		}
	});
});

describe('deriveAppCatalog', () => {
	test('missing catalog root derives an empty catalog', async () => {
		const { apps } = await derive(join(tempDir('epicenter-catalog-'), 'nope'));
		expect(apps).toEqual([]);
	});

	test('derives members only from directories satisfying the output contract', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'zeta');
		writeApp(root, 'alpha');
		writeApp(root, 'Bad-Case');
		writeApp(root, 'bad_underscore');
		// Reserved built-in IDs stay on the legacy path in this slice.
		writeApp(root, 'whispering');
		mkdirSync(join(root, 'no-index'));
		writeFileSync(join(root, 'plain-file'), 'not a directory');

		const { apps } = await derive(root);
		expect(apps.map((app) => app.id)).toEqual(['alpha', 'zeta']);
	});

	test('derives title from the document <title> with the ID as fallback', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'titled', {
			page: '<!doctype html><head><title> Fancy App </title></head>',
		});
		writeApp(root, 'untitled', { page: '<!doctype html><h1>no title</h1>' });

		const { apps } = await derive(root);
		expect(apps.map((app) => [app.id, app.title])).toEqual([
			['titled', 'Fancy App'],
			['untitled', 'untitled'],
		]);
	});

	test('symlinked app roots escaping the catalog are not members', async () => {
		const outside = tempDir('epicenter-outside-');
		writeApp(outside, 'escapee');
		const root = tempDir('epicenter-catalog-');
		symlinkSync(join(outside, 'escapee'), join(root, 'escapee'));

		const { apps } = await derive(root);
		expect(apps).toEqual([]);
	});

	test('the committed hello-http fixture is a valid catalog member', async () => {
		const { apps } = await derive(COMMITTED_FIXTURE_ROOT);
		expect(apps.map((app) => [app.id, app.title])).toEqual([
			['hello-http', 'Hello HTTP'],
		]);

		const script = await apps[0]?.resolve('/apps/hello-http/main.js');
		expect(script?.contentType).toBe('text/javascript');
		expect(await script?.file.text()).toContain('plugin:http|fetch');
	});
});

describe('catalog member resolve', () => {
	async function memberOf(root: string, id: string) {
		const { apps } = await derive(root);
		const member = apps.find((app) => app.id === id);
		if (!member) throw new Error(`app ${id} was not derived`);
		return member;
	}

	test('serves index, real assets, and extensionless SPA fallback below /apps/<id>/', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'spa', {
			page: '<!doctype html><title>SPA</title>',
			files: { 'assets/entry.js': 'console.log(1);' },
		});
		const member = await memberOf(root, 'spa');

		const index = await member.resolve('/apps/spa/');
		expect(index?.contentType).toBe('text/html');
		expect(await index?.file.text()).toContain('SPA');

		const asset = await member.resolve('/apps/spa/assets/entry.js');
		expect(asset?.contentType).toBe('text/javascript');

		const fallback = await member.resolve('/apps/spa/settings/audio');
		expect(await fallback?.file.text()).toContain('SPA');

		expect(await member.resolve('/apps/spa/assets/missing.js')).toBeUndefined();
	});

	test('rejects traversal, smuggled separators, symlink escape, and foreign prefixes', async () => {
		const root = tempDir('epicenter-catalog-');
		writeApp(root, 'safe');
		writeApp(root, 'other');
		const secret = join(tempDir('epicenter-secret-'), 'secret.txt');
		writeFileSync(secret, 'secret');
		symlinkSync(secret, join(root, 'safe', 'leak.txt'));
		const member = await memberOf(root, 'safe');

		for (const denied of [
			'/apps/safe/../other/index.html',
			'/apps/safe/%2e%2e/other/index.html',
			'/apps/safe/%252e%252e/other/index.html',
			'/apps/safe/..%2findex.html',
			'/apps/safe/\\other/index.html',
			'/apps/safe//index.html',
			'/apps/safe/./index.html',
			'/apps/other/index.html',
			'/apps/safe/leak.txt',
		]) {
			expect(await member.resolve(denied)).toBeUndefined();
		}
	});
});

describe('home server catalog routes', () => {
	async function serveWithCatalog() {
		const catalogRoot = tempDir('epicenter-catalog-');
		writeApp(catalogRoot, 'hello-http', {
			page: '<!doctype html><title>Hello HTTP</title><script src="./main.js"></script>',
			files: { 'main.js': 'document.title;' },
		});

		const appsDist = tempDir('epicenter-apps-dist-');
		mkdirSync(join(appsDist, 'home'), { recursive: true });
		mkdirSync(join(appsDist, 'whispering'), { recursive: true });
		writeFileSync(join(appsDist, 'home', 'index.html'), HOME_PAGE);
		writeFileSync(join(appsDist, 'whispering', 'index.html'), WHISPERING_PAGE);

		const host = await createOwnedTestHomeHost({
			dataDir: tempDir('epicenter-host-'),
			model: 'test-model',
			engine: async function* () {},
		});

		const portProbe = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: () => new Response(),
		});
		const port = portProbe.port;
		await portProbe.stop(true);
		if (port === undefined) throw new Error('no port');
		const origin = `http://127.0.0.1:${port}`;

		const { app, websocket } = createHomeServer({
			host,
			origin,
			launchToken: TOKEN,
			staticAssets: await loadStaticAssets(appsDist),
			appCatalog: await derive(catalogRoot),
			recordOwner: closedRecordOwner,
			desktopAuth: createTestDesktopAuth(),
		});
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port,
			fetch: app.fetch,
			websocket,
		});
		return { origin, server };
	}

	async function bootstrapCookie(origin: string): Promise<string> {
		const bootstrap = await fetch(BOOTSTRAP_ROUTE.url(origin), {
			method: 'POST',
			headers: { authorization: `Bearer ${TOKEN}`, origin },
		});
		expect(bootstrap.status).toBe(204);
		const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
		if (cookie === undefined) throw new Error('bootstrap set no cookie');
		return cookie;
	}

	test('serves catalog members below /apps/<id>/ and keeps unknown apps 404', async () => {
		const { origin, server } = await serveWithCatalog();
		try {
			const page = await fetch(`${origin}/apps/hello-http/`);
			expect(page.status).toBe(200);
			expect(page.headers.get('content-type')).toBe('text/html');
			expect(await page.text()).toContain('Hello HTTP');

			const script = await fetch(`${origin}/apps/hello-http/main.js`);
			expect(script.status).toBe(200);
			expect(script.headers.get('content-type')).toBe('text/javascript');

			expect((await fetch(`${origin}/apps/unknown/`)).status).toBe(404);
			expect((await fetch(`${origin}/apps/hello-http`)).status).toBe(404);

			// The legacy closed layout stays intact beside the catalog. Surface
			// documents carry the identity snapshot, so they require an
			// established browser session and are served with the bootstrap
			// element injected.
			const cookie = await bootstrapCookie(origin);
			const homeDocument = await (
				await fetch(`${origin}/apps/home/`, { headers: { cookie } })
			).text();
			expect(homeDocument).toContain('Home test page');
			expect(homeDocument).toContain('epicenter-auth-bootstrap');
			const whisperingDocument = await (
				await fetch(`${origin}/apps/whispering/`, { headers: { cookie } })
			).text();
			expect(whisperingDocument).toContain('Whispering test application');
			expect(whisperingDocument).toContain('epicenter-auth-bootstrap');
		} finally {
			await server.stop(true);
		}
	});

	test('/api/apps requires a browser session and lists derived members', async () => {
		const { origin, server } = await serveWithCatalog();
		try {
			expect((await fetch(`${origin}/api/apps`)).status).toBe(401);

			const cookie = await bootstrapCookie(origin);
			const listed = await fetch(`${origin}/api/apps`, {
				headers: { cookie },
			});
			expect(listed.status).toBe(200);
			expect(await listed.json()).toEqual({
				apps: [{ id: 'hello-http', title: 'Hello HTTP' }],
			});
		} finally {
			await server.stop(true);
		}
	});
});
