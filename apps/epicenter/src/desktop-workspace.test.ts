/** Desktop Data RPC integration over one Bun-owned Epicenter replica. */
import { expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { defineTable, defineValue } from '@epicenter/data';
import {
	type OpenDesktopEpicenterOptions,
	openDesktopEpicenter,
} from '@epicenter/data/desktop';
import { field, InstantString } from '@epicenter/field';
import { BOOTSTRAP_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import {
	createOwnedTestHomeHostBundle,
	createTestDesktopAuth,
} from './test-home-host.ts';

const TOKEN = 'desktop-data-test-token';
const documentsTable = defineTable({
	key: 'so.epicenter.tests.desktop-documents',
	fields: { name: field.string(), updatedAt: field.instant() },
});
// Local pre-W4 stand-ins: the desktop runtime still speaks the old Data
// surface until its own migration wave, while Whispering's real contract has
// moved to the W4 Lens.
const recordingsTable = defineTable({
	key: 'so.epicenter.tests.desktop-recordings',
	fields: { title: field.string(), transcript: field.string() },
});
const analyticsValue = defineValue({
	key: 'so.epicenter.tests.desktop-analytics',
	value: field.boolean(),
});

test('WebView surfaces share one replica and state survives restart', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-data-'));
	const operations: Record<string, unknown>[] = [];
	try {
		const firstServer = await startDesktopServer(root);
		const first = await createClient(
			firstServer.origin,
			firstServer.fetch,
			operations,
		);
		const firstData = first.bind({
			tables: {
				recordings: recordingsTable,
				documents: documentsTable,
			},
			values: {
				analytics: analyticsValue,
			},
		});
		const recording = await firstData.tables.recordings.create({
			title: 'Shared recording',
			transcript: 'Shared transcript',
		});
		expect(
			(
				await firstData.tables.recordings.update(recording.id, {
					transcript: 'Updated transcript',
				})
			).data?.transcript,
		).toBe('Updated transcript');
		await firstData.values.analytics.set(false);

		const row = await firstData.tables.documents.create({
			name: 'Shared document',
			updatedAt: InstantString.now(),
		});
		{
			await using document = await firstData.tables.documents.openDocument(
				row.id,
			);
			document.get('content').insert(0, 'Desktop document');
			await document.whenDurable();
		}

		// A second WebView binds the same qualified definitions to the same host
		// replica. There is no Device/Account or per-workspace adoption ceremony.
		const second = await createClient(firstServer.origin, firstServer.fetch);
		const secondData = second.bind({
			tables: { recordings: recordingsTable },
			values: {},
		});
		expect(
			(await secondData.tables.recordings.get(recording.id)).data?.transcript,
		).toBe('Updated transcript');
		expect(
			(await firstData.tables.recordings.get(recording.id)).data?.title,
		).toBe('Shared recording');

		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		await firstServer.dispose();
		expect(existsSync(join(root, 'data', 'epicenter.sqlite3'))).toBeTrue();

		const restarted = await startDesktopServer(root);
		try {
			const client = await createClient(restarted.origin, restarted.fetch);
			const data = client.bind({
				tables: {
					recordings: recordingsTable,
					documents: documentsTable,
				},
				values: {
					analytics: analyticsValue,
				},
			});
			expect(
				(await data.tables.recordings.get(recording.id)).data?.transcript,
			).toBe('Updated transcript');
			expect((await data.values.analytics.get()).data).toBeFalse();
			await using document = await data.tables.documents.openDocument(row.id);
			expect(document.get('content').toString()).toBe('Desktop document');
			for (const request of operations) {
				expect(request).not.toHaveProperty('lens');
				expect(request).not.toHaveProperty('workspaceId');
			}
			await client[Symbol.asyncDispose]();
		} finally {
			await restarted.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function startDesktopServer(root: string) {
	const origin = 'http://127.0.0.1:39130';
	const { host, dataOwner } = await createOwnedTestHomeHostBundle({
		dataDir: root,
		workspacesRoot: join(root, 'data'),
		model: 'test',
		engine: async function* () {},
	});
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await testAssets(root),
		dataOwner,
		blobs: createBunBlobStore({ directory: join(root, 'blobs') }),
		desktopAuth: createTestDesktopAuth(),
		blobRemote: null,
	});
	void websocket;
	const bootstrap = await app.request(`${origin}${BOOTSTRAP_ROUTE.pattern}`, {
		method: 'POST',
		headers: {
			authorization: `Bearer ${TOKEN}`,
			host: '127.0.0.1:39130',
			origin,
		},
	});
	const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('Desktop bootstrap did not set a cookie');
	return {
		origin,
		async fetch(input: Parameters<typeof fetch>[0], init?: RequestInit) {
			return await app.request(input, {
				...init,
				headers: {
					...init?.headers,
					cookie,
					host: '127.0.0.1:39130',
					origin,
				},
			});
		},
		async dispose() {
			await host[Symbol.asyncDispose]();
			await dataOwner[Symbol.asyncDispose]();
		},
	};
}

function createClient(
	origin: string,
	request: (
		input: Parameters<typeof fetch>[0],
		init?: RequestInit,
	) => Promise<Response>,
	operations?: Record<string, unknown>[],
) {
	return openDesktopEpicenter({
		baseUrl: origin,
		async fetch(input, init) {
			if (operations && typeof init?.body === 'string') {
				operations.push(JSON.parse(init.body) as Record<string, unknown>);
			}
			return request(input, init);
		},
	} satisfies OpenDesktopEpicenterOptions);
}

async function testAssets(root: string) {
	const dist = join(root, 'dist');
	mkdirSync(join(dist, 'home'), { recursive: true });
	mkdirSync(join(dist, 'whispering'), { recursive: true });
	writeFileSync(join(dist, 'home', 'index.html'), '<!doctype html><body>Home');
	writeFileSync(
		join(dist, 'whispering', 'index.html'),
		'<!doctype html><body>Whispering',
	);
	return loadStaticAssets(dist);
}
