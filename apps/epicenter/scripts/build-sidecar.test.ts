/**
 * Epicenter Bun Host Packaging Tests
 *
 * Verifies the compiled Bun child runs without a system Bun on PATH, refuses a
 * production boot on any port but the fixed one, finds packaged Home and
 * Whispering assets through the Rust-supplied resource path, and exits when the
 * parent pipe closes.
 *
 * The serving half boots in development mode on a port the OS hands out, not in
 * production mode on 39130. Binding the real production port made this test
 * fail whenever a developer had Epicenter open, reporting it as "compiled host
 * exited before readiness", and it bought nothing: the host binds whatever port
 * the boot frame names, so the number under test is the contract, not the
 * behaviour. The contract is asserted directly below instead.
 */

import { expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { epicenterCloud } from '@epicenter/auth';
import {
	PRODUCTION_PORT,
	type ReadyFrame,
	SIDECAR_PROTOCOL_VERSION,
} from '../src/sidecar-runtime.ts';

const appDir = join(import.meta.dir, '..');

/** A port the OS is willing to give us, released before the caller binds it. */
function freePort(): number {
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const { port } = probe;
	probe.stop(true);
	if (port === undefined) throw new Error('The OS handed out no port.');
	return port;
}

async function hostTargetTriple(): Promise<string> {
	const process = Bun.spawn(['rustc', '-vV'], { stdout: 'pipe' });
	const output = await new Response(process.stdout).text();
	expect(await process.exited).toBe(0);
	const host = output
		.split('\n')
		.find((line) => line.startsWith('host: '))
		?.slice('host: '.length)
		.trim();
	if (!host) throw new Error('rustc did not report a host triple');
	return host;
}

async function readReady(
	stdout: ReadableStream<Uint8Array>,
	stderr: ReadableStream<Uint8Array>,
): Promise<ReadyFrame> {
	const reader = stdout.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (value) buffer += decoder.decode(value, { stream: true });
			const newline = buffer.indexOf('\n');
			if (newline !== -1) {
				return JSON.parse(buffer.slice(0, newline)) as ReadyFrame;
			}
			if (done) {
				const detail = (await new Response(stderr).text()).trim();
				throw new Error(
					detail.length > 0
						? `compiled host exited before readiness: ${detail}`
						: 'compiled host exited before readiness',
				);
			}
		}
	} finally {
		reader.releaseLock();
	}
}

test('compiled host refuses a mis-bound production boot, serves packaged apps, and exits on parent EOF', async () => {
	const build = Bun.spawn(['bun', 'run', 'build:desktop'], {
		cwd: appDir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if ((await build.exited) !== 0) {
		throw new Error(await new Response(build.stderr).text());
	}

	const triple = await hostTargetTriple();
	const binary = join(
		appDir,
		'src-tauri',
		'binaries',
		`epicenter-host-${triple}`,
	);
	const dataDir = mkdtempSync(join(tmpdir(), 'epicenter-compiled-host-'));

	// The production boot contract, proven against the compiled binary rather
	// than only against `parseBootFrame`: production is pinned to one port, and
	// a parent offering another gets a refusal instead of a stray listener.
	const misbound = Bun.spawn([binary, '--runtime-mode=production'], {
		env: { PATH: '' },
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	misbound.stdin.write(
		`${JSON.stringify({
			type: 'boot',
			protocolVersion: SIDECAR_PROTOCOL_VERSION,
			token: 'compiled_test_token',
			port: PRODUCTION_PORT + 1,
			authCell: null,
			authServer: epicenterCloud('https://api.epicenter.so'),
			dataDir,
			folderDir: join(dataDir, 'checkout'),
		})}\n`,
	);
	await misbound.stdin.flush();
	misbound.stdin.end();
	expect(await misbound.exited).not.toBe(0);
	expect(await new Response(misbound.stderr).text()).toContain(
		`Production must bind port ${PRODUCTION_PORT}`,
	);

	const port = freePort();
	const sidecar = Bun.spawn([binary, '--runtime-mode=development'], {
		env: {
			EPICENTER_APPS_DIST: join(appDir, 'dist'),
			EPICENTER_INFERENCE_URL: 'http://127.0.0.1:1/v1',
			EPICENTER_INFERENCE_MODEL: 'unused-model',
			PATH: '',
		},
		stdin: 'pipe',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	try {
		sidecar.stdin.write(
			`${JSON.stringify({
				type: 'boot',
				protocolVersion: SIDECAR_PROTOCOL_VERSION,
				token: 'compiled_test_token',
				port,
				authCell: null,
				authServer: epicenterCloud('https://api.epicenter.so'),
				dataDir,
				folderDir: join(dataDir, 'checkout'),
			})}\n`,
		);
		await sidecar.stdin.flush();
		expect(await readReady(sidecar.stdout, sidecar.stderr)).toEqual({
			type: 'ready',
			protocolVersion: SIDECAR_PROTOCOL_VERSION,
			port,
		});
		const origin = `http://127.0.0.1:${port}`;
		const bootstrap = await fetch(`${origin}/_epicenter/bootstrap`, {
			method: 'POST',
			headers: {
				authorization: 'Bearer compiled_test_token',
				origin,
			},
		});
		expect(bootstrap.status).toBe(204);
		const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
		expect(cookie).toBeDefined();
		const session = { headers: { cookie: cookie ?? '' } };

		const home = await fetch(`${origin}/apps/home/`, session);
		expect(home.status).toBe(200);
		expect(await home.text()).toContain('<title>Home</title>');
		const whispering = await fetch(`${origin}/apps/whispering/`, session);
		expect(whispering.status).toBe(200);
		const whisperingPage = await whispering.text();
		expect(whisperingPage).toContain('<title>Whispering</title>');
		const entryPath = whisperingPage.match(
			/\/apps\/whispering\/_app\/[^" ]+\.js/,
		)?.[0];
		expect(entryPath).toBeDefined();
		const entry = await fetch(`${origin}${entryPath ?? ''}`, session);
		expect(entry.status).toBe(200);
		expect(entry.headers.get('content-type')).toContain('text/javascript');
		const vad = await fetch(
			`${origin}/apps/whispering/vad/silero_vad_v5.onnx`,
			session,
		);
		expect(vad.status).toBe(200);
		expect((await vad.arrayBuffer()).byteLength).toBeGreaterThan(1_000);

		sidecar.stdin.end();
		expect(await sidecar.exited).toBe(0);

		const replacement = Bun.serve({
			hostname: '127.0.0.1',
			port,
			fetch: () => new Response(),
		});
		expect(replacement.port).toBe(port);
		await replacement.stop(true);
	} finally {
		sidecar.kill();
	}
}, 120_000);
