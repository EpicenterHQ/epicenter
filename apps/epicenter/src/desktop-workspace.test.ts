/**
 * Desktop workspace owner integration.
 *
 * One statically linked Bun owner serves WebView surfaces over the records
 * route. Exactly one surface owns a workspace at a time: a newer surface's
 * open displaces the previous owner, whose operations then fail with the
 * shared moved error. Row documents persist through the owner's SQLite
 * update log and survive a full server restart.
 */
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
import { generateBlobId } from '@epicenter/blobs';
import { createBunBlobStore } from '@epicenter/blobs/bun';
import { InstantString } from '@epicenter/field';
import { skillsWorkspace } from '@epicenter/skills';
import { whisperingWorkspace } from '@epicenter/whispering/workspace-contract';
import {
	defineWorkspace,
	isWorkspaceStorageMovedError,
} from '@epicenter/workspace/sqlite';
import {
	type CreateDesktopWorkspaceRuntimeOptions,
	createDesktopWorkspaceRuntime,
} from '@epicenter/workspace/sqlite/desktop';
import { isResult } from 'wellcrafted/result';
import { BOOTSTRAP_ROUTE } from './routes.ts';
import { createHomeServer } from './server.ts';
import { loadStaticAssets } from './static-assets.ts';
import {
	createOwnedTestHomeHostBundle,
	createTestDesktopAuth,
} from './test-home-host.ts';

const TOKEN = 'desktop-workspace-test-token';

test('one surface owns a workspace, documents persist, and state survives restart', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-owner-'));
	const createBroadcastChannel = createBroadcastChannelFactory();
	try {
		const firstServer = await startDesktopServer(root);
		const movedNotices: { workspaceId: string; cause: Error }[] = [];
		const firstClient = createClient(firstServer.origin, firstServer.cookie, {
			createBroadcastChannel,
			onBackgroundError: (cause, workspaceId) =>
				movedNotices.push({ workspaceId, cause }),
		});
		const firstSkills = await firstClient.open(skillsWorkspace);
		const firstWhispering = await firstClient.open(whisperingWorkspace);
		await Promise.all([
			firstSkills.tables.skills.list(),
			firstWhispering.tables.recordings.list(),
		]);
		for (const workspaceId of [
			'epicenter-conversations',
			'epicenter-honeycrisp',
			'epicenter-skills',
			'epicenter-whispering',
		]) {
			expect(
				existsSync(
					join(root, 'workspaces', 'device', workspaceId, 'store.sqlite3'),
				),
			).toBeTrue();
		}
		expect(existsSync(join(root, 'workspace-runtime'))).toBeFalse();
		for (const result of [
			await firstSkills.tables.skills.get('missing'),
			await firstSkills.tables.skills.update('missing', {
				description: 'Still missing',
			}),
		]) {
			expect(result).toEqual({ data: undefined, error: null });
			expect(Object.hasOwn(result, 'data')).toBeTrue();
			expect(isResult(result)).toBeTrue();
		}
		const recording = await firstWhispering.tables.recordings.create({
			audioBlobId: generateBlobId(),
			uploadedAt: null,
			title: 'Shared recording',
			recordedAt: InstantString.now(),
			recordedAtZone: 'UTC',
			transcript: 'Shared transcript',
			polishedTranscript: null,
			duration: null,
			transcription: null,
		});
		expect(
			(
				await firstWhispering.tables.recordings.update(recording.id, {
					transcript: 'Updated transcript',
				})
			).data?.transcript,
		).toBe('Updated transcript');

		expect((await firstWhispering.kv.get('analytics.enabled')).data).toBe(
			undefined,
		);
		expect(
			(await firstWhispering.kv.set('analytics.enabled', false)).error,
		).toBe(null);
		expect(
			(await firstWhispering.kv.get('analytics.enabled')).data,
		).toBeFalse();

		// Row documents persist through the owner's SQLite update log; a fresh
		// handle hydrates committed content back over the same carrier.
		const created = await firstSkills.tables.skills.create({
			sourceId: 'shared-skill',
			name: 'Shared',
			description: 'One Bun owner',
			updatedAt: InstantString.now(),
		});
		{
			using document = await firstSkills.tables.skills.document.open(
				created.id,
			);
			document.get('content').insert(0, 'Desktop document');
			await document.whenDurable();
		}
		{
			using reopened = await firstSkills.tables.skills.document.open(
				created.id,
			);
			expect(reopened.get('content').toString()).toBe('Desktop document');
		}

		// Deleting the row revokes the live handle and its durable log dies in
		// the same owner transaction: a fresh open refuses the dead address.
		const doomed = await firstSkills.tables.skills.create({
			sourceId: 'doomed-skill',
			name: 'Doomed',
			description: 'To delete',
			updatedAt: InstantString.now(),
		});
		using doomedDocument = await firstSkills.tables.skills.document.open(
			doomed.id,
		);
		doomedDocument.get('content').insert(0, 'Gone soon');
		await doomedDocument.whenDurable();
		await firstSkills.tables.skills.delete(doomed.id);
		expect(() => doomedDocument.get('content')).toThrow(/revoked/);
		await expect(
			firstSkills.tables.skills.document.open(doomed.id),
		).rejects.toThrow(/absent row/);

		const survivingSkill = await firstSkills.tables.skills.create({
			sourceId: 'surviving-skill',
			name: 'Surviving',
			description: 'One Bun owner',
			updatedAt: InstantString.now(),
		});
		{
			using survivingDocument = await firstSkills.tables.skills.document.open(
				survivingSkill.id,
			);
			survivingDocument.get('content').insert(0, 'Survives restart');
			await survivingDocument.whenDurable();
		}

		// Newest surface wins: a second window's open displaces this surface
		// for that workspace only. The displaced surface learns immediately
		// over the surface channel, rejects later operations with the shared
		// moved error, and keeps unrelated workspaces.
		const secondClient = createClient(firstServer.origin, firstServer.cookie, {
			createBroadcastChannel,
		});
		const secondSkills = await secondClient.open(skillsWorkspace);
		expect(
			(await secondSkills.tables.skills.get(survivingSkill.id)).data?.name,
		).toBe('Surviving');
		{
			using stolenDocument = await secondSkills.tables.skills.document.open(
				survivingSkill.id,
			);
			expect(stolenDocument.get('content').toString()).toBe('Survives restart');
		}
		await waitFor(() => movedNotices.length === 1);
		expect(movedNotices[0]?.workspaceId).toBe('epicenter-skills');
		expect(isWorkspaceStorageMovedError(movedNotices[0]?.cause)).toBe(true);
		const displacedFailure = await firstSkills.tables.skills
			.list()
			.then(() => undefined)
			.catch((cause: unknown) => cause);
		expect(isWorkspaceStorageMovedError(displacedFailure)).toBe(true);
		// The un-displaced workspace on the first surface keeps working.
		expect(
			(await firstWhispering.tables.recordings.get(recording.id)).data
				?.transcript,
		).toBe('Updated transcript');

		// Without the surface channel, displacement still lands through the
		// host: the stale surface's request fails with the same named error.
		const isolatedClient = createClient(
			firstServer.origin,
			firstServer.cookie,
			{ createBroadcastChannel: () => undefined },
		);
		const isolatedSkills = await isolatedClient.open(skillsWorkspace);
		await isolatedSkills.tables.skills.list();
		const reclaimingClient = createClient(
			firstServer.origin,
			firstServer.cookie,
			{ createBroadcastChannel: () => undefined },
		);
		await (await reclaimingClient.open(skillsWorkspace)).tables.skills.list();
		const hostFailure = await isolatedSkills.tables.skills
			.list()
			.then(() => undefined)
			.catch((cause: unknown) => cause);
		expect(isWorkspaceStorageMovedError(hostFailure)).toBe(true);

		await firstClient[Symbol.asyncDispose]();
		await secondClient[Symbol.asyncDispose]();
		await isolatedClient[Symbol.asyncDispose]();
		await reclaimingClient[Symbol.asyncDispose]();
		await firstServer.dispose();

		const restarted = await startDesktopServer(root);
		try {
			const client = createClient(restarted.origin, restarted.cookie, {
				createBroadcastChannel,
			});
			const skills = await client.open(skillsWorkspace);
			const whispering = await client.open(whisperingWorkspace);
			expect(
				(await skills.tables.skills.get(survivingSkill.id)).data?.name,
			).toBe('Surviving');
			expect(
				(await whispering.tables.recordings.get(recording.id)).data?.transcript,
			).toBe('Updated transcript');
			expect((await whispering.kv.get('analytics.enabled')).data).toBeFalse();
			using restartedDocument = await skills.tables.skills.document.open(
				survivingSkill.id,
			);
			expect(restartedDocument.get('content').toString()).toBe(
				'Survives restart',
			);
			const unknownDefinition = defineWorkspace({
				id: 'not-statically-linked',
				tables: skillsWorkspace.tables,
			});
			// The open handshake is honest: a workspace the host does not own
			// rejects at open, before any handle exists.
			await expect(client.open(unknownDefinition)).rejects.toThrow(
				'Unknown workspace',
			);
			const conflictingDefinition = defineWorkspace({
				id: skillsWorkspace.id,
				tables: skillsWorkspace.tables,
			});
			// A conflicting rebind is a programming error and throws directly.
			expect(() => client.open(conflictingDefinition)).toThrow(
				'already bound to another definition',
			);
			await expect(
				skills.sql("UPDATE skills SET name = 'Raw write'", [], {} as never),
			).rejects.toThrow('only SELECT');
			await client[Symbol.asyncDispose]();
		} finally {
			await restarted.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test('host generations prevent delayed open inversion and disposal rejects pending work', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-desktop-surface-races-'));
	const createBroadcastChannel = createBroadcastChannelFactory();
	try {
		const server = await startDesktopServer(root);
		try {
			const firstResponse = Promise.withResolvers<void>();
			const firstReached = Promise.withResolvers<void>();
			const first = createClient(server.origin, server.cookie, {
				createBroadcastChannel,
				async interceptResponse(operation, response) {
					if (operation.kind === 'open') {
						firstReached.resolve();
						await firstResponse.promise;
					}
					return response;
				},
			});
			const delayedFirstOpen = first.open(skillsWorkspace);
			await firstReached.promise;

			const second = createClient(server.origin, server.cookie, {
				createBroadcastChannel,
			});
			const secondSkills = await second.open(skillsWorkspace);
			const delayedFailure = await delayedFirstOpen.then(
				() => undefined,
				(cause: unknown) => cause,
			);
			expect(isWorkspaceStorageMovedError(delayedFailure)).toBeTrue();
			firstResponse.resolve();
			expect((await secondSkills.tables.skills.list()).rows).toBeArray();

			const pendingResponse = Promise.withResolvers<void>();
			const pendingReached = Promise.withResolvers<void>();
			const disposing = createClient(server.origin, server.cookie, {
				createBroadcastChannel: () => undefined,
				async interceptResponse(operation, response) {
					if (operation.kind === 'list') {
						pendingReached.resolve();
						await pendingResponse.promise;
					}
					return response;
				},
			});
			const disposingSkills = await disposing.open(skillsWorkspace);
			const pendingList = disposingSkills.tables.skills.list();
			await pendingReached.promise;
			await disposing[Symbol.asyncDispose]();
			await expect(pendingList).rejects.toThrow('disposed');
			pendingResponse.resolve();

			await first[Symbol.asyncDispose]();
			await second[Symbol.asyncDispose]();
		} finally {
			await server.dispose();
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

async function startDesktopServer(root: string) {
	const probe = Bun.serve({
		hostname: '127.0.0.1',
		port: 0,
		fetch: () => new Response(),
	});
	const port = probe.port;
	await probe.stop(true);
	if (!port) throw new Error('Port probe did not bind');
	const origin = `http://127.0.0.1:${port}`;
	const { host, workspaceOwner: owner } = await createOwnedTestHomeHostBundle({
		dataDir: join(root, 'home'),
		workspacesRoot: join(root, 'workspaces'),
		model: 'test',
		engine: async function* () {},
	});
	const { app, websocket } = createHomeServer({
		host,
		origin,
		launchToken: TOKEN,
		staticAssets: await testAssets(root),
		workspaceOwner: owner,
		blobs: createBunBlobStore({ directory: join(root, 'blobs') }),
		desktopAuth: createTestDesktopAuth(),
		blobRemote: null,
	});
	const server = Bun.serve({
		hostname: '127.0.0.1',
		port,
		fetch: app.fetch,
		websocket,
	});
	const bootstrap = await fetch(`${origin}${BOOTSTRAP_ROUTE.pattern}`, {
		method: 'POST',
		headers: { authorization: `Bearer ${TOKEN}`, origin },
	});
	const cookie = bootstrap.headers.get('set-cookie')?.split(';', 1)[0];
	if (!cookie) throw new Error('Desktop bootstrap did not set a cookie');
	return {
		origin,
		cookie,
		async dispose() {
			await server.stop(true);
			await host[Symbol.asyncDispose]();
			await owner[Symbol.asyncDispose]();
		},
	};
}

function createClient(
	origin: string,
	cookie: string,
	options: Pick<
		CreateDesktopWorkspaceRuntimeOptions,
		'createBroadcastChannel' | 'onBackgroundError'
	> & {
		interceptResponse?(
			operation: { kind: string },
			response: Response,
		): Promise<Response>;
	},
) {
	const { interceptResponse, ...runtimeOptions } = options;
	return createDesktopWorkspaceRuntime({
		baseUrl: origin,
		...runtimeOptions,
		async fetch(input, init) {
			const response = await fetch(input, {
				...init,
				headers: { ...init?.headers, cookie, origin },
			});
			if (!interceptResponse) return response;
			const body = JSON.parse(String(init?.body)) as {
				operation: { kind: string };
			};
			return interceptResponse(body.operation, response);
		},
	});
}

function createBroadcastChannelFactory() {
	type TestChannel = {
		name: string;
		onmessage: ((event: MessageEvent<unknown>) => void) | null;
		postMessage(message: unknown): void;
		close(): void;
	};
	const channels = new Set<TestChannel>();
	return (name: string): TestChannel => {
		const channel: TestChannel = {
			name,
			onmessage: null,
			postMessage(message) {
				for (const peer of channels) {
					if (peer === channel || peer.name !== name) continue;
					peer.onmessage?.({ data: structuredClone(message) } as MessageEvent);
				}
			},
			close() {
				channels.delete(channel);
			},
		};
		channels.add(channel);
		return channel;
	};
}

async function waitFor(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() > deadline) {
			throw new Error('Timed out waiting for desktop surface signal');
		}
		await Bun.sleep(10);
	}
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
