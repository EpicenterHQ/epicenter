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
	type Syncing,
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
}: { app: App<TDefs>; owner: string | null; repository: string; name: string } & Syncing & Options): Promise<Result<{ manifest: Manifest; repository: Repository<TDefs> }, BrowserReplicaError>> {
	const created = await createBrowserReplica({ ...options, collections: collectionsOf(app) });
	if (created.error !== null) return created;
	return Ok({ manifest: created.data.manifest, repository: openRepository({ app, host: browserHost(created.data) }) });
}

export { BrowserReplicaError, type Manifest, type Persistence, storagePersistence, type Syncing } from '../hosts/browser/index.js';

/** This browser's repositories, from their manifests: which repository each is and whose (null: yours), its name here, the account and the server (null: kept only here). */
export const listBrowserRepositories = (): Promise<Manifest[]> => listReplicas();

/** How long a removal waits for the replica to open in this tab before it gives up, having changed nothing. */
const REMOVE_WAIT = 10_000;

/**
 * Delete the replica `replica` from this browser: its database and its
 * objects. Refused while any of its files has not reached a server (for a
 * repository kept only here, that is every file), unless `discardUnsent`;
 * refused while another tab has it open (this tab takes it only if no tab
 * holds it), or when it does not open here within `REMOVE_WAIT`. The tab it
 * opens is closed however the removal ends.
 */
export async function removeBrowserRepository({ replica, discardUnsent = false, ...options }: { replica: string; discardUnsent?: boolean } & Options): Promise<Result<undefined, BrowserReplicaError>> {
	const tab = openBrowserReplica({ replica, ...options });
	let stop = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const settled = await new Promise<Exclude<ReplicaTabState, { status: 'opening' | 'waiting' }> | null>((resolve) => {
			timer = setTimeout(() => resolve(null), REMOVE_WAIT);
			stop = tab.subscribe((state) => {
				if (state.status !== 'opening' && state.status !== 'waiting') resolve(state);
			});
		});
		if (settled === null) return BrowserReplicaError.Unavailable({ reason: 'it did not open in time' });
		switch (settled.status) {
			case 'open':
				return await settled.replica.remove({ discardUnsent });
			case 'unavailable':
				return { data: null, error: settled.error };
			default:
				return BrowserReplicaError.Unavailable({ reason: 'it is open in another tab' });
		}
	} finally {
		clearTimeout(timer);
		stop();
		tab.close();
	}
}
