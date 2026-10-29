/**
 * A browser replica tab as a repository's host: one session each time the
 * tab opens the replica. `api/browser` opens repositories over it; a test
 * harness wraps it.
 */
import type { OpenReplica, ReplicaTab } from '../hosts/browser/index.js';
import type { Host, HostState, Session } from './repository.js';

function sessionOf(replica: OpenReplica): Session {
	return {
		snapshot: () => replica.snapshot(),
		row: (path) => replica.row(path),
		query: (sql, params) => replica.query(sql, params),
		change: (changes, token) => replica.change(changes, token),
		watch: (listener) => replica.watch(listener),
	};
}

/** A replica tab as a repository's host. */
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
		leaving: (listener) => tab.leaving(listener),
		close: () => tab.close(),
	};
}
