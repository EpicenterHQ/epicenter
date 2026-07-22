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
import { chatLens } from '@epicenter/chat';
import { type AgentEngine, createOpenAiAgentEngine } from '@epicenter/client';
import { createDesktopRecordEpicenterOwner } from '@epicenter/data/desktop-record-owner';
import { createHttpRecordSyncSession } from '@epicenter/data/record';
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

async function main(): Promise<void> {
	const parentPipe = watchParentPipe(Bun.stdin.stream());
	let host: HomeHost | undefined;
	let recordOwner:
		| Awaited<ReturnType<typeof createDesktopRecordEpicenterOwner>>
		| undefined;
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
		recordOwner = await createDesktopRecordEpicenterOwner({
			directory: join(epicenterDataDir, 'data'),
		});
		if (auth.bootSnapshot.state.status === 'signed-in') {
			const attachment = recordOwner.epicenter.attachment;
			const deploymentId = deploymentUrl(auth.baseURL);
			const principalId = auth.bootSnapshot.state.principalId;
			if (
				attachment.kind === 'attached' &&
				(attachment.attachment.deploymentId !== deploymentId ||
					attachment.attachment.principalId !== principalId)
			) {
				throw new Error(
					'The local record replica is attached to a different deployment or principal.',
				);
			}
			const canStartSync =
				attachment.kind === 'attached' || !attachment.requiresChoice;
			if (canStartSync) {
				await recordOwner.epicenter.attachSync(
					createHttpRecordSyncSession<ReadableStream<Uint8Array>>({
						deploymentId,
						principalId,
						credentials: { get: () => 'available' },
						fetch: authorityFetch,
					}),
				);
			}
		}
		const home = recordOwner.epicenter.bind({
			chat: chatLens,
			honeycrisp: honeycrispLens,
		});
		host = await createHomeHost({
			engine,
			model,
			honeycrisp: home.honeycrisp,
			conversations: { conversations: home.chat.conversations },
		});
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
			recordOwner,
			desktopAuth: auth,
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
		const ownedData = recordOwner;
		const ownedDesktopAuth = auth;
		await superviseSidecar({
			server,
			host: {
				async [Symbol.asyncDispose]() {
					ownedDesktopAuth[Symbol.dispose]();
					await ownedHost[Symbol.asyncDispose]();
					await ownedData[Symbol.asyncDispose]();
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
			if (recordOwner) await recordOwner[Symbol.asyncDispose]();
			await parentPipe.cancel();
		}
	}
}

function deploymentUrl(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (!url.pathname.endsWith('/')) url.pathname += '/';
	return url.href;
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
