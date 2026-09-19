import { type AiCatalog, createAiCatalog } from './ai-catalog.ts';
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
import { type BunBlobStore, createBunBlobStore } from '@epicenter/blobs/bun';
import { type AgentEngine, createOpenAiAgentEngine } from '@epicenter/client';
import OpenAI from 'openai';
import { extractErrorMessage } from 'wellcrafted/error';
import { discoverInstalledApplications } from './app-installation.ts';
import { createNativeAppSecrets } from './app-secrets.ts';
import {
	COMPILED_APPLICATIONS,
	RESERVED_APPLICATION_IDS,
} from './applications.ts';
import {
	createDesktopAuthAuthority,
	type DesktopAuthAuthority,
} from './desktop-auth-authority.ts';
import { createNativeDevice } from './device.ts';
import { createHomeHost, type HomeHost } from './host.ts';
import { SIGN_IN_CALLBACK_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import {
	createNativePort,
	createReadyFrame,
	parseBootFrame,
	parseRuntimeMode,
	superviseSidecar,
	watchParentPipe,
} from './sidecar-runtime.ts';
import { loadStaticAssets } from './static-assets.ts';

// 1.3.1 and 1.3.3 report false stdin EOF during native sign-in, leaving
// a live sidecar without its HTTP listener. 1.3.14 passes the native flow.
const MINIMUM_BUN_VERSION = '1.3.14';

async function main(): Promise<void> {
	if (Bun.semver.order(Bun.version, MINIMUM_BUN_VERSION) < 0) {
		throw new Error(
			`Epicenter requires Bun ${MINIMUM_BUN_VERSION} or newer; found ${Bun.version}. Upgrade Bun and restart development, or rebuild the packaged Epicenter application.`,
		);
	}
	const parentPipe = watchParentPipe(Bun.stdin.stream());
	let host: HomeHost | undefined;
	let desktopAuth: DesktopAuthAuthority | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;
	let lifecycleOwnsResources = false;
	let aiCatalog: AiCatalog | undefined;
	let noAccountAiCatalog: AiCatalog | undefined;

	try {
		const runtimeMode = parseRuntimeMode(Bun.argv);
		const boot = parseBootFrame(await parentPipe.bootLine, runtimeMode);
		const nativePort = createNativePort({ parentPipe });
		const auth = createDesktopAuthAuthority({
			authCell: boot.authCell,
			server: boot.authServer,
			accountManagement: boot.accountManagement,
			nativeAuthPort: nativePort,
			callbackUrl:
				runtimeMode === 'development'
					? SIGN_IN_CALLBACK_ROUTE.url(`http://127.0.0.1:${boot.port}`)
					: undefined,
		});
		desktopAuth = auth;

		const { engine, model } = homeEngineFromEnvironment(process.env);

		const dataRoot = boot.dataDir;

		host = await createHomeHost({ engine, model });
		// Publication receipts and in-flight writes belong to the app for this
		// host lifetime, including retries arriving in later HTTP requests.
		const blobStores = new Map<string, BunBlobStore>();
		const blobs = (appId: string, owner = 'no-account') => {
			const key = JSON.stringify([appId, owner]);
			let store = blobStores.get(key);
			if (!store) {
				store = createBunBlobStore({
					directory: join(dataRoot, 'apps', appId, 'device', owner, 'blobs'),
				});
				blobStores.set(key, store);
			}
			return store;
		};
		const device = createNativeDevice(nativePort);
		// The credential store is Rust's, reached over the private sidecar pipe.
		// Bun sends two labels and never a keyring address (ADR-0310).
		const appSecrets = createNativeAppSecrets(nativePort);
		aiCatalog = await createAiCatalog({
			dataRoot,
			secrets: appSecrets,
			account: auth.account ?? undefined,
		});
		noAccountAiCatalog = auth.account
			? await createAiCatalog({ dataRoot, secrets: appSecrets })
			: aiCatalog;

		const appsDist = process.env.EPICENTER_APPS_DIST;
		if (!appsDist) {
			throw new Error(
				'EPICENTER_APPS_DIST must name the release-built Epicenter applications directory.',
			);
		}
		const staticAssets = await loadStaticAssets(
			appsDist,
			COMPILED_APPLICATIONS,
			await discoverInstalledApplications({
				dataRoot,
				reservedIds: RESERVED_APPLICATION_IDS,
			}),
		);
		const origin = `http://127.0.0.1:${boot.port}`;
		const { app, websocket } = createHomeServer({
			folderRoot: boot.folderDir,
			host,
			origin,
			launchToken: boot.token,
			staticAssets,
			blobs,
			desktopAuth: auth,
			device,
			appSecrets,
			aiCatalog,
			noAccountAiCatalog,
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
					await Promise.all([
						aiCatalog!.close(),
						noAccountAiCatalog!.close(),
						ownedHost[Symbol.asyncDispose](),
					]);
				},
			},
			parentPipe,
			protocol: nativePort,
		});
	} finally {
		if (!lifecycleOwnsResources) {
			if (server) void server.stop(true);
			desktopAuth?.[Symbol.dispose]();
			await Promise.all([
				aiCatalog?.close(),
				noAccountAiCatalog?.close(),
				host?.[Symbol.asyncDispose](),
			]);
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

	const client = new OpenAI({
		baseURL,
		apiKey: apiKey || 'unauthenticated',
		defaultHeaders: apiKey ? undefined : { Authorization: null },
		maxRetries: 0,
	});

	return {
		model,
		engine: createOpenAiAgentEngine({
			data: () => ({
				client,
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
