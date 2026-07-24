/**
 * The Bun sidecar entrypoint: accept one versioned boot frame from Rust, bind
 * its validated loopback port, announce readiness once, and remain tied to the
 * parent stdin pipe for the lifetime of the desktop application.
 *
 * Inference is BYOK for this slice: an OpenAI-compatible endpoint configured
 * by environment. The engine reads the context per turn, so a restart is only
 * needed to change it because this entrypoint reads the env once.
 */

import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import {
	type AgentEngine,
	createBunBlobRemote,
	createEpicenterClient,
	createOpenAiAgentEngine,
} from '@epicenter/client';
import {
	DOCUMENT_PUBLICATION_VERSION,
	type DocumentAcceptance,
	readDocumentAcceptance,
} from '@epicenter/data/document-v1';
import {
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import type { DocumentRealtimeSocket } from '@epicenter/data/runtime';
import {
	type OpenBunEpicenterOptions,
	openBunEpicenter,
} from '@epicenter/data/runtime/bun';
import { honeycrispLens } from '@epicenter/honeycrisp';
import { loadActiveAppCatalog } from './app-catalog.ts';
import {
	createDesktopAuthAuthority,
	type DesktopAuthAuthority,
} from './desktop-auth-authority.ts';
import { createDesktopAuthorityFetch } from './desktop-authority-fetch.ts';
import { createHomeHost, type HomeHost } from './host.ts';
import { SURFACE_ROUTES } from './routes.ts';
import { createHomeServer } from './server.ts';
import {
	createNativeAuthPort,
	createReadyFrame,
	parseBootFrame,
	parseRuntimeMode,
	superviseSidecar,
	watchParentPipe,
} from './sidecar-runtime.ts';
import { loadStaticAssets } from './static-assets.ts';
import { homeLens } from './workspace.ts';

async function main(): Promise<void> {
	const parentPipe = watchParentPipe(Bun.stdin.stream());
	let host: HomeHost | undefined;
	let runtime: Awaited<ReturnType<typeof openBunEpicenter>> | undefined;
	let desktopAuth: DesktopAuthAuthority | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;
	let lifecycleOwnsResources = false;

	try {
		const runtimeMode = parseRuntimeMode(Bun.argv);
		const boot = parseBootFrame(await parentPipe.bootLine, runtimeMode);
		const nativeAuthPort = createNativeAuthPort({ parentPipe });
		const auth = createDesktopAuthAuthority({
			authCell: boot.authCell,
			nativeAuthPort,
		});
		desktopAuth = auth;

		const { engine, model } = homeEngineFromEnvironment(process.env);

		const epicenterDataDir = process.env.EPICENTER_DATA_DIR;
		if (!epicenterDataDir) {
			throw new Error(
				'EPICENTER_DATA_DIR must name the Epicenter app data directory.',
			);
		}
		const authorityFetch = createDesktopAuthorityFetch(auth);
		const owner =
			auth.bootSnapshot.state.status === 'signed-in'
				? {
						deploymentId: new URL(auth.baseURL).href,
						principalId: auth.bootSnapshot.state.principalId,
					}
				: null;
		runtime = await openBunEpicenter({
			directory: join(epicenterDataDir, 'data'),
			owner,
			...(owner === null
				? {}
				: { carrier: createDesktopCarrier(auth, authorityFetch) }),
		});
		const home = runtime.bind(homeLens);
		const honeycrisp = runtime.bind(honeycrispLens);
		host = await createHomeHost({
			engine,
			model,
			honeycrisp: {
				folders: honeycrisp.folders,
				notes: honeycrisp.notes,
			},
			conversations: { conversations: home.conversations },
		});
		const blobs = createBunBlobStore({
			directory: join(epicenterDataDir, 'blobs'),
		});
		// Identity is immutable per process generation, so remote availability
		// is a boot-time fact: a signed-in generation composes the streaming
		// remote over the authority's own deployment fetch, a signed-out one
		// has none until sign-in relaunches the app.
		const blobRemote =
			auth.bootSnapshot.state.status === 'signed-in'
				? createBunBlobRemote({
						store: blobs,
						client: createEpicenterClient({
							baseURL: auth.baseURL,
							fetch: createDesktopAuthorityFetch(auth),
						}),
					})
				: null;

		const appsDist = process.env.EPICENTER_APPS_DIST;
		if (!appsDist) {
			throw new Error(
				'EPICENTER_APPS_DIST must name the release-built Epicenter applications directory.',
			);
		}
		const staticAssets = await loadStaticAssets(appsDist);
		// Source-built catalog members live in host-owned app data; the
		// built-in surfaces stay on the legacy closed layout for this slice.
		// The generation selected here is what this process serves for its
		// whole lifetime; promotions apply at the next restart (ADR-0153).
		const appCatalog = await loadActiveAppCatalog(
			join(epicenterDataDir, 'app-catalog'),
			{ reservedIds: Object.keys(SURFACE_ROUTES) },
		);
		const origin = `http://127.0.0.1:${boot.port}`;
		const { app, websocket } = createHomeServer({
			host,
			origin,
			launchToken: boot.token,
			staticAssets,
			appCatalog,
			blobs,
			desktopAuth: auth,
			blobRemote,
		});

		server = Bun.serve({
			// The Rust-owned port has already passed the mode-specific policy.
			hostname: '127.0.0.1',
			port: boot.port,
			fetch: app.fetch,
			websocket,
		});
		process.stdout.write(`${JSON.stringify(createReadyFrame(boot.port))}\n`);
		lifecycleOwnsResources = true;
		const ownedHost = host;
		const ownedRuntime = runtime;
		const ownedDesktopAuth = auth;
		await superviseSidecar({
			server,
			host: {
				async [Symbol.asyncDispose]() {
					ownedDesktopAuth[Symbol.dispose]();
					await ownedHost[Symbol.asyncDispose]();
					await ownedRuntime[Symbol.asyncDispose]();
				},
			},
			parentPipe,
			protocol: nativeAuthPort,
		});
	} finally {
		if (!lifecycleOwnsResources) {
			if (server) await server.stop(true);
			desktopAuth?.[Symbol.dispose]();
			if (host) await host[Symbol.asyncDispose]();
			if (runtime) await runtime[Symbol.asyncDispose]();
			await parentPipe.cancel();
		}
	}
}

function deploymentUrl(baseUrl: string): URL {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url;
}

function syncUrl(auth: DesktopAuthAuthority, path: string): URL {
	return new URL(`api/sync/v1/${path}`, deploymentUrl(auth.baseURL));
}

function recordPath(address: {
	namespace: string;
	collection: string;
	recordKey: string;
}): string {
	return `records/${address.namespace}/${address.collection}/${address.recordKey}`;
}

function createDesktopCarrier(
	auth: DesktopAuthAuthority,
	authorityFetch: ReturnType<typeof createDesktopAuthorityFetch>,
): NonNullable<OpenBunEpicenterOptions['carrier']> {
	return {
		async fetchFacts(request) {
			const url = syncUrl(auth, 'facts');
			url.searchParams.set('afterSequence', String(request.afterSequence));
			if (request.authorityLifetime !== undefined) {
				url.searchParams.set('authorityLifetime', request.authorityLifetime);
			}
			const response = await authorityFetch(url);
			if (!response.ok) {
				throw new Error(`Epicenter facts read failed (${response.status})`);
			}
			const { data, error } = parseFactsResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (error !== null) throw error;
			return data;
		},
		async submit(sealedRequestBytes) {
			const response = await authorityFetch(syncUrl(auth, 'submissions'), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: sealedRequestBytes,
			});
			if (!response.ok) {
				throw new Error(`Epicenter submission failed (${response.status})`);
			}
			const { data, error } = parseSubmissionResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (error !== null) throw error;
			return data;
		},
		async publishDocument(address, publication): Promise<DocumentAcceptance> {
			const response = await authorityFetch(
				syncUrl(auth, `${recordPath(address)}/document-publications`),
				{
					method: 'POST',
					headers: {
						'content-type': 'application/octet-stream',
						'x-epicenter-authority-lifetime': publication.authorityLifetime,
						'x-epicenter-document-protocol': publication.protocolVersion,
						'x-epicenter-document-digest': publication.digest,
					},
					body: publication.payload.slice().buffer as ArrayBuffer,
				},
			);
			return await readDocumentAcceptance(response, SCALAR_SYNC_V1_LIMITS);
		},
		async publishBlob() {
			throw new Error('Home captures no record blobs');
		},
		documentRealtime: {
			async open(address, authorityLifetime) {
				const authorization = await auth.authorize();
				if (authorization.status !== 'authorized') {
					throw new Error('Epicenter document authorization unavailable');
				}
				const url = syncUrl(auth, `${recordPath(address)}/document`);
				url.searchParams.set('authorityLifetime', authorityLifetime);
				url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
				return new WebSocket(url, [
					DOCUMENT_PUBLICATION_VERSION,
					`bearer.${authorization.accessToken}`,
				]) as unknown as DocumentRealtimeSocket;
			},
		},
	};
}

export function homeEngineFromEnvironment(
	environment: Record<string, string | undefined>,
): { engine: AgentEngine; model: string } {
	const baseURL = environment.EPICENTER_INFERENCE_URL;
	const model = environment.EPICENTER_INFERENCE_MODEL;
	const apiKey = environment.EPICENTER_INFERENCE_API_KEY;
	if (!baseURL || !model) {
		return {
			model: 'unconfigured',
			engine: async function* () {
				yield {
					type: 'run-error',
					code: 'stream-error',
					message:
						'Home needs an OpenAI-compatible endpoint. Set EPICENTER_INFERENCE_URL and EPICENTER_INFERENCE_MODEL, then restart Epicenter.',
				};
			},
		};
	}

	return {
		model,
		engine: createOpenAiAgentEngine({
			data: () => ({
				fetch: apiKey
					? (input, init) =>
							fetch(input, {
								...init,
								headers: {
									...init?.headers,
									authorization: `Bearer ${apiKey}`,
								},
							})
					: fetch,
				baseURL,
				model,
				systemPrompts: [
					'You are Epicenter Home, a local assistant that acts across the apps on this machine through their tools.',
				],
			}),
		}),
	};
}

try {
	await main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
