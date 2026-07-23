/**
 * One-scenario smoke for the single-partition instance (ADR-0075). Same backend,
 * either runtime (the Bun entry or the wrangler Worker).
 *
 * This needs no dev credential bypass: an instance's credential is trivially
 * supplied, so the smoke drives the REAL bearer path end to end. It proves:
 *   - the operator-supplied bearer resolves the `instance` principal
 *   - a wrong bearer is rejected (401), before any principal is resolved
 *
 * Boot the instance with a known token, then point this at it (pass the SAME token
 * the box booted with, since there is no shared registry to look it up):
 *
 *   TOKEN=$(bun run --cwd apps/self-host gen-token)
 *   INSTANCE_TOKEN=$TOKEN bun apps/self-host/server.ts &
 *   INSTANCE_TOKEN=$TOKEN bun apps/self-host/scripts/smoke.ts http://localhost:8787
 */

import { API_ROUTES } from '@epicenter/constants/api-routes';
import { INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';

const BASE_URL = (
	process.argv[2] ??
	process.env.BASE_URL ??
	'http://localhost:8787'
).replace(/\/+$/, '');

// The same token the instance booted with. The instance has no registry to look a
// token up in, so the smoke must be handed the one the box trusts.
const TOKEN = process.env.INSTANCE_TOKEN ?? '';

if (!TOKEN) {
	console.error(
		'Set INSTANCE_TOKEN to the same token the instance booted with.',
	);
	process.exit(1);
}

function bearer(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

type Status = 'PASS' | 'FAIL';
const rows: { status: Status; step: string; detail: string }[] = [];
function record(status: Status, step: string, detail: string): void {
	rows.push({ status, step, detail });
	console.log(`  [${status}] ${step.padEnd(26)} ${detail}`);
}

function summarize(): never {
	const pass = rows.filter((r) => r.status === 'PASS').length;
	const fail = rows.filter((r) => r.status === 'FAIL').length;
	console.log(`\nSummary: ${pass} pass, ${fail} fail\n`);
	process.exit(fail ? 1 : 0);
}

async function main() {
	console.log(`\nSelf-host instance smoke against ${BASE_URL}\n`);

	// 1. Health (no auth). Reports the mode + runtime that answered.
	try {
		const res = await fetch(`${BASE_URL}/`);
		const body = (await res.json()) as { product?: string; runtime?: string };
		record(
			res.ok ? 'PASS' : 'FAIL',
			'health',
			`${res.status} product=${body.product ?? '?'} runtime=${body.runtime ?? '?'}`,
		);
	} catch (err) {
		record('FAIL', 'health', `unreachable: ${(err as Error).message}`);
		return summarize();
	}

	// 2. Session with the real bearer: the resolved principal is instance,
	// independent of who holds the token.
	let principalId = '';
	{
		const res = await fetch(API_ROUTES.session.url(BASE_URL), {
			headers: bearer(TOKEN),
		});
		if (res.ok) {
			principalId = ((await res.json()) as { principalId: string }).principalId;
			record(
				principalId === INSTANCE_PRINCIPAL_ID ? 'PASS' : 'FAIL',
				'session',
				`${res.status} principalId=${principalId} (expected ${INSTANCE_PRINCIPAL_ID})`,
			);
		} else {
			record('FAIL', 'session', `${res.status} ${await res.text()}`);
			return summarize();
		}
	}

	// 3. A wrong bearer is rejected with 401, before any principal is resolved.
	{
		const res = await fetch(API_ROUTES.session.url(BASE_URL), {
			headers: bearer(`${TOKEN}-wrong`),
		});
		record(
			res.status === 401 ? 'PASS' : 'FAIL',
			'wrong token rejected',
			`${res.status} (expected 401)`,
		);
	}

	summarize();
}

main();
