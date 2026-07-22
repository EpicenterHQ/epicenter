/** Desktop record carrier integration over one Bun-owned replica. */
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
import {
	type OpenDesktopRecordEpicenterOptions,
	openDesktopRecordEpicenter,
} from '@epicenter/data/desktop-record';
import { defineLens, defineTable, defineValues } from '@epicenter/data/record';
import { field } from '@epicenter/field';
import { BOOTSTRAP_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import {
	createOwnedTestHomeHostBundle,
	createTestDesktopAuth,
} from './test-home-host.ts';

const TOKEN = 'desktop-data-test-token';
const desktopTestLens = defineLens({
	namespace: 'so.epicenter.tests.desktop',
	title: 'Desktop integration',
	description: 'Trusted WebView record carrier integration.',
	collections: {
		recordings: defineTable({
			title: 'Recordings',
			fields: { title: field.string(), transcript: field.string() },
			optional: [],
		}),
		documents: defineTable({
			title: 'Documents',
			fields: { name: field.string() },
			optional: [],
		}),
		settings: defineValues({
			title: 'Settings',
			values: { analytics: field.boolean() },
		}),
	},
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
		const firstData = first.bind({ desktop: desktopTestLens }).desktop;
		const recording = await firstData.recordings.create({
			title: 'Shared recording',
			transcript: 'Shared transcript',
		});
		expect(
			(
				await firstData.recordings.update(recording.id, {
					transcript: 'Updated transcript',
				})
			).data?.transcript,
		).toBe('Updated transcript');
		await firstData.settings.analytics.set(false);

		const row = await firstData.documents.create({
			name: 'Shared document',
		});
		{
			await using document = await firstData.documents.openDocument(row.id);
			document.get('content').insert(0, 'Desktop document');
			await document.whenDurable();
		}

		// A second WebView binds the same qualified definitions to the same host
		// replica. There is no Device/Account or per-workspace adoption ceremony.
		const second = await createClient(firstServer.origin, firstServer.fetch);
		const secondData = second.bind({ desktop: desktopTestLens }).desktop;
		expect(
			(await secondData.recordings.get(recording.id)).data?.transcript,
		).toBe('Updated transcript');
		expect((await firstData.recordings.get(recording.id)).data?.title).toBe(
			'Shared recording',
		);

		await first[Symbol.asyncDispose]();
		await second[Symbol.asyncDispose]();
		await firstServer.dispose();
		expect(existsSync(join(root, 'data', 'epicenter.sqlite3'))).toBeTrue();

		const restarted = await startDesktopServer(root);
		try {
			const client = await createClient(restarted.origin, restarted.fetch);
			const data = client.bind({ desktop: desktopTestLens }).desktop;
			expect((await data.recordings.get(recording.id)).data?.transcript).toBe(
				'Updated transcript',
			);
			expect((await data.settings.analytics.get()).data).toBeFalse();
			await using document = await data.documents.openDocument(row.id);
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
	const { host, recordOwner } = await createOwnedTestHomeHostBundle({
		dataDir: root,
		recordRoot: join(root, 'data'),
		model: 'test',
		engine: async function* () {},
	});
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await testAssets(root),
		recordOwner,
		desktopAuth: createTestDesktopAuth(),
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
			await recordOwner[Symbol.asyncDispose]();
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
	return openDesktopRecordEpicenter({
		baseUrl: origin,
		async fetch(input, init) {
			if (operations && typeof init?.body === 'string') {
				operations.push(JSON.parse(init.body) as Record<string, unknown>);
			}
			return request(input, init);
		},
	} satisfies OpenDesktopRecordEpicenterOptions);
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
