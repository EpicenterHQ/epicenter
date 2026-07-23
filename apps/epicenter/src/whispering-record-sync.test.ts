/** Whispering scalar convergence through the authenticated record sync routes. */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Principal } from '@epicenter/auth';
import { openBunRecordEpicenter } from '@epicenter/data/bun';
import { createHttpRecordSyncSession } from '@epicenter/data/record';
import { InstantString } from '@epicenter/field';
import {
	createBunScalarV1Runtime,
	mountBunScalarV1App,
} from '@epicenter/server/bun';
import { whisperingLens } from '@epicenter/whispering/lens';
import { type Context, Hono, type Next } from 'hono';
import { Ok } from 'wellcrafted/result';

const PRINCIPAL_ID = 'whispering-test-person';

test('offline Whispering scalar edits converge in both directions', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-whispering-sync-'));
	const authority = createBunScalarV1Runtime({
		dir: join(root, 'authority'),
	});
	let online = false;
	const app = new Hono();
	mountBunScalarV1App(app as never, {
		runtime: authority,
		auth: async (context: Context, next: Next) => {
			context.set('principal', Principal.assert({ id: PRINCIPAL_ID }));
			await next();
		},
		resolveDocumentPrincipal: async () =>
			Ok({
				principal: Principal.assert({ id: PRINCIPAL_ID }),
				authorizationExpiresAt: Date.now() + 60_000,
			}),
	});
	const authorityFetch = async (request: Request) => {
		if (!online) throw new Error('Simulated offline transport');
		return app.request(request);
	};
	const syncSession = (firstAttachmentChoice?: 'bring') =>
		createHttpRecordSyncSession<ReadableStream<Uint8Array>>({
			deploymentId: 'https://example.test/',
			principalId: PRINCIPAL_ID,
			credentials: { get: () => 'available' },
			...(firstAttachmentChoice === undefined ? {} : { firstAttachmentChoice }),
			fetch: authorityFetch,
		});

	try {
		await using first = await openBunRecordEpicenter({
			directory: join(root, 'first'),
		});
		const firstRecordings = first.bind({ whispering: whisperingLens })
			.whispering.recordings;
		const recording = await firstRecordings.create({
			title: 'Offline',
			audioMediaType: 'audio/wav',
			audioFileName: 'offline.wav',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Authored offline',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});

		online = true;
		await using second = await openBunRecordEpicenter({
			directory: join(root, 'second'),
		});
		const secondRecordings = second.bind({ whispering: whisperingLens })
			.whispering.recordings;
		await first.attachSync(syncSession('bring'));
		await second.attachSync(syncSession());
		expect((await secondRecordings.get(recording.id)).data?.transcript).toBe(
			'Authored offline',
		);

		await secondRecordings.update(recording.id, {
			title: 'Edited on second device',
		});
		await second.attachSync(syncSession());
		await first.attachSync(syncSession());
		expect((await firstRecordings.get(recording.id)).data?.title).toBe(
			'Edited on second device',
		);
	} finally {
		await authority.close();
		rmSync(root, { recursive: true, force: true });
	}
});
