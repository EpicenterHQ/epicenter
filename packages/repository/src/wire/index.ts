export { connectReplica, createWireClient, type FeedConnection, type WireClient, WireClientError } from './client.js';
export {
	type Authenticate,
	authenticateBearer,
	createWire,
	DEVICE_HEADER,
	type FeedHub,
	type FeedMessage,
	PING,
	PONG,
	statusOf,
	type Wire,
	WIRE_LIMITS,
	type WireLimits,
} from './wire.js';
