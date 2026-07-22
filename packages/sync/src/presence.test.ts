import { expect, test } from 'bun:test';

import { checkPresenceFrame, checkPresencePublishFrame } from './presence.js';

test('presence frames are closed and finite', () => {
	expect(
		checkPresenceFrame.Check({
			type: 'presence',
			peers: [{ nodeId: 'node-one', connectedAt: 1, agentId: 'agent-one' }],
		}),
	).toBe(true);
	expect(
		checkPresenceFrame.Check({
			type: 'presence',
			peers: [{ nodeId: 'node-one', connectedAt: Number.NaN }],
		}),
	).toBe(false);
	expect(
		checkPresenceFrame.Check({ type: 'presence', peers: [], extra: true }),
	).toBe(false);
});

test('presence publication accepts only the optional agent identity', () => {
	expect(checkPresencePublishFrame.Check({ type: 'presence_publish' })).toBe(
		true,
	);
	expect(
		checkPresencePublishFrame.Check({
			type: 'presence_publish',
			agentId: 'agent-one',
		}),
	).toBe(true);
	expect(
		checkPresencePublishFrame.Check({
			type: 'presence_publish',
			agentId: 1,
		}),
	).toBe(false);
});
