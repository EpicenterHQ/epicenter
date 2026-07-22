/** One peer in the legacy room collaboration presence channel. */
export type PresencePeer = {
	nodeId: string;
	connectedAt: number;
	agentId?: string;
};

/** Server-to-client complete peer-list replacement. */
export type PresenceFrame = {
	type: 'presence';
	peers: PresencePeer[];
};

/** Client-to-server publication of the sender's optional agent identity. */
export type PresencePublishFrame = {
	type: 'presence_publish';
	agentId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
	value: Record<string, unknown>,
	keys: readonly string[],
): boolean {
	return Object.keys(value).every((key) => keys.includes(key));
}

function isPeer(value: unknown): value is PresencePeer {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, ['nodeId', 'connectedAt', 'agentId']) &&
		typeof value.nodeId === 'string' &&
		typeof value.connectedAt === 'number' &&
		Number.isFinite(value.connectedAt) &&
		(value.agentId === undefined || typeof value.agentId === 'string')
	);
}

/** Total validator for the complete server presence frame. */
export const checkPresenceFrame = Object.freeze({
	Check(value: unknown): value is PresenceFrame {
		return (
			isRecord(value) &&
			hasOnlyKeys(value, ['type', 'peers']) &&
			value.type === 'presence' &&
			Array.isArray(value.peers) &&
			value.peers.every(isPeer)
		);
	},
});

/** Total validator for the client presence publication frame. */
export const checkPresencePublishFrame = Object.freeze({
	Check(value: unknown): value is PresencePublishFrame {
		return (
			isRecord(value) &&
			hasOnlyKeys(value, ['type', 'agentId']) &&
			value.type === 'presence_publish' &&
			(value.agentId === undefined || typeof value.agentId === 'string')
		);
	},
});
