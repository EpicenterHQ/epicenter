/**
 * The browser host: an app's repository over a replica in this origin's
 * private storage, run by this tab's worker while the tab holds the
 * replica (`hosts/browser`). The repository handle outlives every worker
 * session: when another tab takes the replica, or the page hides and shows
 * again, it says so in its status and takes up the next session with an
 * ordered snapshot, keeping every note that did not change.
 */
import type { Result } from 'wellcrafted/result';
import { Ok } from 'wellcrafted/result';
import type { App, Definitions } from '../core/lens.js';
import { type BrowserReplicaError, type BrowserReplicaOptions, createBrowserReplica, openBrowserReplica } from '../hosts/browser/index.js';
import { browserHost } from './browser-host.js';
import { collectionsOf } from './local.js';
import { openRepository, type Repository } from './repository.js';

type Options = Omit<BrowserReplicaOptions, 'collections'>;

/** Open `app`'s repository over the replica `replica` of this origin, in this tab. */
export function openBrowserRepository<TDefs extends Definitions>({ app, replica, ...options }: { app: App<TDefs>; replica: string } & Options): Repository<TDefs> {
	const tab = openBrowserReplica({ replica, collections: collectionsOf(app), ...options });
	return openRepository({ app, host: browserHost(tab) });
}

/** Make a new replica of `repository` in this origin, and open `app`'s repository over it in this tab. */
export async function createBrowserRepository<TDefs extends Definitions>({
	app,
	...options
}: { app: App<TDefs>; repository: string; name: string; account: string | null; url: string | null } & Options): Promise<Result<{ replica: string; repository: Repository<TDefs> }, BrowserReplicaError>> {
	const created = await createBrowserReplica({ ...options, collections: collectionsOf(app) });
	if (created.error !== null) return created;
	return Ok({ replica: created.data.replica, repository: openRepository({ app, host: browserHost(created.data) }) });
}
