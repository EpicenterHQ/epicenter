import type { AccountIdentity } from '@epicenter/principal';
/**
 * The private Rust-to-Bun startup protocol and the Bun sidecar lifecycle.
 * Rust resolves the runtime mode and port, then keeps stdin open as its parent
 * lifetime signal. Bun validates that input but never resolves a port itself.
 */

import { isAbsolute } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';

/**
 * How long the whole shutdown may take before this process leaves anyway.
 *
 * Under Rust's fifteen-second readiness timeout, so a host that gives up here
 * is restarted rather than declared unreachable.
 */
const SHUTDOWN_GRACE_MS = 10_000;

export const SIDECAR_PROTOCOL_VERSION = 3;
export const PRODUCTION_PORT = 39_130;

export type SidecarRuntimeMode = 'production' | 'development';

export type BootFrame = {
	type: 'boot';
	protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
	token: string;
	port: number;
	authCell: string | null;
	dataDir: string;
	folderDir: string;
};

export type ReadyFrame = {
	type: 'ready';
	protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
	port: number;
};

type SidecarServer = {
	stop(closeActiveConnections?: boolean): Promise<void> | void;
};

type SidecarHost = {
	[Symbol.asyncDispose](): Promise<void>;
};

type SignalSource = {
	once(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
	off(signal: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
};

export type ParentPipe = {
	bootLine: Promise<string>;
	frames: ReadableStream<string>;
	closed: Promise<void>;
	cancel(): Promise<void>;
};

export type NativePort = ReturnType<typeof createNativeAuthPort>;

/**
 * The slice of the native port the desktop auth authority uses.
 *
 * Declared as a subset rather than the whole port so that adding an operation
 * for somebody else, such as an application's labeled secret, does not oblige
 * every auth test double to grow a method it never calls.
 */
export type NativeAuthPort = Pick<
	NativePort,
	| 'completed'
	| 'storeAuth'
	| 'openAuthUrl'
	| 'relaunch'
	| 'onAuthCallback'
	| 'closeApplications'
	| 'resumeApplications'
>;

const BOOT_FRAME_KEYS = [
	'authCell',
	'dataDir',
	'folderDir',
	'port',
	'protocolVersion',
	'token',
	'type',
];
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const AUTH_CALLBACK = 'epicenter://auth/callback';

/**
 * Parse the one explicit runtime-mode argument supplied by the Rust parent.
 * The full argv works for both Bun source runs (`bun`, script, args) and
 * compiled executables (executable, args), whose leading shapes differ.
 */
export function parseRuntimeMode(argv: string[]): SidecarRuntimeMode {
	const runtimeModeArguments = argv.filter((argument) =>
		argument.startsWith('--runtime-mode='),
	);
	if (runtimeModeArguments.length !== 1) {
		throw new Error(
			'Expected exactly one --runtime-mode=production|development argument.',
		);
	}

	switch (runtimeModeArguments[0]) {
		case '--runtime-mode=production':
			return 'production';
		case '--runtime-mode=development':
			return 'development';
		default:
			throw new Error(
				'Expected --runtime-mode=production or --runtime-mode=development.',
			);
	}
}

/** Strictly validate the first stdin line as the current protocol version. */
export function parseBootFrame(
	line: string,
	runtimeMode: SidecarRuntimeMode,
): BootFrame {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error('The boot frame must be valid JSON.');
	}

	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('The boot frame must be a JSON object.');
	}

	const keys = Object.keys(value).sort();
	if (
		keys.length !== BOOT_FRAME_KEYS.length ||
		keys.some((key, index) => key !== BOOT_FRAME_KEYS[index])
	) {
		throw new Error(
			'The boot frame must contain exactly type, protocolVersion, token, port, authCell, dataDir, and folderDir.',
		);
	}

	const frame = value as Record<string, unknown>;
	if (frame.type !== 'boot') {
		throw new Error('The boot frame type must be "boot".');
	}
	if (frame.protocolVersion !== SIDECAR_PROTOCOL_VERSION) {
		throw new Error(
			`Unsupported boot protocol version: ${String(frame.protocolVersion)}.`,
		);
	}
	if (typeof frame.token !== 'string' || !BASE64URL.test(frame.token)) {
		throw new Error('The boot token must be a non-empty base64url string.');
	}
	if (
		typeof frame.port !== 'number' ||
		!Number.isInteger(frame.port) ||
		frame.port < 1_024 ||
		frame.port > 65_535
	) {
		throw new Error(
			'The boot port must be an integer from 1024 through 65535.',
		);
	}
	if (runtimeMode === 'production' && frame.port !== PRODUCTION_PORT) {
		throw new Error(`Production must bind port ${PRODUCTION_PORT}.`);
	}
	if (frame.authCell !== null && typeof frame.authCell !== 'string') {
		throw new Error('The boot auth cell must be a string or null.');
	}

	for (const key of ['dataDir', 'folderDir'] as const) {
		const directory = frame[key];
		if (
			typeof directory !== 'string' ||
			!isAbsolute(directory) ||
			directory.includes('\0')
		) {
			throw new Error(`The boot ${key} must be an absolute filesystem path.`);
		}
	}
	return frame as BootFrame;
}

export function createReadyFrame(port: number): ReadyFrame {
	return {
		type: 'ready',
		protocolVersion: SIDECAR_PROTOCOL_VERSION,
		port,
	};
}

/** Read the boot line, then expose every later Rust frame on the same pipe. */
export function watchParentPipe(
	stream: ReadableStream<Uint8Array>,
): ParentPipe {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let isBootSettled = false;
	const boot = Promise.withResolvers<string>();
	let frameController!: ReadableStreamDefaultController<string>;
	const frames = new ReadableStream<string>({
		start(controller) {
			frameController = controller;
		},
	});

	const closed = (async (): Promise<void> => {
		let buffer = '';
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (value) {
					buffer += decoder.decode(value, { stream: true });
				}

				let newline = buffer.indexOf('\n');
				while (newline !== -1) {
					const line = buffer.slice(0, newline).replace(/\r$/, '');
					buffer = buffer.slice(newline + 1);
					if (isBootSettled) frameController.enqueue(line);
					else {
						isBootSettled = true;
						boot.resolve(line);
					}
					newline = buffer.indexOf('\n');
				}

				if (!done) continue;
				if (!isBootSettled) {
					isBootSettled = true;
					boot.reject(
						new Error('The parent pipe closed before a complete boot line.'),
					);
				}
				if (buffer !== '') {
					frameController.error(
						new Error('The parent pipe closed during an incomplete frame.'),
					);
				} else {
					frameController.close();
				}
				return;
			}
		} catch (error) {
			if (!isBootSettled) {
				isBootSettled = true;
				boot.reject(
					error instanceof Error
						? error
						: new Error('Failed to read the parent pipe.'),
				);
			}
			frameController.error(error);
			throw error;
		}
	})();

	return {
		bootLine: boot.promise,
		frames,
		closed,
		async cancel() {
			await reader.cancel();
		},
	};
}

/**
 * Bind the fixed native operations to the versioned Rust pipe.
 *
 * The port names no keyring entry and invokes no arbitrary native command. It
 * carries the desktop auth cell, an authorization URL to open, a relaunch, and
 * one labeled application secret. The secret operations send an application id
 * and an account id, both validated before they reach here; Rust composes the
 * service and account strings it stores under, so what crosses this pipe stays
 * a pair of labels rather than an address in the credential store (ADR-0310).
 */
export function createNativeAuthPort(
	{ parentPipe }: { parentPipe: ParentPipe },
	{
		writeLine = (line) => process.stdout.write(`${line}\n`),
		createRequestId = () => crypto.randomUUID(),
	}: {
		writeLine?: (line: string) => unknown;
		createRequestId?: () => string;
	} = {},
) {
	const pending = new Map<
		string,
		{ resolve(value: string | null): void; reject(error: Error): void }
	>();
	const callbackListeners = new Set<(url: string) => void>();
	let queuedCallback: string | null = null;

	function send(frame: unknown) {
		writeLine(JSON.stringify(frame));
	}

	function request(
		frame:
			| { type: 'close-applications' }
			| { type: 'resume-applications' }
			| { type: 'store-auth'; serialized: string | null }
			| { type: 'open-auth-url'; url: string }
			| {
					type: 'put-app-secret';
					appId: string;
					account: AccountIdentity | null; label: string;
					value: string;
			  }
			| { type: 'get-app-secret'; appId: string; account: AccountIdentity | null; label: string }
			| { type: 'delete-app-secret'; appId: string; account: AccountIdentity | null; label: string },
	): Promise<string | null> {
		const requestId = createRequestId();
		return new Promise<string | null>((resolve, reject) => {
			pending.set(requestId, { resolve, reject });
			try {
				send({ ...frame, requestId });
			} catch (cause) {
				pending.delete(requestId);
				reject(cause instanceof Error ? cause : new Error(String(cause)));
			}
		});
	}

	function accept(line: string) {
		const frame = parseNativeFrame(line);
		if (frame.type === 'auth-callback') {
			if (callbackListeners.size === 0) queuedCallback = frame.url;
			else for (const listener of callbackListeners) listener(frame.url);
			return;
		}

		const request = pending.get(frame.requestId);
		if (!request) {
			throw new Error(
				`Rust returned unknown native request ${frame.requestId}.`,
			);
		}
		pending.delete(frame.requestId);
		if (frame.status === 'ok') request.resolve(frame.value ?? null);
		else request.reject(new Error(frame.message));
	}

	const completed = (async () => {
		const reader = parentPipe.frames.getReader();
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (done) return;
				accept(value);
			}
		} finally {
			for (const request of pending.values()) {
				request.reject(new Error('The native auth port closed.'));
			}
			pending.clear();
		}
	})();

	return {
		completed,
		async storeAuth(serialized: string | null) {
			await request({ type: 'store-auth', serialized });
		},
		async openAuthUrl(url: string) {
			await request({ type: 'open-auth-url', url });
		},
		async putAppSecret(
			appId: string,
			account: AccountIdentity | null,
			label: string,
			value: string,
		) {
			await request({ type: 'put-app-secret', appId, account, label, value });
		},
		async getAppSecret(
			appId: string,
			account: AccountIdentity | null,
			label: string,
		) {
			const value = await request({
				type: 'get-app-secret',
				appId,
				account,
				label,
			});
			if (value !== null && typeof value !== 'string')
				throw new Error('Invalid native secret value.');
			return value;
		},
		async deleteAppSecret(
			appId: string,
			account: AccountIdentity | null,
			label: string,
		) {
			await request({ type: 'delete-app-secret', appId, account, label });
		},
		async closeApplications() {
			await request({ type: 'close-applications' });
		},
		async resumeApplications() {
			await request({ type: 'resume-applications' });
		},
		relaunch() {
			send({ type: 'relaunch' });
		},
		onAuthCallback(listener: (url: string) => void) {
			callbackListeners.add(listener);
			if (queuedCallback !== null) {
				const callback = queuedCallback;
				queuedCallback = null;
				listener(callback);
			}
			return () => callbackListeners.delete(listener);
		},
	};
}

type NativeFrame =
	| {
			type: 'native-result';
			requestId: string;
			status: 'ok';
			value?: string | null;
	  }
	| {
			type: 'native-result';
			requestId: string;
			status: 'error';
			message: string;
			value?: undefined;
	  }
	| { type: 'auth-callback'; url: string };

function parseNativeFrame(line: string): NativeFrame {
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		throw new Error('The native auth frame must be valid JSON.');
	}
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw new Error('The native auth frame must be a JSON object.');
	}
	const frame = value as Record<string, unknown>;
	if (frame.type === 'auth-callback') {
		assertExactKeys(frame, ['type', 'url']);
		if (typeof frame.url !== 'string' || !isAuthCallback(frame.url)) {
			throw new Error('Rust sent an invalid auth callback URL.');
		}
		return frame as NativeFrame;
	}
	if (frame.type === 'native-result') {
		// `value` is present only on a read, and only when Rust found an entry.
		// Absent and `null` both mean "nothing stored", so the read arm accepts
		// either rather than making Rust choose a spelling.
		const keys =
			frame.status === 'error'
				? ['message', 'requestId', 'status', 'type']
				: 'value' in frame
					? ['requestId', 'status', 'type', 'value']
					: ['requestId', 'status', 'type'];
		assertExactKeys(frame, keys);
		if (
			'value' in frame &&
			frame.value !== null &&
			typeof frame.value !== 'string'
		) {
			throw new Error('The native result value must be a string or null.');
		}
		if (typeof frame.requestId !== 'string' || frame.requestId === '') {
			throw new Error('The native result requestId must be non-empty.');
		}
		if (frame.status !== 'ok' && frame.status !== 'error') {
			throw new Error('The native result status must be ok or error.');
		}
		if (frame.status === 'error' && typeof frame.message !== 'string') {
			throw new Error('The native result error must include a message.');
		}
		return frame as NativeFrame;
	}
	throw new Error(`Unknown native auth frame: ${String(frame.type)}.`);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[]) {
	const keys = Object.keys(value).sort();
	if (
		keys.length !== expected.length ||
		keys.some((key, index) => key !== expected[index])
	) {
		throw new Error(`Unexpected keys in ${String(value.type)} frame.`);
	}
}

function isAuthCallback(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			`${url.protocol}//${url.host}${url.pathname}` === AUTH_CALLBACK &&
			(url.searchParams.has('code') || url.searchParams.has('error')) &&
			url.username === '' &&
			url.password === '' &&
			url.hash === ''
		);
	} catch {
		return false;
	}
}

/** Wait for a parent exit signal, then stop accepting work and release state. */
export async function superviseSidecar({
	server,
	host,
	parentPipe,
	protocol,
	signals = process,
	report = (message) => {
		process.stderr.write(`${message}\n`);
	},
	exit = (code) => process.exit(code),
	graceMs = SHUTDOWN_GRACE_MS,
}: {
	server: SidecarServer;
	host: SidecarHost;
	parentPipe: ParentPipe;
	protocol?: { completed: Promise<void> };
	signals?: SignalSource;
	report?: (message: string) => void;
	exit?: (code: number) => void;
	graceMs?: number;
}): Promise<void> {
	const shutdownRequested = Promise.withResolvers<string>();
	const onSignal = () => shutdownRequested.resolve('a termination signal');
	signals.once('SIGTERM', onSignal);
	signals.once('SIGINT', onSignal);

	// Named before it is used, because the `finally` below reports it whether
	// the race resolved or threw, and a shutdown nobody can attribute is the
	// one that costs an afternoon.
	let cause = 'an unknown cause';
	try {
		cause = await Promise.race([
			shutdownRequested.promise,
			parentPipe.closed.then(() => 'the parent pipe closing'),
			...(protocol
				? [protocol.completed.then(() => 'the native protocol completing')]
				: []),
		]);
	} catch (error) {
		cause = `the native protocol failing: ${extractErrorMessage(error)}`;
		throw error;
	} finally {
		report(`Epicenter host: shutting down after ${cause}.`);
		// A shutdown that never finishes leaves this process alive and not
		// listening, which is the worst of both: Rust supervises whether the
		// child is alive, so a host stranded here looks healthy forever and is
		// never restarted. Leaving is the recoverable answer.
		const stranded = setTimeout(() => {
			report(
				`Epicenter host: shutdown after ${cause} did not finish within ${graceMs}ms; exiting so the parent can restart it.`,
			);
			exit(1);
		}, graceMs);
		try {
			// Force-stop releases the listener and sockets immediately. Bun 1.3.1
			// through 1.3.14 can leave its promise pending after server-initiated
			// WebSocket close, so waiting here would skip every owner's disposal.
			void Promise.resolve(server.stop(true)).catch((error: unknown) => {
				report(
					`Epicenter host: force-stop failed: ${extractErrorMessage(error)}`,
				);
			});
		} finally {
			try {
				await host[Symbol.asyncDispose]();
			} finally {
				signals.off('SIGTERM', onSignal);
				signals.off('SIGINT', onSignal);
				await parentPipe.cancel();
				clearTimeout(stranded);
			}
		}
	}
}
