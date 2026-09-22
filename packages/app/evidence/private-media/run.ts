/** Runs the shipped presentation asset and Account implementations against real browsers. */

import { asPrincipalId } from '@epicenter/principal';
import { chromium, webkit } from 'playwright';
import { generateBlobId } from '../../../blobs/src/blob-id.js';
import { Hono } from '../../../server/node_modules/hono/dist/index.js';
import { corsMiddleware } from '../../../server/src/middleware/cors.js';
import { mountBlobsApp } from '../../../server/src/routes/blobs.js';
import type { Env } from '../../../server/src/types.js';

const build = await Bun.build({
	entrypoints: [new URL('./page.ts', import.meta.url).pathname],
	target: 'browser',
});
if (!build.success)
	throw new AggregateError(build.logs, 'Evidence build failed');
const page = await build.outputs[0]!.text();
const id = generateBlobId('wav');
const htmlId = generateBlobId('bin');
const svgId = generateBlobId('bin');
const wav = new Uint8Array(44 + 8000 * 2 * 120);
const header = new DataView(wav.buffer);
for (const [at, word] of [
	[0, 'RIFF'],
	[8, 'WAVE'],
	[12, 'fmt '],
	[36, 'data'],
] as const)
	wav.set(new TextEncoder().encode(word), at);
header.setUint32(4, wav.length - 8, true);
header.setUint32(16, 16, true);
header.setUint16(20, 1, true);
header.setUint16(22, 1, true);
header.setUint32(24, 8000, true);
header.setUint32(28, 16000, true);
header.setUint16(32, 2, true);
header.setUint16(34, 16, true);
header.setUint32(40, wav.length - 44, true);
let apiURL = '';
let version = 1;
let sent = 0;
const requests: string[] = [];
const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	async fetch(request) {
		const url = new URL(request.url);
		if (url.pathname === '/')
			return new Response(
				`<html data-api="${apiURL}" data-blob="${id}" data-html="${htmlId}" data-svg="${svgId}"><body><script type="module" src="/page.js"></script></body></html>`,
				{ headers: { 'content-type': 'text/html' } },
			);
		if (url.pathname === '/page.js')
			return new Response(page, {
				headers: { 'content-type': 'text/javascript' },
			});
		if (url.pathname === '/epicenter-blob-worker.js')
			return new Response(
				Bun.file(
					new URL('../../../client/src/blob-worker.js', import.meta.url),
				),
				{ headers: { 'content-type': 'text/javascript' } },
			);
		if (url.pathname === '/api/session')
			return Response.json({
				principalId: request.headers.get('authorization')?.endsWith('bob')
					? 'bob'
					: 'alice',
			});
		if (url.pathname.includes('sign-out'))
			return Response.json({ success: true });
		if (url.pathname === '/api/evidence/version') {
			version++;
			return new Response(null, { status: 204 });
		}
		if ([id, htmlId, svgId].some((key) => url.pathname.endsWith('/' + key))) {
			const html = url.pathname.endsWith('/' + htmlId);
			const svg = url.pathname.endsWith('/' + svgId);
			const contentType = html
				? 'text/html'
				: svg
					? 'image/svg+xml'
					: 'audio/wav';
			const payload = html
				? new TextEncoder().encode('<script>top.pwned=true</script>')
				: svg
					? new TextEncoder().encode(
							'<svg xmlns="http://www.w3.org/2000/svg" onload="top.pwned=true"></svg>',
						)
					: wav;
			requests.push(
				`${request.method} ${request.headers.get('authorization')?.split(' ')[0]} ${request.headers.get('range')}`,
			);
			if (
				!(
					url.pathname.startsWith('/evidence-s3/') &&
					request.headers.get('authorization')?.startsWith('AWS4-HMAC-SHA256')
				) &&
				request.headers.get('authorization') !== 'Bearer alice'
			)
				return new Response(null, { status: 403 });
			const etag = `"version-${version}"`;
			if (
				request.headers.has('if-match') &&
				request.headers.get('if-match') !== etag
			)
				return new Response(null, { status: 412 });
			let start = 0,
				end = payload.length - 1;
			const range = /bytes=(\d+)-(\d*)/.exec(
				request.headers.get('range') ?? '',
			);
			const headers = new Headers({
				'content-type': contentType,
				'content-length': String(payload.length),
				etag,
				'cache-control': 'no-store',
				'accept-ranges': 'bytes',
			});
			if (range) {
				start = Number(range[1]);
				end = range[2] ? Math.min(Number(range[2]), end) : end;
				if (start > end) {
					headers.set('content-range', `bytes */${payload.length}`);
					headers.delete('content-length');
					return new Response(null, { status: 416, headers });
				}
				headers.set('content-range', `bytes ${start}-${end}/${payload.length}`);
				headers.set('content-length', String(end - start + 1));
			}
			if (request.method === 'HEAD') return new Response(null, { headers });
			let position = start;
			return new Response(
				new ReadableStream({
					async pull(controller) {
						if (position > end) {
							controller.close();
							return;
						}
						if (position > start) await Bun.sleep(30);
						const chunk = payload.slice(
							position,
							Math.min(position + 8192, end + 1),
						);
						controller.enqueue(chunk);
						position += chunk.length;
						sent += chunk.length;
					},
				}),
				{ headers, status: range ? 206 : 200 },
			);
		}
		return new Response(null, { status: 404 });
	},
});
const apiApp = new Hono<Env>();
apiApp.use('*', async (c, next) => {
	c.set('trustedOrigins', [server.url.origin]);
	await next();
});
apiApp.use('*', corsMiddleware);
apiApp.get('/api/session', (c) =>
	c.json({
		principalId: c.req.header('authorization')?.endsWith('bob')
			? 'bob'
			: 'alice',
	}),
);
apiApp.post('/auth/sign-out', (c) => c.json({ success: true }));
apiApp.post('/api/evidence/version', (c) => {
	version++;
	return c.body(null, 204);
});
mountBlobsApp(apiApp, {
	auth: async (c, next) => {
		const token = c.req.header('authorization');
		if (!token?.startsWith('Bearer ')) return c.body(null, 401);
		c.set('principal', { id: asPrincipalId(token.slice(7)) });
		c.set('authBaseURL', apiURL);
		await next();
	},
});
const api = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch: (request) =>
		apiApp.fetch(request, {
			BLOBS_S3_ENDPOINT: server.url.origin + '/evidence-s3',
			BLOBS_S3_ACCESS_KEY_ID: 'test',
			BLOBS_S3_SECRET_ACCESS_KEY: 'test',
			BLOBS_S3_BUCKET: 'test',
		} as Env['Bindings']),
});
apiURL = api.url.origin;
let target = server.url.href;
let cookie: string | undefined;
let native: Bun.Server<unknown> | undefined;
let cleanup = async () => {};
if (process.env.MEDIA_DESKTOP) {
	const { createSessionAuth } = await import(
		'../../../auth/src/create-session-auth.js'
	);
	const { asPrincipalId } = await import('@epicenter/principal');
	const { createHomeHost } = await import(
		'../../../../apps/epicenter/src/host.ts'
	);
	const { createHomeServer } = await import(
		'../../../../apps/epicenter/src/server.ts'
	);
	const { createBunBlobStore } = await import('../../../blobs/src/bun.ts');
	const { mkdtemp, rm } = await import('node:fs/promises');
	const { tmpdir } = await import('node:os');
	const { join } = await import('node:path');
	const { Ok } = await import('wellcrafted/result');
	const directory = await mkdtemp(join(tmpdir(), 'blob-media-native-'));
	const auth = createSessionAuth({
		authorityId: 'media-evidence',
		baseURL: apiURL,
		persistedAuthStorage: {
			initial: { token: 'alice', principalId: asPrincipalId('alice') },
			async set() {},
		},
		launcher: {
			async startSignIn() {
				return { status: 'completed', token: 'bob' };
			},
		},
	});
	const account = auth.getState().account!;
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	const origin = `http://127.0.0.1:${port}`;
	const host = await createHomeHost({
		model: 'test',
		engine: async function* () {},
	});
	const { app, websocket } = createHomeServer({
		origin,
		launchToken: 'media-evidence',
		folderRoot: join(directory, 'checkout'),
		host,
		staticAssets: {
			homePage: `<html data-blob="${id}" data-html="${htmlId}" data-svg="${svgId}"><head></head><body><script type="module">${page.replaceAll('</script', '<\\/script')}</script></body></html>`,
			applications: [],
		},
		blobs: (appId, owner) =>
			createBunBlobStore({ directory: join(directory, appId, owner) }),
		desktopAuth: {
			restartRequired: false,
			baseURL: apiURL,
			callbackUrl: 'epicenter://auth/callback',
			acceptSignInCallback: () => false,
			account,
			bootSnapshot: {
				state: { status: 'signed-in', principalId: account.principalId },
				server: { baseURL: apiURL, authorityId: 'media-evidence' },
				accountManagement: true,
				credentialUnreadable: false,
			},
			getState() {
				const state = auth.getState();
				return state.status === 'signed-out'
					? { status: 'signed-out' }
					: { status: state.status, principalId: state.account.principalId };
			},
			startSignIn: auth.startSignIn,
			cancelConnection: async () => Ok(undefined),
			signOut: auth.signOut,
			[Symbol.dispose]: auth[Symbol.dispose],
		},
	});
	native = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
		websocket,
	});
	target = origin + '/apps/home/';
	const boot = await fetch(origin + '/_epicenter/bootstrap', {
		method: 'POST',
		headers: { origin, authorization: 'Bearer media-evidence' },
	});
	cookie = boot.headers.get('set-cookie')!.split(';')[0]!;
	cleanup = async () => {
		auth[Symbol.dispose]();
		await native?.stop(true);
		await rm(directory, { recursive: true, force: true });
	};
}
console.log('MEDIA_URL=' + target);
if (cookie) console.log('MEDIA_COOKIE=' + cookie);
if (process.env.MEDIA_SERVE_ONLY) await new Promise(() => {});
try {
	for (const [name, engine] of Object.entries({ chromium, webkit })) {
		if (process.env.MEDIA_ENGINE && process.env.MEDIA_ENGINE !== name) continue;
		const browser = await engine.launch({
			...(name === 'chromium'
				? { args: ['--autoplay-policy=no-user-gesture-required'] }
				: {}),
		});
		try {
			const context = await browser.newContext();
			if (cookie)
				await context.addCookies([
					{
						name: cookie.split('=')[0]!,
						value: cookie.slice(cookie.indexOf('=') + 1),
						url: target,
					},
				]);
			const tab = await context.newPage();
			tab.on('pageerror', (error) => console.error(name, error));
			await tab.goto(target);
			await tab.waitForFunction(() => 'mediaEvidence' in globalThis, {
				timeout: 15000,
			});
			const heldUrl = await tab.evaluate(
				() => (globalThis as any).mediaEvidence.url,
			);
			const other = await context.newPage();
			await other.goto(target);
			await other.waitForFunction(() => 'mediaEvidence' in globalThis);
			const crossPage = await other.evaluate(
				async (url) => (await fetch(url)).status,
				heldUrl,
			);
			if (crossPage !== 410)
				throw new Error('Cross-page source redemption succeeded');
			await other.close();
			const result = await tab.evaluate(() =>
				(
					globalThis as unknown as {
						mediaEvidence: { run(): Promise<unknown> };
					}
				).mediaEvidence.run(),
			);
			console.log(
				JSON.stringify({
					engine: name,
					result,
					crossPage,
					sent,
					requests: requests.splice(0),
				}),
			);
		} finally {
			await browser.close();
		}
	}
} finally {
	await cleanup();
	api.stop(true);
	server.stop(true);
}
