/**
 * Property Test, over the real wire
 *
 * The property test (`property.test-support.ts`, whose header lists the
 * invariants) against the Bun dev server on localhost, on virtual time
 * (`wire-harness.ts`), over each transport: a device's socket, which
 * carries its pushes, catch-ups, their answers and every event in one
 * ordered sequence (W_RUNS=n, W_FROM=n, W_SEED=n, W_STEPS=n, W_TOTALS=1),
 * and a one-shot client's HTTP requests beside an events-only socket
 * (the same with H_).
 *
 * Key behaviors:
 * - the memory suite's invariants hold when every message crosses the wire, its JSON, statuses and socket
 * - a device whose socket drops resumes from its last head
 *
 * See also:
 * - `property.test.ts` for the same test in memory, for many more seeds
 */
import { definePropertySuite } from './property.test-support.js';
import { createWireWorld } from './wire-harness.js';

definePropertySuite({ label: 'the repository over the socket', prefix: 'W', runs: 200, world: (options) => createWireWorld(options), timeout: 60_000 });
definePropertySuite({ label: 'the repository over HTTP', prefix: 'H', runs: 50, world: (options) => createWireWorld(options, { transport: 'http' }), timeout: 60_000 });
