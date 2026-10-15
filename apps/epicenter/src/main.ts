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
import { createHomeServer } from './server.ts';
import {
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

// 1.3.1 and 1.3.3 report false stdin EOF, leaving a live sidecar without
// its HTTP listener.
const MINIMUM_BUN_VERSION = '1.3.14';

async function main(): Promise<void> {
	if (Bun.semver.order(Bun.version, MINIMUM_BUN_VERSION) < 0) {
		throw new Error(
			`Epicenter requires Bun ${MINIMUM_BUN_VERSION} or newer; found ${Bun.version}. Upgrade Bun and restart development, or rebuild the packaged Epicenter application.`,
		);
	}
	const parentPipe = watchParentPipe(Bun.stdin.stream());
	let server: ReturnType<typeof Bun.serve> | undefined;
	let lifecycleOwnsResources = false;

	try {
		const runtimeMode = parseRuntimeMode(Bun.argv);
		const boot = parseBootFrame(await parentPipe.bootLine, runtimeMode);

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
		});

		server = Bun.serve({
			// The Rust-owned port has already passed the mode-specific policy.
			hostname: '127.0.0.1',
			port: boot.port,
			fetch: app.fetch,
		});
		process.stdout.write(`${JSON.stringify(createReadyFrame(boot.port))}\n`);
		lifecycleOwnsResources = true;
		await superviseSidecar({
			server,
			// The host owns nothing beyond its server; the account is the CLI's.
			host: { async [Symbol.asyncDispose]() {} },
			parentPipe,
		});
	} finally {
		if (!lifecycleOwnsResources) {
			if (server) void server.stop(true);
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
