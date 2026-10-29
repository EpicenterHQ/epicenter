/**
 * Slice 1's protocol on a WebSocket: a device's hello and pushes, each
 * answered by id, and the server's broadcasts. Every frame is one JSON object.
 */
import type { Batch, Broadcast } from '../protocol.js';

export type ClientFrame = { type: 'hello'; id: number; seq: number } | { type: 'push'; id: number; batch: Batch };

export type ServerFrame = { type: 'reply'; id: number; value: unknown } | { type: 'broadcast'; broadcast: Broadcast };
