/**
 * An in-process transport: a device talks to a `RepositoryServer` in the same
 * process. Each device gets its own transport so tests can take one device
 * offline; broadcasts are delivered synchronously, in server order.
 */
import { Ok } from 'wellcrafted/result';
import { type Transport, TransportError } from '../engine/ports.js';
import type { OnOverlap } from '../policy.js';
import type { RepositoryServer } from '../server/server.js';

export function createInProcessTransport(
	server: RepositoryServer,
	{ user, onOverlap = 'mark' }: { user: string; onOverlap?: OnOverlap },
) {
	let online = true;
	let dropReplies = 0;
	const reconnects = new Set<() => void>();
	const transport: Transport = {
		connect({ device, onBroadcast, onOnline }) {
			const connection = server.connect({
				device,
				user,
				onOverlap,
				onBroadcast: (broadcast) => {
					if (online) onBroadcast(broadcast);
				},
			});
			reconnects.add(onOnline);
			return {
				async hello(seq) {
					if (!online) return TransportError.Offline();
					return Ok(await connection.hello(seq));
				},
				async push(batch) {
					if (!online) return TransportError.Offline();
					const outcome = await connection.push(batch);
					if (dropReplies > 0) {
						// The server applied the batch, but its reply never arrives.
						dropReplies--;
						online = false;
						return TransportError.Offline();
					}
					return Ok(outcome);
				},
				close() {
					connection.close();
					reconnects.delete(onOnline);
				},
			};
		},
	};
	return {
		...transport,
		/** Take this device off the network, or bring it back (it then says hello). */
		setOnline(value: boolean) {
			const wasOnline = online;
			online = value;
			if (value && !wasOnline) for (const reconnect of reconnects) reconnect();
		},
		/** Lose the reply to the next batch and go offline, as a dropped connection would. */
		dropNextReply() {
			dropReplies++;
		},
	};
}
