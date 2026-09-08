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
import { epicenterDataRoot } from '@epicenter/constants/app-data';
import { extractErrorMessage } from 'wellcrafted/error';
import { createNativeAppSecrets } from './app-secrets.ts';
import { COMPILED_APPLICATIONS } from './applications.ts';
import {
	createDesktopAuthAuthority,
	type DesktopAuthAuthority,
} from './desktop-auth-authority.ts';
import { createBunDevice } from './device.ts';
import { createHomeHost, type HomeHost } from './host.ts';
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

async function main(): Promise<void> {
	const parentPipe = watchParentPipe(Bun.stdin.stream());
	let host: HomeHost | undefined;
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

		// The one Epicenter root, resolved here rather than received. A desktop
		// host and a CLI that each computed this path would have to agree on it
		// exactly, so one TypeScript function owns it and everything else calls
		// that (ADR-0201). `blobs` below it is the host's own
		// names, and everything under `apps/` is somebody else's.
		//
		// There is no `data/` any more. The host used to open a store there, sync
		// it, render it to markdown, project it to SQLite and serve it raw; every
		// one of those read application data the host had no business holding
		// (ADR-0226), and the applications on the store each own their own now
		// (ADR-0227).
		const dataRoot = epicenterDataRoot();

		host = await createHomeHost({ engine, model });
		const blobs = createBunBlobStore({
			directory: join(dataRoot, 'blobs'),
		});
		const device = createBunDevice(dataRoot);
		// The credential store is Rust's, reached over the private sidecar pipe.
		// Bun sends two labels and never a keyring address (ADR-0310).
		const appSecrets = createNativeAppSecrets(nativeAuthPort);
		// Identity is immutable per process generation, so remote availability
		// is a boot-time fact: a signed-in generation composes the streaming
		// remote over the authority's own deployment fetch, a signed-out one
		// has none until sign-in relaunches the app.
		const blobRemote =
			auth.account !== null
				? createBunBlobRemote({
						store: blobs,
						client: createEpicenterClient({
							baseURL: auth.baseURL,
							fetch: auth.account.fetch,
						}),
					})
				: null;

		const appsDist = process.env.EPICENTER_APPS_DIST;
		if (!appsDist) {
			throw new Error(
				'EPICENTER_APPS_DIST must name the release-built Epicenter applications directory.',
			);
		}
		const staticAssets = await loadStaticAssets(
			appsDist,
			COMPILED_APPLICATIONS,
		);
		const origin = `http://127.0.0.1:${boot.port}`;
		const { app, websocket } = createHomeServer({
			host,
			origin,
			launchToken: boot.token,
			staticAssets,
			blobs,
			desktopAuth: auth,
			blobRemote,
			device,
			appSecrets,
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
		const ownedDesktopAuth = auth;
		await superviseSidecar({
			server,
			host: {
				async [Symbol.asyncDispose]() {
					ownedDesktopAuth[Symbol.dispose]();
					await ownedHost[Symbol.asyncDispose]();
				},
			},
			parentPipe,
			protocol: nativeAuthPort,
		});
	} finally {
		if (!lifecycleOwnsResources) {
			if (server) void server.stop(true);
			desktopAuth?.[Symbol.dispose]();
			if (host) await host[Symbol.asyncDispose]();
			await parentPipe.cancel();
		}
	}
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
	// Opening the store is part of boot, and it reports its refusals by throwing
	// what a `defineErrors` factory produced. Those are plain objects, so an
	// `instanceof Error` test would print `[object Object]` for exactly the
	// failure an operator most needs spelled out.
	console.error(extractErrorMessage(error));
	process.exitCode = 1;
}
