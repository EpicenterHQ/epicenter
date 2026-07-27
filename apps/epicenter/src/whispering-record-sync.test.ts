/** Whispering scalar convergence through the authenticated Data sync route. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Principal } from '@epicenter/auth';
import { generateBlobId } from '@epicenter/blobs';
import { createHttpScalarTransport } from '@epicenter/data';
import { openBunEpicenter } from '@epicenter/data/bun';
import { InstantString } from '@epicenter/field';
import {
	createBunEpicenterSyncRuntime,
	mountBunEpicenterSyncApp,
} from '@epicenter/server/bun';
import { whisperingLens } from '@epicenter/whispering/workspace-contract';
import { type Context, Hono, type Next } from 'hono';

const PRINCIPAL_ID = 'whispering-test-person';

test('offline Whispering scalar edits converge in both directions', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-whispering-sync-'));
	const authority = createBunEpicenterSyncRuntime({
		dir: join(root, 'authority'),
	});
	let online = false;
	const app = new Hono();
	mountBunEpicenterSyncApp(app as never, {
		runtime: authority,
		auth: async (context: Context, next: Next) => {
			context.set('principal', Principal.assert({ id: PRINCIPAL_ID }));
			await next();
		},
	});
	// The production carrier over the real mounted routes, with an offline
	// switch in the fetch so the test can prove local-first behaviour survives
	// a transport that is simply unreachable.
	const transport = createHttpScalarTransport({
		baseUrl: 'https://example.test/',
		fetch: async (url, init) => {
			if (!online) throw new Error('Simulated offline transport');
			return app.request(url, init);
		},
	});
	const attachment = {
		deploymentId: 'https://example.test/',
		principalId: PRINCIPAL_ID,
		transport,
	};

	try {
		await using first = await openBunEpicenter({
			directory: join(root, 'first'),
		});
		const firstRecordings = first.bind(whisperingLens).tables.recordings;
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
		});
		const secondRecordings = second.bind(whisperingLens).tables.recordings;
		expect((await first.attachSync(attachment)).error).toBeNull();
		expect((await second.attachSync(attachment)).error).toBeNull();
		expect((await secondRecordings.get(recording.id)).data?.transcript).toBe(
			'Authored offline',
		);

		await secondRecordings.update(recording.id, {
			title: 'Edited on second device',
		});
		expect((await second.attachSync(attachment)).error).toBeNull();
		expect((await first.attachSync(attachment)).error).toBeNull();
		expect((await firstRecordings.get(recording.id)).data?.title).toBe(
			'Edited on second device',
		);
	} finally {
		authority.close();
		rmSync(root, { recursive: true, force: true });
	}
});
