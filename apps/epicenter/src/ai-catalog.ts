import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { type AccountIdentity, deviceOwnerPath } from '@epicenter/principal';
import { createLogger } from 'wellcrafted/logger';
import type { AppSecretOwner } from './app-secrets.js';

export type AiCatalogInput = {
	name?: string;
	baseUrl: string;
	apiKey?: string;
	models?: string[];
};
export type AiCatalogConnection = {
	id: string;
	name: string;
	baseUrl: string;
	models: string[];
	hasApiKey: boolean;
	accessVersion: string;
};
export type AiCatalogSnapshot = {
	revision: number;
	connections: AiCatalogConnection[];
};
export type AiCatalogCommand =
	| { type: 'add'; input: AiCatalogInput }
	| { type: 'update'; id: string; patch: Partial<AiCatalogInput> }
	| { type: 'remove'; id: string }
	| { type: 'reorder'; ids: string[] };

type SavedConnection = AiCatalogConnection & { secretVersion?: string };
type SavedCatalog = {
	version: 1;
	revision: number;
	connections: SavedConnection[];
	/** Inert version-1 data, retained when an existing catalog is saved. */
	imports: string[];
};
const secretAppId = 'so.epicenter.ai-catalog';
const logger = createLogger('epicenter/ai-catalog');

function endpoint(value: unknown): string {
	if (typeof value !== 'string') throw new Error('Invalid AI endpoint.');
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error('Invalid AI endpoint.');
	}
	if (
		!['http:', 'https:'].includes(url.protocol) ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	)
		throw new Error('Invalid AI endpoint.');
	return value;
}
function identifier(value: unknown): string {
	if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value))
		throw new Error('Invalid AI connection identity.');
	return value;
}
function input(value: unknown): AiCatalogInput {
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new Error('Invalid AI connection.');
	const entry = value as Record<string, unknown>;
	const baseUrl = endpoint(entry.baseUrl);
	if (entry.name !== undefined && typeof entry.name !== 'string')
		throw new Error('Invalid AI connection name.');
	if (entry.apiKey !== undefined && typeof entry.apiKey !== 'string')
		throw new Error('Invalid AI connection key.');
	if (
		entry.models !== undefined &&
		(!Array.isArray(entry.models) ||
			entry.models.some((model) => typeof model !== 'string'))
	)
		throw new Error('Invalid AI connection models.');
	return {
		baseUrl,
		name: entry.name as string | undefined,
		apiKey: entry.apiKey as string | undefined,
		models: entry.models as string[] | undefined,
	};
}
function parseSaved(value: unknown): SavedCatalog {
	if (!value || typeof value !== 'object')
		throw new Error('Invalid saved AI catalog.');
	const saved = value as Record<string, unknown>;
	if (
		saved.version !== 1 ||
		!Number.isSafeInteger(saved.revision) ||
		(saved.revision as number) < 0 ||
		!Array.isArray(saved.connections) ||
		!Array.isArray(saved.imports) ||
		saved.imports.some((source) => typeof source !== 'string')
	)
		throw new Error('Invalid saved AI catalog.');
	const connections = saved.connections.map((raw: unknown) => {
		if (!raw || typeof raw !== 'object' || 'apiKey' in raw)
			throw new Error('Invalid saved AI connection.');
		const entry = raw as Record<string, unknown>;
		const validated = input(entry);
		if (
			typeof entry.name !== 'string' ||
			!Array.isArray(entry.models) ||
			typeof entry.hasApiKey !== 'boolean' ||
			entry.hasApiKey !== (entry.secretVersion !== undefined)
		)
			throw new Error('Invalid saved AI connection.');
		return {
			id: identifier(entry.id),
			name: entry.name,
			baseUrl: validated.baseUrl,
			models: validated.models!,
			hasApiKey: entry.hasApiKey,
			accessVersion: identifier(entry.accessVersion),
			...(entry.secretVersion === undefined
				? {}
				: { secretVersion: identifier(entry.secretVersion) }),
		};
	});
	if (new Set(connections.map((entry) => entry.id)).size !== connections.length)
		throw new Error('Duplicate saved AI connection.');
	return {
		version: 1,
		revision: saved.revision as number,
		connections,
		imports: saved.imports as string[],
	};
}

/** One desktop profile owns the serialized catalog and its keychain references. */
export async function createAiCatalog({
	dataRoot,
	secrets,
	account,
	fetch: send = globalThis.fetch,
}: {
	dataRoot: string;
	secrets: AppSecretOwner;
	account?: AccountIdentity;
	fetch?: typeof globalThis.fetch;
}) {
	const directory = join(dataRoot, 'ai', deviceOwnerPath(account));
	const path = join(directory, 'connections.json');
	await mkdir(directory, { recursive: true, mode: 0o700 });
	let state: SavedCatalog;
	try {
		state = parseSaved(JSON.parse(await readFile(path, 'utf8')));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
			throw new Error('Could not open the saved AI catalog.');
		state = { version: 1, revision: 0, connections: [], imports: [] };
	}
	const lifetime = new AbortController();
	const listeners = new Set<(snapshot: AiCatalogSnapshot) => void>();
	const active = new Map<
		AbortController,
		{
			id: string | null;
			accessVersion: string;
			done: Promise<void>;
			release: () => void;
		}
	>();
	function admit(id: string | null, accessVersion: string) {
		const controller = new AbortController();
		const completion = Promise.withResolvers<void>();
		active.set(controller, {
			id,
			accessVersion,
			done: completion.promise,
			release: completion.resolve,
		});
		return controller;
	}
	function finish(controller: AbortController) {
		active.get(controller)?.release();
		active.delete(controller);
	}
	let queue: Promise<unknown> = Promise.resolve();
	let closing: Promise<void> | undefined;
	const label = (id: string, version: string) => `ai.${id}.${version}`;
	function assertOpen() {
		if (lifetime.signal.aborted) throw new Error('AI catalog is closed.');
	}
	function snapshot(): AiCatalogSnapshot {
		return {
			revision: state.revision,
			connections: state.connections.map(({ secretVersion: _, ...entry }) =>
				structuredClone(entry),
			),
		};
	}
	async function key(entry: SavedConnection) {
		if (!entry.secretVersion) return undefined;
		const value = await secrets.get(
			secretAppId,
			label(entry.id, entry.secretVersion),
			account,
		);
		if (value === null)
			throw new Error('AI connection credentials are unavailable.');
		return value;
	}
	async function erase(entry: SavedConnection) {
		if (!entry.secretVersion) return;
		try {
			await secrets.delete(
				secretAppId,
				label(entry.id, entry.secretVersion),
				account,
			);
		} catch {
			logger.error(new Error('Could not remove an unused AI credential.'));
		}
	}
	async function persist(next: SavedCatalog) {
		const temporary = join(
			directory,
			`.connections-${crypto.randomUUID()}.tmp`,
		);
		try {
			const file = await open(temporary, 'wx', 0o600);
			try {
				await file.writeFile(JSON.stringify(next));
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, path);
		} catch {
			await unlink(temporary).catch(() => {});
			throw new Error('Could not save the AI catalog.');
		}
		// A rename is already committed. Failure to sync its directory must never
		// roll back its new keychain references. Retain superseded keys instead.
		try {
			const folder = await open(directory, 'r');
			try {
				await folder.sync();
			} finally {
				await folder.close();
			}
			return true;
		} catch {
			return false;
		}
	}
	async function execute(command: AiCatalogCommand) {
		const next = structuredClone(state);
		const created: SavedConnection[] = [];
		let result: string | null = null;
		let durable = false;
		async function prepare(
			id: string,
			candidate: AiCatalogInput,
		): Promise<SavedConnection> {
			const value = input(candidate);
			const version = crypto.randomUUID();
			const apiKey = value.apiKey?.trim() || undefined;
			const entry: SavedConnection = {
				id: identifier(id),
				name: value.name ?? new URL(value.baseUrl).host,
				baseUrl: value.baseUrl,
				models: value.models ?? [],
				hasApiKey: apiKey !== undefined,
				accessVersion: version,
				...(apiKey === undefined ? {} : { secretVersion: version }),
			};
			if (apiKey !== undefined) {
				try {
					await secrets.put(secretAppId, label(id, version), apiKey, account);
				} catch {
					throw new Error('Could not save AI connection credentials.');
				}
			}
			created.push(entry);
			return entry;
		}
		try {
			switch (command.type) {
				case 'add': {
					result = crypto.randomUUID();
					next.connections.push(await prepare(result, command.input));
					break;
				}
				case 'update': {
					const entry = next.connections.find(
						(entry) => entry.id === command.id,
					);
					if (!entry) throw new Error('AI connection does not exist.');
					const candidate = input({
						name: entry.name,
						baseUrl: entry.baseUrl,
						models: entry.models,
						...command.patch,
					});
					if (Object.hasOwn(command.patch, 'apiKey')) {
						// An explicit key assignment replaces access, even when the value
						// happens to match. Repair never depends on reading the old key.
						next.connections[next.connections.indexOf(entry)] = await prepare(
							entry.id,
							candidate,
						);
					} else {
						if (candidate.baseUrl !== entry.baseUrl)
							entry.accessVersion = crypto.randomUUID();
						entry.baseUrl = candidate.baseUrl;
						entry.name = candidate.name ?? new URL(candidate.baseUrl).host;
						entry.models = candidate.models ?? [];
					}
					break;
				}
				case 'remove':
					next.connections = next.connections.filter(
						(entry) => entry.id !== command.id,
					);
					break;
				case 'reorder': {
					if (
						!Array.isArray(command.ids) ||
						command.ids.length !== next.connections.length ||
						new Set(command.ids).size !== command.ids.length ||
						command.ids.some(
							(id) => !next.connections.some((entry) => entry.id === id),
						)
					)
						throw new Error('Invalid AI connection order.');
					next.connections = command.ids.map(
						(id) => next.connections.find((entry) => entry.id === id)!,
					);
					break;
				}
				default:
					throw new Error('Invalid AI catalog command.');
			}
			next.revision++;
			durable = await persist(next);
		} catch (error) {
			await Promise.all(created.map(erase));
			throw error;
		}
		const previous = state;
		state = next;
		for (const [controller, admitted] of active) {
			if (
				admitted.id !== null &&
				!next.connections.some(
					(entry) =>
						entry.id === admitted.id &&
						entry.accessVersion === admitted.accessVersion,
				)
			)
				controller.abort();
		}
		for (const listener of listeners) {
			try {
				listener(snapshot());
			} catch {
				logger.error(new Error('An AI catalog subscriber failed.'));
			}
		}
		if (durable)
			await Promise.all(
				previous.connections
					.filter(
						(entry) =>
							entry.secretVersion &&
							!next.connections.some(
								(current) =>
									current.id === entry.id &&
									current.secretVersion === entry.secretVersion,
							),
					)
					.map(erase),
			);
		return { snapshot: snapshot(), result };
	}
	async function forward(
		baseUrl: string,
		apiKey: string | undefined,
		request: Request,
		suffix: string,
		controller: AbortController,
	) {
		const base = new URL(`${baseUrl.replace(/\/+$/, '')}/`);
		const target = new URL(suffix, base);
		if (
			target.origin !== base.origin ||
			!target.pathname.startsWith(base.pathname)
		)
			throw new Error('Invalid AI request destination.');
		const headers = new Headers(request.headers);
		for (const header of [
			'authorization',
			'cookie',
			'host',
			'origin',
			'referer',
			'connection',
			'content-length',
		])
			headers.delete(header);
		if (apiKey) headers.set('authorization', `Bearer ${apiKey}`);
		const signal = AbortSignal.any([
			request.signal,
			controller.signal,
			lifetime.signal,
		]);
		const response = await send(target, {
			method: request.method,
			headers,
			body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
			redirect: 'error',
			credentials: 'omit',
			signal,
		});
		const responseHeaders = new Headers(response.headers);
		for (const header of [
			'set-cookie',
			'set-cookie2',
			'content-encoding',
			'content-length',
			'connection',
		])
			responseHeaders.delete(header);
		responseHeaders.set('cache-control', 'no-store');
		if (!response.body) {
			finish(controller);
			return new Response(null, {
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			});
		}
		const reader = response.body.getReader();
		let ended = false;
		let abort = () => {};
		function release() {
			ended = true;
			signal.removeEventListener('abort', abort);
			finish(controller);
		}
		return new Response(
			new ReadableStream<Uint8Array>({
				start(sink) {
					abort = () => {
						if (ended) return;
						ended = true;
						// The disconnected socket already failed for its caller. Erroring
						// Bun's response stream during force-stop also fails the process.
						if (request.signal.aborted) sink.close();
						else sink.error(new Error('AI connection request was cancelled.'));
						void reader
							.cancel()
							.catch(() => {})
							.finally(release);
					};
					signal.addEventListener('abort', abort, { once: true });
					if (signal.aborted) abort();
				},
				async pull(sink) {
					try {
						const chunk = await reader.read();
						if (ended) return;
						if (chunk.done) {
							release();
							sink.close();
						} else sink.enqueue(chunk.value);
					} catch (error) {
						if (!ended) {
							release();
							sink.error(error);
						}
					}
				},
				async cancel(reason) {
					if (ended) return;
					ended = true;
					controller.abort();
					try {
						await reader.cancel(reason);
					} finally {
						release();
					}
				},
			}),
			{
				status: response.status,
				statusText: response.statusText,
				headers: responseHeaders,
			},
		);
	}
	return {
		get signal() {
			return lifetime.signal;
		},
		getAll() {
			assertOpen();
			return snapshot();
		},
		subscribe(listener: (value: AiCatalogSnapshot) => void) {
			assertOpen();
			listeners.add(listener);
			try {
				listener(snapshot());
			} catch (error) {
				listeners.delete(listener);
				throw error;
			}
			return () => {
				listeners.delete(listener);
			};
		},
		execute(command: AiCatalogCommand) {
			assertOpen();
			const operation = queue.then(() => execute(command));
			queue = operation.catch(() => {});
			return operation;
		},
		async proxy(
			id: string,
			accessVersion: string,
			request: Request,
			suffix: string,
		) {
			assertOpen();
			const entry = state.connections.find(
				(entry) => entry.id === id && entry.accessVersion === accessVersion,
			);
			if (!entry) throw new Error('AI connection is unavailable or changed.');
			const controller = admit(id, accessVersion);
			try {
				const apiKey = await key(entry);
				controller.signal.throwIfAborted();
				lifetime.signal.throwIfAborted();
				return await forward(
					entry.baseUrl,
					apiKey,
					request,
					suffix,
					controller,
				);
			} catch {
				finish(controller);
				throw new Error('AI connection request failed.');
			}
		},
		close() {
			return (closing ??= (async () => {
				lifetime.abort();
				listeners.clear();
				for (const controller of active.keys()) controller.abort();
				await queue;
				await Promise.all([...active.values()].map((request) => request.done));
			})());
		},
	};
}
export type AiCatalog = Awaited<ReturnType<typeof createAiCatalog>>;
