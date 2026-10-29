/**
 * The browser host: an app's repository over a replica in this origin's
 * private storage, run by this tab's worker while the tab holds the
 * replica (`hosts/browser`). The repository handle outlives every worker
 * session: when another tab takes the replica, or the page hides and shows
 * again, it says so in its status and takes up the next session with an
 * ordered snapshot, keeping every note that did not change.
 *
 * This browser's repositories are its replicas: `listBrowserRepositories`
 * lists them from their manifests, `createBrowserRepository` makes one (with
 * a server, or none for a repository kept only here), `openBrowserRepository`
 * opens one, and `removeBrowserRepository` deletes one from this browser.
 */
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import type { App, Definitions } from '../core/lens.js';
import {
	BrowserReplicaError,
	type BrowserReplicaOptions,
	createBrowserReplica,
	listReplicas,
	type Manifest,
	openBrowserReplica,
	type ReplicaTabState,
} from '../hosts/browser/index.js';
import { browserHost } from './browser-host.js';
import { collectionsOf } from './local.js';
import { openRepository, type Repository } from './repository.js';

type Options = Omit<BrowserReplicaOptions, 'collections'>;

/** Open `app`'s repository over the replica `replica` of this origin, in this tab. */
export function openBrowserRepository<TDefs extends Definitions>({ app, replica, ...options }: { app: App<TDefs>; replica: string } & Options): Repository<TDefs> {
	const tab = openBrowserReplica({ replica, collections: collectionsOf(app), ...options });
	return openRepository({ app, host: browserHost(tab) });
}

/** Make a new replica of `repository` in this origin, and open `app`'s repository over it in this tab, with the replica's manifest. */
export async function createBrowserRepository<TDefs extends Definitions>({
	app,
	...options
}: { app: App<TDefs>; repository: string; name: string; account: string | null; url: string | null } & Options): Promise<Result<{ manifest: Manifest; repository: Repository<TDefs> }, BrowserReplicaError>> {
	const created = await createBrowserReplica({ ...options, collections: collectionsOf(app) });
	if (created.error !== null) return created;
	return Ok({ manifest: created.data.manifest, repository: openRepository({ app, host: browserHost(created.data) }) });
}

export { BrowserReplicaError, type Manifest } from '../hosts/browser/index.js';

/** This browser's repositories, from their manifests: which repository each is, its name here, the account and the server (null: kept only here). */
export const listBrowserRepositories = (): Promise<Manifest[]> => listReplicas();

/**
 * Delete the replica `replica` from this browser: its database and its
 * objects. Refused while any of its files has not reached a server (for a
 * repository kept only here, that is every file), unless `discardUnsent`;
 * refused while another tab has it open.
 */
export async function removeBrowserRepository({ replica, discardUnsent = false, ...options }: { replica: string; discardUnsent?: boolean } & Options): Promise<Result<undefined, BrowserReplicaError>> {
	const tab = openBrowserReplica({ replica, ...options });
	const settled = await new Promise<Exclude<ReplicaTabState, { status: 'opening' | 'waiting' }>>((resolve) => {
		const stop = tab.subscribe((state) => {
			if (state.status === 'opening' || state.status === 'waiting') return;
			queueMicrotask(() => stop());
			resolve(state);
		});
	});
	switch (settled.status) {
		case 'open': {
			const removed = await settled.replica.remove({ discardUnsent });
			if (removed.error !== null) tab.close();
			return removed;
		}
		case 'unavailable':
			tab.close();
			return { data: null, error: settled.error };
		default:
			tab.close();
			return BrowserReplicaError.Unavailable({ reason: 'it is open in another tab' });
	}
}
