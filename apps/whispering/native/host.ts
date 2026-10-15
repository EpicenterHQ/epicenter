/**
 * The Whispering host: the page's server and its application services.
 *
 * It serves the built page on loopback and answers the operations a page
 * cannot do itself: the terminal, revealing the folder, transcription and
 * text requests over this device's two connections, the microphone chosen on
 * this device, and fixture audio.
 *
 * It does not open the data folder. The desktop shell grants the directory
 * to the page, whose folder engine reads it, publishes files, and records
 * history through Tauri. This process is given the same directory by the
 * shell and is an ordinary program beside the page: the terminal writes the directory
 * the way any shell does, transcription reads one audio file out of it, and
 * the connections and chosen microphone are one file under its `.git`. It
 * takes no folder lock, opens no folder, initializes no Git, and watches
 * nothing.
 *
 * `handle` is a plain `Request -> Response` function. `main.ts` binds it to a
 * port; tests call it directly.
 */
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { Err, Ok } from 'wellcrafted/result';
import { audioMimeTypeOf } from '../src/lib/audio-format.js';
import { decode, encode } from '../src/lib/bridge/codec.js';
import type { MicrophonePreference } from '../src/lib/capture.js';
import {
	type ConnectionChange,
	type ConnectionDefaults,
	type ConnectionsInfo,
	canonicalBaseUrl,
	connectionInfo,
	type KeyChange,
	type LegacyKeyTargets,
	OPERATIONS,
	type Operation,
	type StoredConnection,
} from '../src/lib/connections.js';
import { DEFAULT_TRANSCRIPTION_CONNECTION } from '../src/lib/definition.js';
import { transcribeOverConnection } from '../src/lib/transcription.js';
import { transformOverConnection } from '../src/lib/transformation.js';
import { readAudio } from './audio.js';
import {
	connectionIn,
	createDeviceFile,
	legacyKeyIn,
	microphoneIn,
	readMicrophone,
} from './device-file.js';
import {
	createFailureInjection,
	type FailureInjection,
} from './failure-injection.js';
import { createShellTerminal } from './terminal.js';

export type HostOptions = {
	/**
	 * The data folder, as the shell resolved it. The shell chooses, creates,
	 * and canonicalizes it once and registers the same directory with the
	 * folder plugin, which grants it to the page; this host uses exactly that
	 * spelling and never picks or creates one.
	 */
	readonly root: string;
	/** The per-launch credential every bridge request must carry. */
	readonly token: string;
	/** The built page, or undefined to serve only the bridge. */
	readonly uiDist: string | undefined;
	/** Set by a debug shell. Enables fixture audio and failure injection. */
	readonly debug: boolean;
	readonly fixturePath: string | undefined;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly log: (message: string) => void;
	/** Injected in tests; transcription and transformation requests leave through it. */
	readonly fetch?: (input: string, init?: RequestInit) => Promise<Response>;
};

export type HostInfo = {
	readonly root: string;
	readonly platform: string;
	readonly shell: string;
	readonly debug: boolean;
	readonly fixture: { readonly name: string; readonly size: number } | null;
	/** A fixture was requested from a shell that does not allow one. */
	readonly fixtureRefused: boolean;
	/** Where an unconfigured connection's form starts. Nothing is sent there until it is saved. */
	readonly defaults: ConnectionDefaults;
};

/** Why the transcription connection cannot be changed from the app, when it comes from the launch. */
const ENVIRONMENT_CONNECTION =
	'The transcription connection comes from WHISPERING_TRANSCRIPTION_API_KEY and WHISPERING_TRANSCRIPTION_BASE_URL for this launch.';

/**
 * The transcription connection a launch names with
 * `WHISPERING_TRANSCRIPTION_API_KEY`, or undefined when it names none. Its
 * base URL and model are the launch's own, so nothing saved in the folder or
 * on the device retargets that key. An empty key is a keyless connection.
 */
function environmentConnection(
	env: HostOptions['env'],
): StoredConnection | undefined {
	const key = env.WHISPERING_TRANSCRIPTION_API_KEY;
	if (key === undefined) return undefined;
	const raw =
		env.WHISPERING_TRANSCRIPTION_BASE_URL ??
		DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl;
	const { data: baseUrl, error: urlError } = canonicalBaseUrl(raw);
	if (urlError !== null)
		throw new Error(
			`WHISPERING_TRANSCRIPTION_BASE_URL is not a base URL this host can send to: ${urlError}`,
		);
	const model =
		env.WHISPERING_TRANSCRIPTION_MODEL ??
		DEFAULT_TRANSCRIPTION_CONNECTION.model;
	return key === '' ? { baseUrl, model } : { baseUrl, model, apiKey: key };
}

function readOperation(value: unknown): Operation {
	if (value === 'transcription' || value === 'text') return value;
	throw new Error('A connection is transcription or text.');
}

function readKeyChange(value: unknown): KeyChange {
	const { action, key } = (value ?? {}) as Record<string, unknown>;
	if (action === 'keep' || action === 'remove') return { action };
	if (action === 'replace' && typeof key === 'string') return { action, key };
	throw new Error('A key change is keep, remove, or replace with the new key.');
}

function readTarget(value: unknown): { baseUrl: string; model: string } {
	const { baseUrl, model } = (value ?? {}) as Record<string, unknown>;
	if (typeof baseUrl !== 'string' || typeof model !== 'string')
		throw new Error('A connection names a base URL and a model.');
	return { baseUrl, model };
}

/** What `preferences` and `set-preferences` answer. Never the key. */
export type DevicePreferences = {
	/** The microphone chosen on this device, or null for the system default. */
	readonly microphone: MicrophonePreference | null;
};

const CONTENT_TYPES: Record<string, string> = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.webmanifest': 'application/manifest+json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.woff2': 'font/woff2',
	'.wasm': 'application/wasm',
	'.txt': 'text/plain; charset=utf-8',
};

/**
 * The page talks to this host and to the shell's own commands, which is how it
 * reaches the folder. Transcription requests leave from the host.
 */
const PAGE_POLICY = [
	"default-src 'self'",
	"connect-src 'self' ipc: http://ipc.localhost",
	"img-src 'self' data: blob:",
	"media-src 'self' blob:",
	"font-src 'self' data:",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline'",
	"worker-src 'self' blob:",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-ancestors 'none'",
].join('; ');

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
		},
	});

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

export async function createHost(options: HostOptions) {
	const root = options.root;
	// A host given anything but the shell's resolved directory serves nothing;
	// the shell shows its failure page.
	const resolved = isAbsolute(root)
		? await realpath(root).catch(() => undefined)
		: undefined;
	if (resolved !== root || !(await stat(root)).isDirectory())
		throw new Error(
			`The data folder '${root}' is not the existing, resolved directory the desktop shell selects. This host does not choose or create one.`,
		);
	const terminal = createShellTerminal(root);
	const device = createDeviceFile(
		join(root, '.git', 'epicenter', 'whispering', 'device.json'),
	);

	// The counters armed at launch are numbers and touch nothing. The branch
	// lock is taken now: it needs no repository, since the first commit
	// creates the branch it locks. A lock it cannot take is logged, and the
	// host starts all the same.
	const injection: FailureInjection | undefined = options.debug
		? createFailureInjection({
				root,
				launch: {
					rowWrites: Number(options.env.WHISPERING_DEBUG_FAIL_ROW_WRITES ?? 0),
					audioWrites: Number(
						options.env.WHISPERING_DEBUG_FAIL_AUDIO_WRITES ?? 0,
					),
				},
			})
		: undefined;
	if (
		injection !== undefined &&
		options.env.WHISPERING_DEBUG_BLOCK_COMMITS === '1'
	)
		await injection.arm({ commitsBlocked: true }).catch((cause) => {
			options.log(
				`The branch lock asked for at launch was not taken: ${describe(cause)}`,
			);
		});

	async function fixtureInfo(): Promise<HostInfo['fixture']> {
		if (!options.debug || options.fixturePath === undefined) return null;
		try {
			const stats = await stat(options.fixturePath);
			return { name: basename(options.fixturePath), size: stats.size };
		} catch (cause) {
			options.log(
				`The audio fixture at ${options.fixturePath} is not readable: ${describe(cause)}`,
			);
			return { name: basename(options.fixturePath), size: 0 };
		}
	}

	const environment = environmentConnection(options.env);

	/**
	 * The connection an operation uses now, read once per call. Rejects when
	 * the device file cannot be read or holds one that does not read as a
	 * connection: an unreadable connection is never taken for none.
	 */
	async function storedConnection(
		operation: Operation,
	): Promise<StoredConnection | undefined> {
		if (operation === 'transcription' && environment !== undefined)
			return environment;
		return connectionIn(await device.read(), operation);
	}

	/** What the page may know about the connections: never a key. */
	async function connections(): Promise<ConnectionsInfo> {
		const values = await device.read();
		const describeOne = (operation: Operation) => {
			if (operation === 'transcription' && environment !== undefined)
				return connectionInfo(environment, ENVIRONMENT_CONNECTION);
			const stored = connectionIn(values, operation);
			return stored && connectionInfo(stored);
		};
		return {
			transcription: describeOne('transcription'),
			text: describeOne('text'),
			legacyKey: legacyKeyIn(values) !== '',
		};
	}

	const readOnly: Partial<Record<Operation, string>> =
		environment === undefined ? {} : { transcription: ENVIRONMENT_CONNECTION };

	// --- application operations --------------------------------------------

	async function info(): Promise<HostInfo> {
		return {
			root,
			platform: process.platform,
			shell: terminal.shell,
			debug: options.debug,
			fixture: await fixtureInfo(),
			fixtureRefused: !options.debug && options.fixturePath !== undefined,
			defaults: {
				transcription: {
					baseUrl:
						options.env.WHISPERING_TRANSCRIPTION_BASE_URL ??
						DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl,
					model:
						options.env.WHISPERING_TRANSCRIPTION_MODEL ??
						DEFAULT_TRANSCRIPTION_CONNECTION.model,
				},
				// Only the person knows which chat model their endpoint serves.
				text: { baseUrl: DEFAULT_TRANSCRIPTION_CONNECTION.baseUrl, model: '' },
			},
		};
	}

	async function reveal() {
		const [command, args] =
			process.platform === 'darwin'
				? ['open', [root]]
				: process.platform === 'win32'
					? ['explorer', [root]]
					: ['xdg-open', [root]];
		await new Promise<void>((settle, fail) => {
			const child = spawn(command as string, args as string[], {
				stdio: 'ignore',
				detached: true,
			});
			child.on('error', fail);
			child.on('spawn', () => {
				child.unref();
				settle();
			});
		});
		return { revealed: root };
	}

	/**
	 * Send the audio at a folder-relative path over the transcription
	 * connection. The connection is read once, at entry; then the file is read
	 * here, once, as it is at that moment, and those bytes are what is sent:
	 * nothing is read again and the page carries no audio. A path that cannot
	 * be read sends nothing.
	 */
	async function transcribe(payload: Record<string, unknown>) {
		const path = String(payload.path ?? '');
		return transcribeOverConnection(
			() => storedConnection('transcription'),
			{
				audioPath: path,
				expectedBaseUrl: String(payload.expectedBaseUrl ?? ''),
				model: String(payload.model ?? ''),
			},
			async () => {
				const { data: bytes, error: readError } = await readAudio(root, path);
				if (readError !== null) return Err(readError.message);
				return Ok({
					bytes,
					filename: basename(path),
					mimeType: audioMimeTypeOf(path) ?? 'application/octet-stream',
				});
			},
			options.fetch,
		);
	}

	/**
	 * Send a prepared request over the text connection. The key is added here
	 * and never returned, logged, or written to the folder. The transcription
	 * connection's key, including one from the environment, is never used for
	 * it.
	 */
	async function transform(payload: Record<string, unknown>) {
		return transformOverConnection(
			() => storedConnection('text'),
			{
				expectedBaseUrl: String(payload.expectedBaseUrl ?? ''),
				model: String(payload.model ?? ''),
				prompt: String(payload.prompt ?? ''),
				input: String(payload.input ?? ''),
			},
			options.fetch,
		);
	}

	/**
	 * Save one connection. Its base URL, model, and key change in one write,
	 * and a key is kept only for the base URL it was saved for. The reply says
	 * what is set now, never the key.
	 */
	async function setConnection(
		payload: Record<string, unknown>,
	): Promise<ConnectionsInfo> {
		const operation = readOperation(payload.operation);
		const reason = readOnly[operation];
		if (reason !== undefined) throw new Error(reason);
		const change: ConnectionChange = {
			...readTarget(payload),
			key: readKeyChange(payload.key),
		};
		await device.setConnection(operation, change);
		return connections();
	}

	/**
	 * Move the earlier build's key into the connections the person chose, at
	 * the base URLs they were shown. The key is never returned.
	 */
	async function adoptLegacy(
		payload: Record<string, unknown>,
	): Promise<ConnectionsInfo> {
		const given = (payload.targets ?? {}) as Record<string, unknown>;
		const targets: LegacyKeyTargets = {};
		for (const operation of OPERATIONS)
			if (given[operation] !== undefined)
				targets[operation] = readTarget(given[operation]);
		await device.adoptLegacyKey(targets, readOnly);
		return connections();
	}

	/**
	 * What this device remembers that is not a secret. The reply is built from
	 * the named preferences only, so the key in the same file is never in it.
	 */
	async function preferences(): Promise<DevicePreferences> {
		return { microphone: microphoneIn(await device.read()) ?? null };
	}

	/**
	 * Remember the chosen microphone, or with `null` forget it. Only that
	 * field of the device file changes: the connections stay as they are,
	 * including when the transcription connection comes from the environment.
	 */
	async function setPreferences(
		payload: Record<string, unknown>,
	): Promise<DevicePreferences> {
		const microphone =
			payload.microphone === null
				? undefined
				: readMicrophone(payload.microphone);
		if (payload.microphone !== null && microphone === undefined)
			throw new Error(
				'A microphone preference is null, or a device ID and the name it was chosen under.',
			);
		await device.setMicrophone(microphone);
		return { microphone: microphone ?? null };
	}

	async function fixture() {
		if (!options.debug || options.fixturePath === undefined)
			throw new Error('Fixture audio is only available in a debug shell.');
		return {
			name: basename(options.fixturePath),
			bytes: new Uint8Array(await readFile(options.fixturePath)),
		};
	}

	function debugInjection(): FailureInjection {
		if (injection === undefined)
			throw new Error('Failure injection is only available in a debug shell.');
		return injection;
	}

	async function app(op: string, payload: Record<string, unknown>) {
		switch (op) {
			case 'info':
				return info();
			case 'terminal':
				return terminal.exec({
					command: String(payload.command ?? ''),
					cwd: String(payload.cwd ?? ''),
				});
			case 'reveal':
				return reveal();
			case 'transcribe':
				return transcribe(payload);
			case 'transform':
				return transform(payload);
			case 'connections':
				return connections();
			case 'set-connection':
				return setConnection(payload);
			case 'adopt-legacy-key':
				return adoptLegacy(payload);
			case 'preferences':
				return preferences();
			case 'set-preferences':
				return setPreferences(payload);
			case 'fixture':
				return fixture();
			case 'inject':
				return debugInjection().arm(payload);
			case 'injection':
				return debugInjection().state;
			case 'obstruct':
				return {
					obstacle: await debugInjection().obstruct({
						step: payload.step,
						stem: payload.stem,
						path: payload.path,
					}),
				};
			case 'unobstruct':
				await debugInjection().clear(payload.obstacle);
				return {};
			default:
				throw new Error(`'${op}' is not a Whispering host operation`);
		}
	}

	// --- static page --------------------------------------------------------

	async function page(pathname: string): Promise<Response> {
		const dist = options.uiDist;
		if (dist === undefined)
			return new Response('This host serves only the folder bridge.', {
				status: 404,
			});
		let decoded: string;
		try {
			decoded = decodeURIComponent(pathname);
		} catch {
			return new Response('Bad request', { status: 400 });
		}
		const base = resolve(dist);
		let file = resolve(base, `.${decoded}`);
		if (file !== base && !file.startsWith(base + sep))
			return new Response('Not found', { status: 404 });
		const isFile = await stat(file).then(
			(stats) => stats.isFile(),
			() => false,
		);
		if (!isFile) {
			// A missing asset is missing; any other path is a page of the SPA.
			if (decoded.startsWith('/_app/') || extname(decoded) !== '')
				return new Response('Not found', { status: 404 });
			file = join(base, 'index.html');
		}
		let bytes: Uint8Array;
		try {
			bytes = new Uint8Array(await readFile(file));
		} catch {
			return new Response(
				'The Whispering page has not been built. Run `bun run build` in apps/whispering.',
				{ status: 503 },
			);
		}
		// The token is never in what is served: the shell gives it to the page.
		const html = extname(file) === '.html';
		return new Response(bytes as Uint8Array<ArrayBuffer>, {
			headers: {
				'content-type':
					CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
				'cache-control': decoded.startsWith('/_app/immutable/')
					? 'public, max-age=31536000, immutable'
					: 'no-store',
				...(html && { 'content-security-policy': PAGE_POLICY }),
				'x-content-type-options': 'nosniff',
			},
		});
	}

	// --- request handling ---------------------------------------------------

	let port: number | undefined;
	const expectedToken = Buffer.from(`Bearer ${options.token}`);

	function authorized(request: Request): boolean {
		const offered = Buffer.from(request.headers.get('authorization') ?? '');
		return (
			offered.length === expectedToken.length &&
			timingSafeEqual(offered, expectedToken)
		);
	}

	/** Refuse a request that reached this port under another name or from another page. */
	function local(request: Request): boolean {
		if (port === undefined) return true;
		const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
		const host = request.headers.get('host');
		if (host !== null && !hosts.includes(host)) return false;
		const origin = request.headers.get('origin');
		return origin === null || hosts.some((name) => origin === `http://${name}`);
	}

	async function handle(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (!local(request)) return new Response('Forbidden', { status: 403 });
		if (!url.pathname.startsWith('/bridge/')) {
			if (request.method !== 'GET' && request.method !== 'HEAD')
				return new Response('Method not allowed', { status: 405 });
			return page(url.pathname);
		}
		if (!authorized(request)) return json({ fault: 'Unauthorized' }, 401);
		if (request.method !== 'POST')
			return json({ fault: 'Method not allowed' }, 405);
		let body: Record<string, unknown>;
		try {
			body = (await request.json()) as Record<string, unknown>;
		} catch {
			return json({ fault: 'The request body is not JSON' }, 400);
		}
		// The one route. There is no folder route: the page's folder is the shell's.
		if (url.pathname !== '/bridge/app')
			return json({ fault: 'Not found' }, 404);
		try {
			const payload = decode(body.payload ?? {}) as Record<string, unknown>;
			return json({ ok: encode(await app(String(body.op), payload)) });
		} catch (cause) {
			options.log(`Bridge call failed: ${describe(cause)}`);
			return json({ fault: describe(cause) }, 500);
		}
	}

	return {
		root,
		handle,
		/** The bound port, so requests under another host name are refused. */
		listening(bound: number) {
			port = bound;
		},
		/**
		 * Remove what a debug host put in the folder. The folder is the
		 * shell's to close; nothing here saves or commits.
		 */
		async close() {
			await injection?.release();
		},
	};
}

export type Host = Awaited<ReturnType<typeof createHost>>;
