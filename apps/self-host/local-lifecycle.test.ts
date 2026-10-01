/** Real Bun issuer lifecycle: named session, socket update, local blobs, and restart. */
import { expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeFrame, encodeFrame } from '@epicenter/app/sync';
import { openSelfHostAuth } from '@epicenter/server/self-host-auth/bun';
import { createAuthenticator } from '../../packages/server/evidence/enrollment/authenticator.js';

test('one Bun process persists enrollment, sync, and local blobs across restart', async () => {
	const root = mkdtempSync(join(tmpdir(), 'self-host-local-lifecycle-'));
	const backup = mkdtempSync(join(tmpdir(), 'self-host-local-backup-'));
	const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
	const port = reservation.port;
	reservation.stop(true);
	const origin = `http://localhost:${port}`;
	let child: ReturnType<typeof spawn> | undefined;
	async function start() {
		child = spawn(process.execPath, ['apps/self-host/server.ts'], {
			cwd: join(import.meta.dir, '../..'),
			env: {
				...process.env,
				PORT: String(port),
				API_PUBLIC_ORIGIN: origin,
				SELF_HOST_DATA_ROOT: root,
				SELF_HOST_CALLBACKS: '[]',
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		for (let i = 0; i < 100; i++) {
			try {
				if ((await fetch(origin)).ok) return;
			} catch {}
			await Bun.sleep(20);
		}
		throw new Error('Bun server failed to start');
	}
	async function stop() {
		if (!child) return;
		const running = child;
		child = undefined;
		const exited = new Promise<void>((resolve) =>
			running.once('exit', () => resolve()),
		);
		running.kill('SIGTERM');
		await exited;
	}
	try {
		const admitted = spawnSync(
			process.execPath,
			['apps/self-host/scripts/manage-user.ts', 'admit', 'alice', 'Alice'],
			{
				cwd: join(import.meta.dir, '../..'),
				env: {
					...process.env,
					API_PUBLIC_ORIGIN: origin,
					SELF_HOST_DATA_ROOT: root,
				},
				encoding: 'utf8',
			},
		);
		expect(admitted.status).toBe(0);
		const link = admitted.stdout.match(/https?:\/\/\S+/)?.[0];
		if (!link)
			throw new Error(
				`Operator did not print an enrollment link: ${admitted.stderr}`,
			);
		const grant = new URLSearchParams(new URL(link).hash.slice(1)).get(
			'enroll',
		);
		if (!grant) throw new Error('Enrollment link has no grant');
		const auth = openSelfHostAuth({
			path: join(root, 'auth.sqlite'),
			origin,
			callbacks: [],
		});
		const post = (path: string, body: unknown, cookie?: string) =>
			auth.auth.handle(
				new Request(`${origin}/auth/${path}`, {
					method: 'POST',
					headers: {
						origin,
						'content-type': 'application/json',
						...(cookie ? { cookie } : {}),
					},
					body: JSON.stringify(body),
				}),
			);
		const options = await post('passkey/registration-options', {
			token: grant,
		});
		const ceremony = (await options.json()) as {
			id: string;
			options: { challenge: string };
		};
		const cookie = options.headers
			.getSetCookie()
			.map((part) => part.split(';')[0])
			.join('; ');
		const authenticator = await createAuthenticator(origin);
		const finish = await post(
			'passkey/register',
			{
				id: ceremony.id,
				response: await authenticator.register(ceremony.options.challenge),
			},
			cookie,
		);
		expect(finish.status).toBe(200);
		const token = finish.headers
			.getSetCookie()
			.find((part) => part.startsWith('epicenter_session='))!
			.split(';')[0]!
			.slice('epicenter_session='.length);
		auth.close();
		await start();
		const headers = { authorization: `Bearer ${token}` };
		const currentUrl = `${origin}/api/apps/so.epicenter.notes/personal/data/test.notes/current`;
		const current = await fetch(currentUrl, {
			method: 'POST',
			headers,
			body: new Uint8Array([1, 2, 3]),
		});
		expect(current.status).toBe(200);
		const firstCapture = new Uint8Array(await current.arrayBuffer());
		const socketUrl = `${origin.replace('http:', 'ws:')}/api/store/v1/sync?appId=so.epicenter.notes&scope=personal&dataId=test.notes&generation=1`;
		const socket = new WebSocket(socketUrl, ['epicenter', `bearer.${token}`]);
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener('open', () => resolve(), { once: true });
			socket.addEventListener(
				'error',
				() => reject(new Error('WebSocket upgrade failed')),
				{ once: true },
			);
		});
		expect(socket.protocol).toBe('epicenter');
		const acknowledged = new Promise<void>((resolve, reject) => {
			socket.addEventListener('message', async (event) => {
				const bytes = new Uint8Array(
					await (event.data instanceof Blob
						? event.data.arrayBuffer()
						: event.data),
				);
				const frame = decodeFrame(bytes).data;
				if (frame?.kind === 'ack' && frame.submission === 1) resolve();
			});
			socket.addEventListener(
				'error',
				() => reject(new Error('Sync socket failed')),
				{ once: true },
			);
		});
		socket.send(
			encodeFrame({
				kind: 'push',
				submission: 1,
				chunk: 0,
				chunks: 1,
				bytes: new Uint8Array([4, 5]),
			}),
		);
		await acknowledged;
		socket.close();
		const updatedCapture = new Uint8Array(
			await (
				await fetch(currentUrl, {
					method: 'POST',
					headers,
					body: new Uint8Array([9]),
				})
			).arrayBuffer(),
		);
		expect(updatedCapture).not.toEqual(firstCapture);
		const bytes = new Uint8Array([0, 1, 2, 255]);
		const published = await fetch(`${origin}/api/blobs/personal/alice/public`, {
			method: 'POST',
			headers: { ...headers, 'content-type': 'audio/webm' },
			body: bytes,
		});
		expect(published.status).toBe(201);
		const { url } = (await published.json()) as { url: string };
		expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(
			bytes,
		);
		const privateResponse = await fetch(
			`${origin}/api/blobs/personal/alice/private`,
			{ method: 'POST', headers, body: bytes },
		);
		expect(privateResponse.status).toBe(201);
		const privateUrl = ((await privateResponse.json()) as { url: string }).url;
		expect((await fetch(privateUrl)).status).toBe(401);
		expect(
			new Uint8Array(
				await (await fetch(privateUrl, { headers })).arrayBuffer(),
			),
		).toEqual(bytes);
		const wav = new Uint8Array(44 + 16000);
		const view = new DataView(wav.buffer);
		for (const [offset, value] of [
			[0, 'RIFF'],
			[8, 'WAVE'],
			[12, 'fmt '],
			[36, 'data'],
		] as const)
			for (let i = 0; i < value.length; i++)
				wav[offset + i] = value.charCodeAt(i);
		view.setUint32(4, wav.length - 8, true);
		view.setUint32(16, 16, true);
		view.setUint16(20, 1, true);
		view.setUint16(22, 1, true);
		view.setUint32(24, 8000, true);
		view.setUint32(28, 16000, true);
		view.setUint16(32, 2, true);
		view.setUint16(34, 16, true);
		view.setUint32(40, 16000, true);
		const wavResponse = await fetch(
			`${origin}/api/blobs/personal/alice/public`,
			{
				method: 'POST',
				headers: { ...headers, 'content-type': 'audio/wav' },
				body: wav,
			},
		);
		const wavUrl = ((await wavResponse.json()) as { url: string }).url;
		const { chromium } = createRequire(
			new URL('../../packages/app/src/data/package.json', import.meta.url),
		)('playwright') as typeof import('playwright');
		const browser = await chromium.launch({
			headless: true,
			args: ['--autoplay-policy=no-user-gesture-required'],
		});
		try {
			const page = await browser.newPage();
			await page.setContent(`<audio src="${wavUrl}"></audio>`, {
				waitUntil: 'domcontentloaded',
			});
			const playback = await page.evaluate(async () => {
				const audio = document.querySelector('audio')!;
				if (audio.readyState < 1)
					await new Promise<void>((resolve, reject) => {
						audio.addEventListener('loadedmetadata', () => resolve(), {
							once: true,
						});
						audio.addEventListener(
							'error',
							() => reject(new Error('media error')),
							{ once: true },
						);
						setTimeout(() => reject(new Error('media timed out')), 5000);
					});
				await audio.play();
				await new Promise((resolve) => setTimeout(resolve, 250));
				return {
					duration: audio.duration,
					currentTime: audio.currentTime,
					error: audio.error?.code,
				};
			});
			expect(playback.duration).toBe(1);
			expect(playback.currentTime).toBeGreaterThan(0.1);
			expect(playback.error).toBeUndefined();
		} finally {
			await browser.close();
		}
		await stop();
		cpSync(root, join(backup, 'snapshot'), { recursive: true });
		rmSync(root, { recursive: true, force: true });
		cpSync(join(backup, 'snapshot'), root, { recursive: true });
		await start();
		const reopened = await fetch(currentUrl, {
			method: 'POST',
			headers,
			body: new Uint8Array([9]),
		});
		expect(new Uint8Array(await reopened.arrayBuffer())).toEqual(
			updatedCapture,
		);
		expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(
			bytes,
		);
		expect(
			new Uint8Array(
				await (await fetch(privateUrl, { headers })).arrayBuffer(),
			),
		).toEqual(bytes);
		expect((await fetch(`${origin}/api/session`, { headers })).status).toBe(
			200,
		);
	} finally {
		await stop();
		rmSync(root, { recursive: true, force: true });
		rmSync(backup, { recursive: true, force: true });
	}
}, 30_000);
