/**
 * One-scenario smoke test for the runtime port. Same backend, either runtime.
 *
 * Point it at a base URL and it runs ONE end-to-end scenario against the live
 * HTTP server: read the session, create one universal record, publish its
 * immutable blob, read the bytes back, and tombstone the record. Every step
 * prints a single PASS/FAIL line, so the same
 * invocation against the Bun process (:8788) and the wrangler process (:8787)
 * produces a diffable transcript of runtime parity.
 *
 *   bun apps/api/scripts/smoke.ts http://localhost:8788   # Bun runtime port
 *   bun apps/api/scripts/smoke.ts http://localhost:8787   # wrangler dev
 *
 * Auth is the one thing the scenario cannot get over plain HTTP (email/password
 * is disabled and Google is interactive), so it relies on the server running
 * with the dev resolver injected: boot it via `bun run dev:bun:devauth`
 * (server.dev.ts), which resolves `Authorization: Bearer dev:<principalId>` to a
 * synthetic principal on localhost. The smoke just sends that header, so no user
 * is seeded and the script needs no database access of its own.
 *
 * Requirements to run:
 *   - BASE_URL reachable, and booted WITH the dev resolver (`dev:bun:devauth`).
 *     Against a production-auth server the authed steps return 401.
 */

import { API_ROUTES } from '@epicenter/constants/api-routes';
import { API_BUN_DEV_PORT } from '@epicenter/constants/apps';
import { BLOB_PUBLICATION_VERSION } from '@epicenter/data/blob-v1';

const BASE_URL = (
	process.argv[2] ??
	process.env.BASE_URL ??
	`http://localhost:${API_BUN_DEV_PORT}`
).replace(/\/+$/, '');

// The dev resolver synthesizes the principal from this id. Random per run so
// repeated smokes never collide on principal-scoped record state.
const principalId = `smoke-${randHex(4)}`;
const authHeaders: Record<string, string> = {
	authorization: `Bearer dev:${principalId}`,
};

// ── tiny step reporter ──────────────────────────────────────────────────────

type Status = 'PASS' | 'FAIL';
const rows: { status: Status; step: string; detail: string }[] = [];
function record(status: Status, step: string, detail: string) {
	rows.push({ status, step, detail });
	console.log(`  [${status}] ${step.padEnd(26)} ${detail}`);
}

function randHex(bytes: number): string {
	return [...crypto.getRandomValues(new Uint8Array(bytes))]
		.map((b) => b.toString(16).padStart(2, '0'))
		.join('');
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
	const input = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	const digest = await crypto.subtle.digest('SHA-256', input);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}

// ── scenario ────────────────────────────────────────────────────────────────

async function main() {
	console.log(`\nSmoke scenario against ${BASE_URL}\n`);

	// 1. Health (no auth). Also reports which runtime answered.
	try {
		const res = await fetch(`${BASE_URL}/`);
		const body = (await res.json()) as { runtime?: string };
		record(
			res.ok ? 'PASS' : 'FAIL',
			'health',
			`${res.status} runtime=${body.runtime ?? '?'}`,
		);
	} catch (err) {
		record('FAIL', 'health', `unreachable: ${(err as Error).message}`);
		return summarize();
	}

	// 2. Session: resolves the principal from the bearer.
	let resolvedPrincipalId = '';
	{
		const res = await fetch(API_ROUTES.session.url(BASE_URL), {
			headers: authHeaders,
		});
		if (res.ok) {
			resolvedPrincipalId = ((await res.json()) as { principalId: string })
				.principalId;
			record(
				'PASS',
				'session',
				`${res.status} principalId=${resolvedPrincipalId}`,
			);
		} else {
			record('FAIL', 'session', `${res.status} ${await res.text()}`);
			return summarize();
		}
	}

	// 3. The generic opaque-ID blob product is a clean break, not an alias.
	const retiredBlobsRes = await fetch(`${BASE_URL}/api/blobs`, {
		headers: authHeaders,
	});
	if (retiredBlobsRes.status !== 404) {
		record('FAIL', 'generic blob route absent', `${retiredBlobsRes.status}`);
		return summarize();
	}
	record('PASS', 'generic blob route absent', `${retiredBlobsRes.status}`);

	// 4. Bind to the principal's authority lifetime.
	const factsRes = await fetch(
		`${BASE_URL}/api/sync/v1/facts?afterSequence=0`,
		{ headers: authHeaders },
	);
	if (!factsRes.ok) {
		record(
			'FAIL',
			'read authority',
			`${factsRes.status} ${await factsRes.text()}`,
		);
		return summarize();
	}
	const { authorityLifetime } = (await factsRes.json()) as {
		authorityLifetime: string;
	};
	record('PASS', 'read authority', `${factsRes.status}`);

	// 5. Create one live record, then publish bytes to its latent blob slot.
	const address = {
		namespace: 'so.epicenter.smoke',
		collection: 'runtimeParity',
		recordKey: randHex(12),
	};
	const replicaId = randHex(12);
	const submit = (submissionNumber: number, op: 'replace' | 'tombstone') =>
		fetch(`${BASE_URL}/api/sync/v1/submissions`, {
			method: 'POST',
			headers: { ...authHeaders, 'content-type': 'application/json' },
			body: JSON.stringify({
				authorityLifetime,
				replicaId,
				submissionNumber,
				intents: [
					{
						address,
						op,
						...(op === 'replace'
							? { value: { kind: 'runtime-parity-smoke' } }
							: {}),
					},
				],
			}),
		});
	const createRes = await submit(1, 'replace');
	if (!createRes.ok) {
		record(
			'FAIL',
			'create record',
			`${createRes.status} ${await createRes.text()}`,
		);
		return summarize();
	}
	record('PASS', 'create record', `${createRes.status}`);

	const payload = new TextEncoder().encode(
		`epicenter record blob smoke ${new Date().toISOString()} ${randHex(4)}\n`,
	);
	const digest = await sha256Hex(payload);
	const recordPath = `${BASE_URL}/api/sync/v1/records/${encodeURIComponent(address.namespace)}/${encodeURIComponent(address.collection)}/${encodeURIComponent(address.recordKey)}`;
	const publishRes = await fetch(`${recordPath}/blob-publications`, {
		method: 'POST',
		headers: {
			...authHeaders,
			'content-type': 'application/octet-stream',
			'x-epicenter-authority-lifetime': authorityLifetime,
			'x-epicenter-blob-protocol': BLOB_PUBLICATION_VERSION,
			'x-epicenter-blob-digest': digest,
		},
		body: payload,
	});
	if (!publishRes.ok) {
		record(
			'FAIL',
			'publish record blob',
			`${publishRes.status} ${await publishRes.text()}`,
		);
		return summarize();
	}
	record('PASS', 'publish record blob', `${publishRes.status}`);

	const readRes = await fetch(`${recordPath}/blob`, { headers: authHeaders });
	const got = new Uint8Array(await readRes.arrayBuffer());
	const match =
		readRes.ok &&
		got.byteLength === payload.byteLength &&
		got.every((byte, index) => byte === payload[index]);
	record(
		match ? 'PASS' : 'FAIL',
		'read record blob',
		`${readRes.status}, bytes ${match ? 'match' : 'MISMATCH'}`,
	);

	// 6. The record tombstone is the blob deletion operation.
	const tombstoneRes = await submit(2, 'tombstone');
	record(
		tombstoneRes.ok ? 'PASS' : 'FAIL',
		'tombstone record',
		`${tombstoneRes.status}`,
	);
	const reapedRes = await fetch(`${recordPath}/blob`, { headers: authHeaders });
	record(
		reapedRes.status === 404 ? 'PASS' : 'FAIL',
		'blob reaped',
		`${reapedRes.status}`,
	);

	return summarize();
}

function summarize() {
	const counts = {} as Record<Status, number>;
	for (const row of rows) {
		counts[row.status] = (counts[row.status] ?? 0) + 1;
	}
	console.log(
		`\nSummary: ${counts.PASS ?? 0} pass, ${counts.FAIL ?? 0} fail\n`,
	);
	process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
}

await main();
