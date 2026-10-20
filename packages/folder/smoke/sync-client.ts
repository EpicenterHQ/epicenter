/** Exercise production storage and sync from actual pages, with one network fault. */
import { unwrap } from 'wellcrafted/result';
import { selectSource } from '../src/browser/git/publication.js';
import { emptyTree } from '../src/browser/git/snapshot.js';
import { openRepository } from '../src/browser/repository.js';
import { createSync } from '../src/browser/sync.js';
import { readCommit } from '../src/git/raw-objects.js';
import type { Row } from '../src/shared/row.js';

const schema = {
	type: 'object',
	properties: {
		a: { type: 'number' },
		b: { type: 'number' },
		extra: { type: 'number' },
	},
	required: ['a', 'b', 'extra'],
} as const;
let repository: Awaited<
	ReturnType<typeof openRepository<{ notes: typeof schema }>>
>;
let sync: ReturnType<typeof createSync>;
let draft: Row<typeof schema> | null;
let loseReply = false;
let lostReply: { status: number; bytes: number } | null = null;
let requests = 0;
const author = () => ({
	name: 'Browser sync smoke',
	email: 'browser@example.invalid',
	timestamp: Math.floor(Date.now() / 1000),
});

async function set(field: 'a' | 'b' | 'extra', value: number) {
	draft = unwrap(
		await repository.tables.notes.set('one', draft, {
			fields: { [field]: value },
		}),
	).sent;
}

async function run() {
	const result = await sync.run();
	return result.error === null
		? { ok: true as const }
		: { ok: false as const, message: result.error.message };
}

export const client = {
	async open(id: string) {
		repository = await openRepository(id, { notes: schema });
		sync = createSync(repository, {
			url: new URL('/repo.git', location.href).href,
			author,
			request: async (input, init) => {
				requests++;
				const response = await fetch(input, init);
				const url =
					typeof input === 'string' || input instanceof URL
						? String(input)
						: input.url;
				if (loseReply && new URL(url).pathname.endsWith('/git-receive-pack')) {
					loseReply = false;
					// Drain the actual response before simulating its loss. The driver
					// separately checks that native main equals the pending browser oid.
					const bytes = await response.arrayBuffer();
					lostReply = { status: response.status, bytes: bytes.byteLength };
					throw new Error(
						'Simulated lost reply after native receive-pack completed',
					);
				}
				return response;
			},
		});
		draft = unwrap(await repository.tables.notes.get('one')) ?? null;
	},
	sync: run,
	collect: () => repository.storage.collect(),
	async syncLoop(count: number) {
		for (let attempt = 0; attempt < count; attempt++) {
			const result = await run();
			if (!result.ok) throw new Error(result.message);
			await new Promise((resolve) => setTimeout(resolve, 2));
		}
	},
	async refresh() {
		draft = unwrap(await repository.tables.notes.get('one')) ?? null;
	},
	set,
	async writeFile(path: string, content: string | number[]) {
		const current = unwrap(await repository.files.read(path));
		const from =
			current === undefined
				? null
				: new Uint8Array(await current.content.arrayBuffer());
		unwrap(
			await repository.files.write(
				path,
				from,
				typeof content === 'string' ? content : new Uint8Array(content),
			),
		);
	},
	async fileBytes(path: string) {
		const current = unwrap(await repository.files.read(path));
		return current === undefined
			? null
			: Array.from(new Uint8Array(await current.content.arrayBuffer()));
	},
	async write(field: 'a' | 'b', count: number) {
		for (let value = 1; value <= count; value++) await set(field, value);
	},
	async paragraph(which: 'First' | 'Last', text: string) {
		if (draft === null) throw new Error('No draft');
		draft = unwrap(
			await repository.tables.notes.set('one', draft, {
				body: draft.body.replace(which, text),
			}),
		).sent;
	},
	loseNextPushReply() {
		loseReply = true;
	},
	async state() {
		const snapshot = await repository.storage.capture('sync');
		const head = snapshot.state.pendingCommit ?? snapshot.state.remoteBase;
		const trackedTree = head
			? readCommit(snapshot.objects.get(head)!.bytes).tree
			: emptyTree;
		const selected = await selectSource({
			workingTree: snapshot.state.workingTree,
			trackedTree,
			read: async (oid) => snapshot.objects.get(oid)!,
		});
		return {
			refs: {
				base: snapshot.state.remoteBase,
				head: snapshot.state.pendingCommit ?? snapshot.state.remoteBase ?? null,
			},
			unsent: selected.tree !== trackedTree,
			row: unwrap(await repository.tables.notes.get('one')),
			lostReply,
			requests,
		};
	},
};

declare global {
	var dataSyncSmoke: typeof client;
}
globalThis.dataSyncSmoke = client;
