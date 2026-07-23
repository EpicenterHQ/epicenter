/**
 * One-scenario smoke test for the runtime port. Same backend, either runtime.
 *
 * Point it at a base URL and it runs ONE end-to-end scenario against the live
 * HTTP server: read the session and exercise the
 * full opaque-id blob lifecycle (ticket -> presigned PUT -> read back).
 * Every step prints a single PASS/FAIL/SKIP line, so the same
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
 *   - For a full green blob round-trip the server must have BLOBS_S3_* set
 *     (run `docker compose up -d` in apps/api for a local versitygw store);
 *     without object storage the blob routes answer 503 and the script reports
 *     that as an expected, non-fatal outcome.
 */

import { generateBlobId } from '@epicenter/blobs';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { API_BUN_DEV_PORT } from '@epicenter/constants/apps';

const BASE_URL = (
	process.argv[2] ??
	process.env.BASE_URL ??
	`http://localhost:${API_BUN_DEV_PORT}`
).replace(/\/+$/, '');

// The dev resolver synthesizes the principal from this id. Random per run so
// repeated smokes never collide on room or blob state.
const principalId = `smoke-${randHex(4)}`;
const authHeaders: Record<string, string> = {
	authorization: `Bearer dev:${principalId}`,
};

// ── tiny step reporter ──────────────────────────────────────────────────────

type Status = 'PASS' | 'FAIL' | 'SKIP';
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

	// 3. Blob lifecycle.
	const payload = new TextEncoder().encode(
		`epicenter blob smoke ${new Date().toISOString()} ${randHex(4)}\n`,
	);
	const blobId = generateBlobId();
	const ticketRes = await fetch(API_ROUTES.blobs.collection.url(BASE_URL), {
		method: 'POST',
		headers: { ...authHeaders, 'content-type': 'application/json' },
		body: JSON.stringify({
			blobId,
			sizeBytes: payload.byteLength,
			contentType: 'text/plain',
		}),
	});

	if (ticketRes.status === 503) {
		record(
			'SKIP',
			'blob ticket',
			'503 StorageNotConfigured (no BLOBS_S3_* on this server), expected without S3',
		);
	} else if (!ticketRes.ok) {
		record(
			'FAIL',
			'blob ticket',
			`${ticketRes.status} ${await ticketRes.text()}`,
		);
	} else {
		const ticket = (await ticketRes.json()) as {
			uploadUrl: string;
			requiredHeaders: Record<string, string>;
		};
		record('PASS', 'blob ticket', `${ticketRes.status} blobId=${blobId}`);

		const putRes = await fetch(ticket.uploadUrl, {
			method: 'PUT',
			headers: ticket.requiredHeaders,
			body: payload,
		});
		record(
			putRes.ok || putRes.status === 412 ? 'PASS' : 'FAIL',
			'blob PUT (presigned)',
			`${putRes.status}`,
		);

		// Read back: 302 -> presigned GET -> compare bytes.
		const readRes = await fetch(API_ROUTES.blobs.byId.url(BASE_URL, blobId), {
			headers: authHeaders,
			redirect: 'manual',
		});
		const presigned = readRes.headers.get('location');
		if (readRes.status === 302 && presigned) {
			const objRes = await fetch(presigned);
			const got = new Uint8Array(await objRes.arrayBuffer());
			const match =
				got.byteLength === payload.byteLength &&
				got.every((byte, index) => byte === payload[index]);
			record(
				match ? 'PASS' : 'FAIL',
				'blob read back',
				`302 -> ${objRes.status}, bytes ${match ? 'match' : 'MISMATCH'}`,
			);
		} else {
			record('FAIL', 'blob read back', `expected 302, got ${readRes.status}`);
		}

		// Cleanup the uploaded object (idempotent).
		await fetch(API_ROUTES.blobs.byId.url(BASE_URL, blobId), {
			method: 'DELETE',
			headers: authHeaders,
		});
	}

	return summarize();
}

function summarize() {
	const counts = {} as Record<Status, number>;
	for (const row of rows) {
		counts[row.status] = (counts[row.status] ?? 0) + 1;
	}
	console.log(
		`\nSummary: ${counts.PASS ?? 0} pass, ${counts.FAIL ?? 0} fail, ${counts.SKIP ?? 0} skip\n`,
	);
	process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
}

await main();
