/**
 * Bun Sidecar Runtime Tests
 *
 * Verifies the versioned Rust-to-Bun boot boundary and the shutdown owner that
 * ties Bun to its Rust parent's stdin pipe.
 *
 * Key behaviors:
 * - Boot frames are exact, versioned, and mode-specific
 * - Ready frames have one stable machine-readable stdout shape
 * - Signals and parent-pipe EOF stop the server before disposing host state
 */

import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	createReadyFrame,
	type ParentPipe,
	PRODUCTION_PORT,
	parseBootFrame,
	parseRuntimeMode,
	SIDECAR_PROTOCOL_VERSION,
	superviseSidecar,
	watchParentPipe,
} from './sidecar-runtime.js';

const TOKEN = 'valid_base64url-token';

function bootFrame(overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: 'boot',
		protocolVersion: SIDECAR_PROTOCOL_VERSION,
		token: TOKEN,
		port: PRODUCTION_PORT,
		dataDir: join(tmpdir(), 'so.epicenter.dev'),
		folderDir: join(tmpdir(), 'Epicenter Dev'),
		cacheDir: join(tmpdir(), 'so.epicenter.dev-cache'),
		...overrides,
	});
}

function setup() {
	const events: string[] = [];
	const parentClosed = Promise.withResolvers<void>();
	const signals = new EventEmitter();
	const parentPipe: ParentPipe = {
		bootLine: Promise.resolve(bootFrame()),
		closed: parentClosed.promise,
		async cancel() {
			events.push('pipe.cancel');
		},
	};
	const server = {
		async stop(closeActiveConnections?: boolean) {
			events.push(`server.stop:${String(closeActiveConnections)}`);
		},
	};
	const host = {
		async [Symbol.asyncDispose]() {
			events.push('host.dispose');
		},
	};
	const reported: string[] = [];
	const report = (message: string) => {
		reported.push(message);
	};
	const exited: number[] = [];
	const exit = (code: number) => {
		exited.push(code);
	};
	return {
		events,
		exit,
		exited,
		host,
		parentClosed,
		parentPipe,
		report,
		reported,
		server,
		signals,
	};
}

describe('runtime mode', () => {
	test('source and compiled argv shapes select the Rust-supplied mode', () => {
		expect(
			parseRuntimeMode([
				'/path/to/bun',
				'/app/src/main.ts',
				'--runtime-mode=production',
			]),
		).toBe('production');
		expect(
			parseRuntimeMode(['/app/epicenter-bun', '--runtime-mode=development']),
		).toBe('development');
	});

	test('missing, unknown, and additional arguments are rejected', () => {
		expect(() => parseRuntimeMode(['/app/epicenter-bun'])).toThrow(
			'exactly one',
		);
		expect(() =>
			parseRuntimeMode(['/app/epicenter-bun', '--runtime-mode=test']),
		).toThrow('production or --runtime-mode=development');
		expect(() =>
			parseRuntimeMode([
				'/app/epicenter-bun',
				'--runtime-mode=production',
				'--runtime-mode=development',
			]),
		).toThrow('exactly one');
	});
});

describe('boot protocol', () => {
	test('malformed JSON and non-object frames are rejected', () => {
		expect(() => parseBootFrame('{', 'production')).toThrow('valid JSON');
		expect(() => parseBootFrame('[]', 'production')).toThrow('JSON object');
	});

	test('missing and additional frame properties are rejected', () => {
		expect(() =>
			parseBootFrame(
				JSON.stringify({
					type: 'boot',
					protocolVersion: SIDECAR_PROTOCOL_VERSION,
					token: TOKEN,
				}),
				'production',
			),
		).toThrow('contain exactly');
		expect(() =>
			parseBootFrame(bootFrame({ unexpected: true }), 'production'),
		).toThrow('contain exactly');
		// Protocol 14 carried the desktop auth cell and server; the account is
		// the CLI's now (ADR-0556).
		for (const field of ['authCell', 'authServer', 'accountManagement'])
			expect(() =>
				parseBootFrame(bootFrame({ [field]: null }), 'production'),
			).toThrow('contain exactly');
	});

	test('unknown protocol versions are rejected', () => {
		expect(() =>
			parseBootFrame(bootFrame({ protocolVersion: 99 }), 'production'),
		).toThrow('Unsupported boot protocol version: 99');
	});

	test('native directories are required, absolute, and preserved exactly', () => {
		for (const key of ['dataDir', 'folderDir', 'cacheDir']) {
			for (const value of [null, 123, '', 'relative/directory', '/bad\0path']) {
				expect(() =>
					parseBootFrame(bootFrame({ [key]: value }), 'development'),
				).toThrow('absolute filesystem path');
			}
		}
		const dataDir = join(tmpdir(), 'custom data');
		const folderDir = join(tmpdir(), 'custom checkout');
		const cacheDir = join(tmpdir(), 'custom cache');
		expect(
			parseBootFrame(
				bootFrame({ dataDir, folderDir, cacheDir }),
				'development',
			),
		).toMatchObject({ dataDir, folderDir, cacheDir });
	});

	test('invalid token types and non-base64url tokens are rejected', () => {
		for (const token of ['', 'contains spaces', 'padded=', 123, null]) {
			expect(() => parseBootFrame(bootFrame({ token }), 'production')).toThrow(
				'non-empty base64url',
			);
		}
	});

	test('non-integer, privileged, and out-of-range ports are rejected', () => {
		for (const port of [1_023, 65_536, 39_130.5, '39130', null]) {
			expect(() => parseBootFrame(bootFrame({ port }), 'development')).toThrow(
				'integer from 1024 through 65535',
			);
		}
	});

	test('production accepts only the fixed production port', () => {
		expect(parseBootFrame(bootFrame(), 'production').port).toBe(
			PRODUCTION_PORT,
		);
		expect(() =>
			parseBootFrame(bootFrame({ port: PRODUCTION_PORT + 1 }), 'production'),
		).toThrow(`Production must bind port ${PRODUCTION_PORT}`);
	});

	test('development accepts any non-privileged valid port passed by Rust', () => {
		expect(parseBootFrame(bootFrame({ port: 1_024 }), 'development').port).toBe(
			1_024,
		);
		expect(
			parseBootFrame(bootFrame({ port: 65_535 }), 'development').port,
		).toBe(65_535);
	});

	test('ready frames contain exactly the versioned readiness contract', () => {
		expect(createReadyFrame(PRODUCTION_PORT)).toEqual({
			type: 'ready',
			protocolVersion: 15,
			port: PRODUCTION_PORT,
		});
	});
});

describe('parent pipe', () => {
	test('the first line is boot, and the pipe closing ends it', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('first half'));
				controller.enqueue(new TextEncoder().encode(' second half\n'));
				controller.close();
			},
		});
		const parentPipe = watchParentPipe(stream);

		expect(await parentPipe.bootLine).toBe('first half second half');
		await expect(parentPipe.closed).resolves.toBeUndefined();
	});

	test('a line after boot fails the pipe: Rust sends nothing more', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(
					new TextEncoder().encode(
						`${bootFrame()}\n{"type":"auth-callback","url":"epicenter://auth/callback?code=x"}\n`,
					),
				);
				controller.close();
			},
		});
		const parentPipe = watchParentPipe(stream);

		expect(await parentPipe.bootLine).toBe(bootFrame());
		await expect(parentPipe.closed).rejects.toThrow('after the boot frame');
	});

	test('EOF before a newline rejects the incomplete boot frame', async () => {
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(bootFrame()));
				controller.close();
			},
		});
		const parentPipe = watchParentPipe(stream);

		await expect(parentPipe.bootLine).rejects.toThrow('complete boot line');
	});
});

describe('shutdown', () => {
	test('a pending Bun force-stop promise does not prevent owner disposal', async () => {
		const { events, host, parentClosed, parentPipe, report, signals } = setup();
		const supervised = superviseSidecar({
			server: {
				stop() {
					events.push('server.stop:true');
					return new Promise<void>(() => {});
				},
			},
			host,
			parentPipe,
			report,
			signals,
		});
		parentClosed.resolve();
		await supervised;
		expect(events).toEqual(['server.stop:true', 'host.dispose', 'pipe.cancel']);
	});

	test('SIGTERM stops the server, disposes the host, and releases stdin in order', async () => {
		const {
			events,
			exit,
			exited,
			host,
			parentPipe,
			report,
			reported,
			server,
			signals,
		} = setup();
		const supervised = superviseSidecar({
			server,
			host,
			parentPipe,
			signals,
			report,
			exit,
		});

		signals.emit('SIGTERM');
		await supervised;

		expect(events).toEqual(['server.stop:true', 'host.dispose', 'pipe.cancel']);
		// A shutdown nobody can attribute is the one that costs an afternoon.
		expect(reported).toEqual([
			'Epicenter host: shutting down after a termination signal.',
		]);
		expect(exited).toEqual([]);
	});

	test('parent-pipe EOF performs the same complete shutdown', async () => {
		const {
			events,
			host,
			parentClosed,
			parentPipe,
			report,
			reported,
			server,
			signals,
		} = setup();
		const supervised = superviseSidecar({
			server,
			host,
			parentPipe,
			signals,
			report,
		});

		parentClosed.resolve();
		await supervised;

		expect(events).toEqual(['server.stop:true', 'host.dispose', 'pipe.cancel']);
		expect(reported).toEqual([
			'Epicenter host: shutting down after the parent pipe closing.',
		]);
	});

	test('a shutdown that never finishes leaves rather than stranding the host', async () => {
		const {
			events,
			exit,
			exited,
			parentPipe,
			report,
			reported,
			server,
			signals,
		} = setup();
		// The failure this pins: `dispose` hangs, the server is already stopped,
		// and the process stays alive holding no listening socket. Rust
		// supervises whether the child is alive, so it never restarts one that
		// is only half dead, and the window sees connection refused forever.
		const wedged = {
			async [Symbol.asyncDispose]() {
				events.push('host.dispose:hung');
				await new Promise<void>(() => undefined);
			},
		};
		superviseSidecar({
			server,
			host: wedged,
			parentPipe,
			signals,
			report,
			exit,
			graceMs: 5,
		});

		signals.emit('SIGTERM');
		await Bun.sleep(40);

		expect(events).toEqual(['server.stop:true', 'host.dispose:hung']);
		expect(exited).toEqual([1]);
		expect(reported.at(-1)).toBe(
			'Epicenter host: shutdown after a termination signal did not finish within 5ms; exiting so the parent can restart it.',
		);
	});

	test('a parent pipe failure disposes every owner before it propagates', async () => {
		const { events, host, parentPipe, report, reported, server, signals } =
			setup();
		const supervised = superviseSidecar({
			server,
			host,
			parentPipe: {
				...parentPipe,
				closed: Promise.reject(new Error('a line after boot')),
			},
			signals,
			report,
		});

		await expect(supervised).rejects.toThrow('a line after boot');
		expect(events).toEqual(['server.stop:true', 'host.dispose', 'pipe.cancel']);
		// The rejection still propagates, and the reason still names itself.
		expect(reported).toEqual([
			'Epicenter host: shutting down after the parent pipe failing: a line after boot.',
		]);
	});
});
