/**
 * EVIDENCE: a second browsing context on the same folder.
 *
 * The acceptance page loads this in a same-origin iframe: its own realm, its
 * own module instances, and its own Web Locks client, sharing the origin's
 * OPFS, locks, and hint channel as another tab would. It does what the page
 * asks and replies with what the production folder returned.
 */
import { defineFolder, type Folder, openFolder } from '../../src/browser.js';

export type PeerRequest =
	| { readonly kind: 'open'; readonly id: string }
	| { readonly kind: 'create'; readonly path: string; readonly content: string }
	/** Save over the version `sha256` names, whose text is `base`, without merging. */
	| {
			readonly kind: 'save';
			readonly path: string;
			readonly sha256: string;
			readonly base: string;
			readonly content: string;
	  }
	/** Read `path` repeatedly for `ms` and report every SHA-256 seen. */
	| { readonly kind: 'readFor'; readonly path: string; readonly ms: number }
	| { readonly kind: 'hints' }
	| { readonly kind: 'close' };

export type PeerReply = {
	readonly ok: boolean;
	readonly error?: string;
	readonly sha256?: string;
	readonly seen?: readonly string[];
	readonly hints?: readonly string[];
	readonly failures?: number;
};

const definition = defineFolder({ tables: {} });
let folder: Folder<typeof definition> | undefined;
const hints: string[] = [];

async function handle(request: PeerRequest): Promise<PeerReply> {
	if (request.kind === 'open') {
		const { data: opened, error: openError } = await openFolder({
			id: request.id,
			definition,
			browser: {},
		});
		if (openError !== null) return { ok: false, error: openError.message };
		folder = opened;
		folder.onFilesChanged((paths) => hints.push(...paths));
		return { ok: true };
	}
	if (folder === undefined) return { ok: false, error: 'not open' };
	switch (request.kind) {
		case 'create': {
			const { data: saved, error: saveError } = await folder.files.create(
				request.path,
				request.content,
			);
			return saveError !== null
				? { ok: false, error: saveError.name }
				: { ok: true, sha256: saved.sha256 };
		}
		case 'save': {
			const { data: saved, error: saveError } = await folder.files.save(
				{ path: request.path, sha256: request.sha256, text: request.base },
				request.content,
				{ merge: false },
			);
			return saveError !== null
				? { ok: false, error: saveError.name }
				: { ok: true, sha256: saved.stored.sha256 };
		}
		case 'readFor': {
			const seen = new Set<string>();
			let failures = 0;
			const end = performance.now() + request.ms;
			while (performance.now() < end) {
				const { data: file, error: readError } = await folder.files.read(
					request.path,
				);
				if (readError !== null) failures++;
				else seen.add(file.sha256);
			}
			return { ok: true, seen: [...seen], failures };
		}
		case 'hints':
			return { ok: true, hints: [...hints] };
		case 'close':
			await folder.close();
			folder = undefined;
			return { ok: true };
	}
}

addEventListener('message', (event: MessageEvent) => {
	if (event.origin !== location.origin) return;
	const { id, request } = event.data as { id: number; request: PeerRequest };
	void handle(request).then(
		(reply) => parent.postMessage({ id, reply }, location.origin),
		(cause) =>
			parent.postMessage(
				{ id, reply: { ok: false, error: String(cause) } },
				location.origin,
			),
	);
});
parent.postMessage({ ready: true }, location.origin);
