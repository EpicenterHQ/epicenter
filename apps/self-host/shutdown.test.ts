/**
 * Bun shutdown drains active authentication handlers before closing SQLite.
 * A suspended request can still commit after shutdown begins, while repeated
 * signals share one shutdown promise and new requests are refused.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSelfHostAuth } from '@epicenter/server/self-host-auth/bun';
import { startSelfHostServer } from './server.js';

test('shutdown drains a suspended auth request before closing its database and shares repeated signals', async () => {
	const origin = 'http://localhost:8787';
	const directory = mkdtempSync(join(tmpdir(), 'self-host-shutdown-'));
	const path = join(directory, 'auth.sqlite');
	const operator = openSelfHostAuth({ path, origin, callbacks: [] });
	const grant = await operator.auth.admit({ id: 'alice', name: 'Alice' });
	operator.close();
	const configuration = {
		PORT: '8787',
		API_PUBLIC_ORIGIN: origin,
		AUTH_DB_PATH: path,
		SELF_HOST_CALLBACKS: '[]',
	};
	const previous = Object.fromEntries(
		Object.keys(configuration).map((key) => [key, process.env[key]]),
	);
	const signals = ['SIGINT', 'SIGTERM'] as const;
	const previousListeners = signals.map((signal) => process.listeners(signal));
	const realServe = Bun.serve;
	let fetcher: ((request: Request) => Response | Promise<Response>) | undefined;
	let stops = 0;
	let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
	let shutdown: Promise<void> | undefined;
	let installed: {
		signal: (typeof signals)[number];
		listener: (...args: unknown[]) => unknown;
	}[] = [];
	try {
		Object.assign(process.env, configuration);
		// @ts-expect-error the recorder captures the real handler without starting a listener
		Bun.serve = (options: { fetch: NonNullable<typeof fetcher> }) => {
			fetcher = options.fetch;
			return {
				port: 0,
				stop(force: boolean) {
					expect(force).toBe(true);
					stops++;
				},
			};
		};
		startSelfHostServer();
		Bun.serve = realServe;
		installed = signals.flatMap((signal, index) =>
			process
				.listeners(signal)
				.filter((listener) => !previousListeners[index]!.includes(listener))
				.map((listener) => ({
					signal,
					listener: listener as (...args: unknown[]) => unknown,
				})),
		);
		if (!fetcher) throw new Error('Server did not install a handler');
		const body = new ReadableStream<Uint8Array>({
			start(stream) {
				controller = stream;
			},
		});
		const pending = Promise.resolve(
			fetcher(
				new Request(`${origin}/auth/passkey/registration-options`, {
					method: 'POST',
					headers: { origin, 'content-type': 'application/json' },
					body,
				}),
			),
		);
		const terminate = installed.find(
			(entry) => entry.signal === 'SIGTERM',
		)!.listener;
		const interrupt = installed.find(
			(entry) => entry.signal === 'SIGINT',
		)!.listener;
		shutdown = terminate() as Promise<void>;
		expect(interrupt()).toBe(shutdown);
		let stopped = false;
		void shutdown.then(() => {
			stopped = true;
		});
		await Promise.resolve();
		expect(stopped).toBe(false);
		expect((await fetcher(new Request(origin))).status).toBe(503);
		controller!.enqueue(
			new TextEncoder().encode(JSON.stringify({ token: grant.token })),
		);
		controller!.close();
		controller = undefined;
		const response = await pending;
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			options: { user: { name: 'Alice' } },
		});
		await shutdown;
		expect(stopped).toBe(true);
		expect(stops).toBe(1);
	} finally {
		Bun.serve = realServe;
		controller?.close();
		if (!shutdown)
			shutdown = installed
				.find((entry) => entry.signal === 'SIGTERM')
				?.listener() as Promise<void> | undefined;
		await shutdown;
		for (const { signal, listener } of installed)
			process.removeListener(signal, listener);
		for (const [key, value] of Object.entries(previous)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(directory, { recursive: true, force: true });
	}
});
