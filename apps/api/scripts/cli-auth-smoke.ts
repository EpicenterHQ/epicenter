/**
 * CLI + headless credential smoke for the self-host instance-token seam.
 *
 * The sibling `smoke.ts` drives the server over raw HTTP; this one drives the
 * actual CLI credential entry, `resolveMachineAuthClient` from
 * `@epicenter/auth/node`, against a running star. It proves the path a prebuilt
 * headless Node client takes to a self-hosted box: a static instance token resolves to a
 * settled, signed-in `SyncAuthClient` with no OAuth cell and no interactive
 * login.
 *
 * Like `smoke.ts`, it needs the server booted WITH the dev resolver so a static
 * `Bearer dev:<principalId>` resolves to a synthetic principal on localhost (the
 * productionized first-boot bearer, Wave 3, drops into this same path
 * unchanged). Boot it and point this at it:
 *
 *   cd apps/api
 *   BETTER_AUTH_SECRET=dev-only-32-chars-min-please-ignore \
 *   GOOGLE_CLIENT_ID=x GOOGLE_CLIENT_SECRET=x \
 *   DATABASE_URL=postgres://localhost/anything PORT=8788 \
 *     bun server.dev.ts            # /api/session with dev auth never queries the DB
 *
 *   bun scripts/cli-auth-smoke.ts http://localhost:8788
 *
 * Each step prints one PASS/FAIL line; a non-zero exit means a failure.
 */

import { resolveMachineAuthClient } from '@epicenter/auth/node';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { API_BUN_DEV_PORT } from '@epicenter/constants/apps';

const baseURL = (
	process.argv[2] ??
	process.env.BASE_URL ??
	`http://localhost:${API_BUN_DEV_PORT}`
).replace(/\/+$/, '');

let pass = 0;
let fail = 0;
function check(step: string, ok: boolean, detail = ''): void {
	console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${step.padEnd(40)} ${detail}`);
	if (ok) pass++;
	else fail++;
}

function randHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function main() {
	console.log(`\nCLI credential smoke against ${baseURL}\n`);

	// 1. A token passed directly resolves to a settled, signed-in instance client.
	const principalId = `cli-smoke-${randHex(4)}`;
	{
		const { data: auth, error } = await resolveMachineAuthClient({
			baseURL,
			token: `dev:${principalId}`,
		});
		if (error) {
			check('token arg: resolves Ok', false, error.message);
			return summarize();
		}
		check('token arg: resolves Ok', true);
		check(
			'token arg: settled signed-in',
			auth.state.status === 'signed-in',
			JSON.stringify(auth.state),
		);
		check(
			'token arg: principalId is the dev user',
			auth.state.status === 'signed-in' &&
				auth.state.principalId === principalId,
			auth.state.status === 'signed-in'
				? auth.state.principalId
				: '(signed-out)',
		);
		const sessionRes = await auth.fetch(API_ROUTES.session.url(baseURL));
		check('token arg: auth.fetch /api/session 200', sessionRes.status === 200);
	}

	// 2. The headless env seam: a token from EPICENTER_TOKEN, read at call time.
	{
		const envPrincipalId = `cli-smoke-env-${randHex(4)}`;
		process.env.EPICENTER_TOKEN = `dev:${envPrincipalId}`;
		const { data: auth, error } = await resolveMachineAuthClient({ baseURL });
		delete process.env.EPICENTER_TOKEN;
		check(
			'EPICENTER_TOKEN: signed-in as the env user',
			!error &&
				auth?.state.status === 'signed-in' &&
				auth.state.principalId === envPrincipalId,
			error?.message ??
				(auth?.state.status === 'signed-in' ? auth.state.principalId : ''),
		);
	}

	// 3. An unverifiable token resolves Ok but signed-out (local mounts still
	//    serve); the dev resolver rejects an empty id, so `dev:` is a 401.
	{
		const { data: auth, error } = await resolveMachineAuthClient({
			baseURL,
			token: 'dev:',
		});
		check(
			'bad token: Ok + signed-out (not an error)',
			!error && auth?.state.status === 'signed-out',
			error?.message ?? JSON.stringify(auth?.state),
		);
	}

	return summarize();
}

function summarize() {
	console.log(`\nSummary: ${pass} pass, ${fail} fail\n`);
	process.exit(fail > 0 ? 1 : 0);
}

await main();
