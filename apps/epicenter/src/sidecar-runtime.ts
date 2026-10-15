/**
 * The private Rust-to-Bun startup protocol and the Bun sidecar lifecycle.
 * Rust resolves the runtime mode and port, then keeps stdin open as its parent
 * lifetime signal. Bun validates that input but never resolves a port itself.
 * After the boot frame the pipe carries nothing: the account is the
 * `epicenter` CLI's (ADR-0556), so no auth crosses it.
 */

import { isAbsolute } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';

/**
 * How long the whole shutdown may take before this process leaves anyway.
 *
 * Under Rust's fifteen-second readiness timeout, so a host that gives up here
 * is restarted rather than declared unreachable. Rust waits longer than this
 * before it kills the process (`SHUTDOWN_TIMEOUT` in `src-tauri/src/lib.rs`),
 * so the host's owners finishing their disposal get this whole window rather
 * than Rust's.
 */
const SHUTDOWN_GRACE_MS = 10_000;
const MAX_NATIVE_FRAME_BYTES = 8 * 1024 * 1024;

export const SIDECAR_PROTOCOL_VERSION = 15;
export const PRODUCTION_PORT = 39_130;

export type SidecarRuntimeMode = 'production' | 'development';

export type BootFrame = {
	type: 'boot';
	protocolVersion: typeof SIDECAR_PROTOCOL_VERSION;
	token: string;
	port: number;
	dataDir: string;
	folderDir: string;
	/** Disposable: built installed apps, under `builds/<app-id>/<commit>/`. */
	cacheDir: string;
};

/** Readiness: the sidecar is listening on the port Rust chose. */
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
	/** Resolves when Rust closes the pipe; rejects when it sends anything after boot. */
	closed: Promise<void>;
	cancel(): Promise<void>;
};

const BOOT_FRAME_KEYS = [
	'cacheDir',
	'dataDir',
	'folderDir',
	'port',
	'protocolVersion',
	'token',
	'type',
];
const BASE64URL = /^[A-Za-z0-9_-]+$/;

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
			'The boot frame must contain exactly type, protocolVersion, token, port, dataDir, folderDir, and cacheDir.',
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
	for (const key of ['dataDir', 'folderDir', 'cacheDir'] as const) {
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

/**
 * Read the boot line, then watch the pipe for Rust closing it. Rust sends
 * nothing after boot, so a later line is a protocol mismatch that ends the
 * host.
 */
export function watchParentPipe(
	stream: ReadableStream<Uint8Array>,
): ParentPipe {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let isBootSettled = false;
	const boot = Promise.withResolvers<string>();

	const closed = (async (): Promise<void> => {
		let buffer = '';
		try {
			while (true) {
				const { value, done } = await reader.read();
				if (value) {
					buffer += decoder.decode(value, { stream: true });
					if (buffer.length > MAX_NATIVE_FRAME_BYTES)
						throw new Error('A line on the parent pipe exceeds its limit.');
				}

				let newline = buffer.indexOf('\n');
				while (newline !== -1) {
					const line = buffer.slice(0, newline).replace(/\r$/, '');
					buffer = buffer.slice(newline + 1);
					if (isBootSettled)
						throw new Error(
							'Rust sent a line after the boot frame; the pipe carries nothing else.',
						);
					isBootSettled = true;
					boot.resolve(line);
					newline = buffer.indexOf('\n');
				}

				if (!done) continue;
				if (!isBootSettled) {
					isBootSettled = true;
					boot.reject(
						new Error('The parent pipe closed before a complete boot line.'),
					);
					return;
				}
				if (buffer !== '')
					throw new Error('The parent pipe closed during an incomplete line.');
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
			throw error;
		}
	})();

	return {
		bootLine: boot.promise,
		closed,
		async cancel() {
			await reader.cancel();
		},
	};
}

/** Wait for a parent exit signal, then stop accepting work and release state. */
export async function superviseSidecar({
	server,
	host,
	parentPipe,
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
		]);
	} catch (error) {
		cause = `the parent pipe failing: ${extractErrorMessage(error)}`;
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
