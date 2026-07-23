/** Whispering scalar convergence through the authenticated Data sync route. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Principal } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import {
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_SYNC_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import {
	type OpenBunEpicenterOptions,
	openBunEpicenter,
} from '@epicenter/data/runtime/bun';
import { InstantString } from '@epicenter/field';
import {
	createBunScalarV1Runtime,
	mountBunScalarV1App,
} from '@epicenter/server/bun';
import { whisperingLens } from '@epicenter/whispering/workspace-contract';
import { type Context, Hono, type Next } from 'hono';

const PRINCIPAL_ID = 'whispering-test-person';

/** The production HTTP carrier shape over the mounted route, with an offline gate. */
function createRouteCarrier(
	app: Hono,
	isOnline: () => boolean,
): NonNullable<OpenBunEpicenterOptions['carrier']> {
	return {
		async fetchFacts(request) {
			if (!isOnline()) throw new Error('Simulated offline transport');
			const url = new URL('http://localhost/api/sync/v1/facts');
			url.searchParams.set('afterSequence', String(request.afterSequence));
			if (request.authorityLifetime !== undefined) {
				url.searchParams.set('authorityLifetime', request.authorityLifetime);
			}
			const response = await app.request(url.toString());
			if (!response.ok) throw new Error(`Facts HTTP ${response.status}`);
			const parsed = parseFactsResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (parsed.error !== null) throw parsed.error;
			return parsed.data;
		},
		async submit(bytes) {
			if (!isOnline()) throw new Error('Simulated offline transport');
			const response = await app.request('/api/sync/v1/submissions', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: bytes,
			});
			if (!response.ok) throw new Error(`Submission HTTP ${response.status}`);
			const parsed = parseSubmissionResponse(
				await response.json(),
				SCALAR_SYNC_V1_LIMITS,
			);
			if (parsed.error !== null) throw parsed.error;
			return parsed.data;
		},
		async publishDocument() {
			throw new Error('Whispering publishes no record documents');
		},
		async publishBlob() {
			throw new Error('Whispering publishes no record blobs');
		},
	};
}

async function until(check: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error('condition did not converge');
}

test('offline Whispering scalar edits converge in both directions', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-whispering-sync-'));
	const runtime = createBunScalarV1Runtime({ dir: join(root, 'authority') });
	let online = false;
	const app = new Hono();
	mountBunScalarV1App(app as never, {
		runtime,
		auth: async (context: Context, next: Next) => {
			context.set('principal', Principal.assert({ id: PRINCIPAL_ID }));
			await next();
		},
		resolveDocumentPrincipal: async () => {
			throw new Error('WebSocket upgrade is outside this proof');
		},
	});
	const attachment = {
		deploymentId: 'https://example.test/',
		principalId: PRINCIPAL_ID,
	};

	try {
		await using first = await openBunEpicenter({
			directory: join(root, 'first'),
			carrier: createRouteCarrier(app, () => online),
			intervalMs: 10,
		});
		const firstRecordings = first.bind(whisperingLens).recordings;
		const recording = await firstRecordings.create({
			audioBlobId: generateBlobId(),
			uploadedAt: null,
			title: 'Offline',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Authored offline',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});

		online = true;
		await using second = await openBunEpicenter({
			directory: join(root, 'second'),
			carrier: createRouteCarrier(app, () => online),
			intervalMs: 10,
		});
		const secondRecordings = second.bind(whisperingLens).recordings;

		// The offline-authored replica is nonempty, so its first attachment
		// surfaces the choice; bringing mirrors the production silent adopt.
		const outcome = await first.attach(attachment);
		if (outcome.kind !== 'first-attachment-choice') {
			throw new Error('a nonempty replica must surface the choice');
		}
		await outcome.proceed('bring');
		expect((await second.attach(attachment)).kind).toBe('attached');

		await until(async () => {
			const { data } = await secondRecordings.record(recording.id).get();
			return data?.transcript === 'Authored offline';
		});

		const updated = await secondRecordings
			.record(recording.id)
			.update({ title: 'Edited on second device' });
		expect(updated.error).toBeNull();
		await until(async () => {
			const { data } = await firstRecordings.record(recording.id).get();
			return data?.title === 'Edited on second device';
		});
	} finally {
		await runtime.close();
		rmSync(root, { recursive: true, force: true });
	}
});
