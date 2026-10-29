/**
 * Design B Property Test, over the real wire
 *
 * The property test (`property.test-support.ts`, whose header lists the
 * invariants) with every replica request a real HTTP request to the Bun dev
 * server on localhost and the change feed a real WebSocket, on virtual time
 * (`wire-harness.ts`). W_RUNS=n, W_FROM=n, W_SEED=n, W_STEPS=n, W_TOTALS=1.
 *
 * Key behaviors:
 * - the memory suite's invariants hold when every message crosses the wire, its JSON, statuses and feed
 * - a device whose socket drops resumes from its last head
 *
 * See also:
 * - `b.property.test.ts` for the same test in memory, for many more seeds
 */
import { definePropertySuite } from './property.test-support.js';
import { createWireWorld } from './wire-harness.js';

definePropertySuite({ label: 'design B over the wire', prefix: 'W', runs: 200, world: createWireWorld, timeout: 60_000 });
