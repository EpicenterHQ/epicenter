/**
 * The Bun host: accept one versioned boot frame from Rust, bind its validated
 * loopback port, announce readiness once, and remain tied to the parent stdin
 * pipe for the lifetime of the desktop application.
 *
 * It is the hidden `__host` mode of the `epicenter` binary
 * (`epicenter-binary.ts`) until Rust serves the apps (ADR-0556).
 */

import { join } from 'node:path';
import { extractErrorMessage } from 'wellcrafted/error';
import { COMPILED_APPLICATIONS } from './applications.ts';
import {
	createDesktopAuthAuthority,
	type DesktopAuthAuthority,
} from './desktop-auth-authority.ts';
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
import {
	createInstalledApplications,
	loadStaticAssets,
} from './static-assets.ts';

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
	let desktopAuth: DesktopAuthAuthority | undefined;
	let server: ReturnType<typeof Bun.serve> | undefined;
	let lifecycleOwnsResources = false;

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
		const { app } = createHomeServer({
			origin,
			launchToken: boot.token,
			staticAssets,
			installedApplications: createInstalledApplications(
				join(boot.cacheDir, 'builds'),
			),
			desktopAuth: auth,
		});

		server = Bun.serve({
			// The Rust-owned port has already passed the mode-specific policy.
			hostname: '127.0.0.1',
			port: boot.port,
			fetch: app.fetch,
		});
		process.stdout.write(`${JSON.stringify(createReadyFrame(boot.port))}\n`);
		lifecycleOwnsResources = true;
		const ownedDesktopAuth = auth;
		await superviseSidecar({
			server,
			host: {
				async [Symbol.asyncDispose]() {
					ownedDesktopAuth[Symbol.dispose]();
				},
			},
			parentPipe,
			protocol: nativePort,
		});
	} finally {
		if (!lifecycleOwnsResources) {
			if (server) void server.stop(true);
			desktopAuth?.[Symbol.dispose]();
			await parentPipe.cancel();
		}
	}
}

/** Run the host until the parent pipe closes; a failure sets exit code 1. */
export async function runHost(): Promise<void> {
	try {
		await main();
	} catch (error) {
		// A boot failure may be a plain object a `defineErrors` factory
		// produced, so an `instanceof Error` test would print `[object Object]`
		// for exactly the failure an operator most needs spelled out.
		console.error(extractErrorMessage(error));
		process.exitCode = 1;
	}
}
