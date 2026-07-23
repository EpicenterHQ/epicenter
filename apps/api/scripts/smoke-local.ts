/**
 * Shared local/CI runtime-parity smoke. No Infisical, no secrets, no required
 * services.
 *
 * This is the shared orchestration for agent-runnable local checks and the
 * `Runtime parity` CI gate (`.github/workflows/ci.runtime-parity.yml`): it boots
 * the Bun runtime with the dev resolver injected (`server.dev.ts`) on a
 * throwaway port, waits for health, runs the one-scenario smoke (`smoke.ts`)
 * against it, then tears the server down and propagates the smoke's exit code.
 *
 *   bun run smoke:local                  # from the repo root
 *   bun run --cwd apps/api smoke:local   # explicit package form
 *   (cd apps/api && bun run smoke:local) # from apps/api
 *
 * Why it needs nothing:
 *   - The auth env vars below are throwaway, low-entropy, and deliberately fake.
 *     Boot validates them as strings; the dev path never exercises them.
 *   - The server log and data directory live under a throwaway temp dir, removed
 *     on exit.
 *   - Scenario coverage and auth header shape belong to `smoke.ts`.
 *
 * Scope mirror: like the CI gate, this proves LOGIC parity (the same Hono app
 * over injected runtime hooks), NOT transport parity. `Bun.serve` vs workerd and
 * the WebSocket upgrade path only differ under `wrangler dev`, which needs real
 * Infisical secrets and stays a manual / staging step.
 */

import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const scriptDir = import.meta.dir;
const serverEntry = resolve(scriptDir, '../server.dev.ts');
const smokeEntry = resolve(scriptDir, 'smoke.ts');
const smokePort = 20_000 + Math.floor(Math.random() * 40_000);
const baseUrl = `http://localhost:${smokePort}`;

// Dev-safe throwaway env, only filled where the caller left a hole. Setting via
// `??=` lets a caller who has a real local Postgres override the default.
process.env.PORT = String(smokePort);
process.env.API_PUBLIC_ORIGIN = baseUrl;
process.env.DATABASE_URL ??=
	'postgres://postgres:postgres@localhost:5432/epicenter';
process.env.BETTER_AUTH_SECRET ??= 'smoke-local-not-a-real-secret';
process.env.GOOGLE_CLIENT_ID ??= 'smoke-local-not-a-real-client-id';
process.env.GOOGLE_CLIENT_SECRET ??= 'smoke-local-not-a-real-client-secret';
process.env.GITHUB_CLIENT_ID ??= 'smoke-local-not-a-real-github-client-id';
process.env.GITHUB_CLIENT_SECRET ??= 'smoke-local-not-a-real-github-secret';
process.env.MICROSOFT_CLIENT_ID ??= 'smoke-local-not-a-real-ms-client-id';
process.env.MICROSOFT_CLIENT_SECRET ??= 'smoke-local-not-a-real-ms-secret';
process.env.APPLE_CLIENT_ID ??= 'smoke-local-not-a-real-apple-client-id';
process.env.APPLE_TEAM_ID ??= 'smoke-local-not-a-real-apple-team-id';
process.env.APPLE_KEY_ID ??= 'smoke-local-not-a-real-apple-key-id';
process.env.APPLE_PRIVATE_KEY ??= await generateSmokeApplePrivateKey();

async function generateSmokeApplePrivateKey(): Promise<string> {
	const keyPair = await crypto.subtle.generateKey(
		{ name: 'ECDSA', namedCurve: 'P-256' },
		true,
		['sign', 'verify'],
	);
	const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
	const body = Buffer.from(pkcs8)
		.toString('base64')
		.match(/.{1,64}/g)
		?.join('\n');
	return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----`;
}

const dataRoot = mkdtempSync(join(tmpdir(), 'epicenter-smoke-'));
process.env.DATA_DIR = dataRoot;
const serverLog = join(dataRoot, 'server.log');

async function waitForHealth(
	server: ReturnType<typeof Bun.spawn>,
	timeoutMs: number,
): Promise<'ready' | 'exited' | 'timeout'> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const result = await Promise.race([
			fetch(baseUrl, { signal: AbortSignal.timeout(1_000) })
				.then((res) => (res.ok ? 'ready' : 'retry'))
				.catch(() => 'retry'),
			server.exited.then(() => 'exited'),
		]);
		if (result === 'ready' || result === 'exited') return result;
		await Bun.sleep(250);
	}
	return 'timeout';
}

let server: ReturnType<typeof Bun.spawn> | undefined;
let logFd: number | undefined;

function startServer() {
	logFd = openSync(serverLog, 'w');
	server = Bun.spawn(['bun', serverEntry], {
		// Capture the server's own logs so a boot failure is diagnosable, but keep
		// them out of the smoke transcript unless something actually breaks.
		stdout: logFd,
		stderr: logFd,
		env: process.env,
	});
	return server;
}

function dumpServerLog() {
	try {
		const log = readFileSync(serverLog, 'utf8').trim();
		if (log) {
			console.error('\n----- Bun server log -----');
			console.error(log);
		}
	} catch {
		// No log to show.
	}
}

async function cleanup() {
	if (server) {
		server.kill();
		await server.exited;
	}
	if (logFd !== undefined) closeSync(logFd);
	rmSync(dataRoot, { recursive: true, force: true });
}

let exitCode = 0;
try {
	console.log(
		`\nBooting apps/api Bun runtime port (dev auth) on ${baseUrl} ...`,
	);
	const health = await waitForHealth(startServer(), 30_000);
	if (health === 'exited') {
		console.error('::error:: Bun server exited before becoming healthy');
		dumpServerLog();
		exitCode = 1;
	} else if (health === 'timeout') {
		console.error('::error:: Bun server did not become healthy within 30s');
		dumpServerLog();
		exitCode = 1;
	} else {
		const smoke = Bun.spawn(['bun', smokeEntry, baseUrl], {
			stdout: 'inherit',
			stderr: 'inherit',
			env: process.env,
		});
		exitCode = await smoke.exited;
		if (exitCode !== 0) {
			console.error(`::error:: Runtime-parity smoke failed (exit ${exitCode})`);
			dumpServerLog();
		}
	}
} finally {
	await cleanup();
}

process.exit(exitCode);
