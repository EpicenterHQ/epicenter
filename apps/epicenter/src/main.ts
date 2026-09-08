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
import type { AccountIdentity } from '@epicenter/principal';
import {
	type AgentEngine,
	createBunBlobRemote,
	createEpicenterClient,
	createOpenAiAgentEngine,
} from '@epicenter/client';
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

		const dataRoot = boot.dataDir;

		host = await createHomeHost({ engine, model });
		const blobs = (appId: string, account: AccountIdentity | null) =>
			createBunBlobStore({
				directory:
					account === null
						? join(dataRoot, 'apps', appId, 'local', 'blobs')
						: join(
								dataRoot,
								'apps',
								appId,
								'accounts',
								account.authorityId,
								account.principalId,
								'blobs',
							),
			});
		const device = createBunDevice(dataRoot);
		// The credential store is Rust's, reached over the private sidecar pipe.
		// Bun sends two labels and never a keyring address (ADR-0310).
		const appSecrets = createNativeAppSecrets(nativeAuthPort);
		// Identity is immutable per process generation, so remote availability
		// is a boot-time fact: a signed-in generation composes the streaming
		// remote over the authority's own deployment fetch, a signed-out one
		// has none until sign-in relaunches the app.
		const bootAccount = auth.account;
		const blobRemote = (appId: string, account: AccountIdentity | null) => {
			if (
				bootAccount === null ||
				account === null ||
				account.authorityId !== bootAccount.authorityId ||
				account.principalId !== bootAccount.principalId
			)
				return null;
			return createBunBlobRemote({
				store: blobs(appId, account),
				client: createEpicenterClient({
					baseURL: bootAccount.baseURL,
					fetch: bootAccount.fetch,
				}),
			});
		};

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
