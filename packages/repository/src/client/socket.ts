/**
 * The replica's transport: one WebSocket to its repository server, which
 * carries the replica's commits and catch-ups up and their answers and
 * every change event down, in one ordered sequence. A device uses HTTP only
 * for texts by hash, which are immutable and cached for good.
 *
 * A transport drives a replica through its transport side (`ReplicaEnd`):
 * `hello` with the first exchange, `attach` while requests can go, `reply`
 * and `notify` as messages arrive, and `streamOpened` where events travel
 * apart from replies. The socket is the one implementation; the property
 * test's worlds drive the same side on virtual time.
 */
import type { Logger } from 'wellcrafted/logger';
import { type WireClient, WireClientError } from '../wire/client.js';
import type { Replica } from './replica.js';

/** What a transport drives: a replica's side of the protocol. */
export type ReplicaEnd = Pick<Replica, 'hello' | 'attach' | 'reply' | 'notify' | 'streamOpened'>;

/**
 * Connect a replica to its repository server over `client`'s socket, in
 * real time. While the socket is down the replica is offline, and the
 * socket reopens after `retry` ms. Each socket's hello is checked against
 * the replica's binding: a socket that reached another repository, server
 * or account is closed and not reopened.
 */
export function connectSocket(replica: ReplicaEnd, client: WireClient, { retry = 1_000, log }: { retry?: number; log?: Logger } = {}) {
	let stopped = false;
	let socket: ReturnType<WireClient['socket']> | null = null;
	function open() {
		const current = client.socket({
			message(message) {
				switch (message.type) {
					case 'head': {
						const { error } = replica.hello({ server: message.server, repository: message.repository, account: message.account, user: message.user, main: message.main, limits: message.limits });
						if (error !== null) {
							log?.error(error);
							stopped = true;
							return current.close();
						}
						return replica.attach((request) => {
							if (request.type !== 'fetch') return current.send(request);
							void client.send(request).then(({ data: reply, error }) => {
								if (stopped) return;
								// No reply: the replica's own timeout sends the request again.
								if (error !== null) return log?.warn(error);
								replica.reply(reply);
							});
						});
					}
					case 'commit': {
						const { type: _, ...event } = message;
						return replica.notify(event);
					}
					case 'answer':
						return replica.reply({ type: 'answer', rid: message.rid, answer: message.answer });
					case 'caught-up':
						return replica.reply(message);
					case 'error':
						return log?.warn(WireClientError.Unexpected({ status: message.status, body: message.error }));
					default:
						return message satisfies never;
				}
			},
			closed() {
				replica.attach(null);
				if (!stopped) setTimeout(open, retry);
			},
		});
		socket = current;
	}
	open();
	return {
		/** Stop: close the socket and take the replica offline. */
		close() {
			stopped = true;
			socket?.close();
			replica.attach(null);
		},
	};
}
