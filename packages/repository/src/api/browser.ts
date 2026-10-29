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
import {
	type BrowserReplicaError,
	type BrowserReplicaOptions,
	createBrowserReplica,
	type OpenReplica,
	openBrowserReplica,
	type ReplicaTab,
} from '../hosts/browser/index.js';
import { collectionsOf } from './local.js';
import { type Host, type HostState, openRepository, type Repository, type Session } from './repository.js';

type Options = Omit<BrowserReplicaOptions, 'collections'>;

function sessionOf(replica: OpenReplica): Session {
	return {
		snapshot: () => replica.snapshot(),
		row: (path) => replica.row(path),
		query: (sql, params) => replica.query(sql, params),
		change: (changes) => replica.change(changes),
		watch: (listener) => replica.watch(listener),
	};
}

/** A replica tab as a repository's host: one session per time the tab opens the replica. */
export function browserHost(tab: ReplicaTab): Host {
	const sessions = new WeakMap<OpenReplica, Session>();
	return {
		subscribe(onState) {
			return tab.subscribe((state) => {
				let next: HostState;
				switch (state.status) {
					case 'open': {
						let session = sessions.get(state.replica);
						if (session === undefined) {
							session = sessionOf(state.replica);
							sessions.set(state.replica, session);
						}
						next = { status: 'open', session };
						break;
					}
					case 'unavailable':
						next = { status: 'unavailable', reason: state.error.message, retry: state.retry };
						break;
					default:
						next = state;
				}
				onState(next);
			});
		},
		close: () => tab.close(),
	};
}

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
