/**
 * Property Test, in memory
 *
 * The property test (`property.test-support.ts`, whose header lists the
 * invariants) over the memory harness: a seeded network on virtual time,
 * the server called in-process. Fast enough for thousands of seeds:
 * B_RUNS=n, B_FROM=n, B_SEED=n, B_STEPS=n, B_TOTALS=1.
 *
 * Key behaviors:
 * - nothing typed and acknowledged is lost; every device converges; hostile writes are refused or bounded
 * - once the last flush is done, Git's main is the server's main
 *
 * See also:
 * - `wire.property.test.ts` for the same test over real HTTP and WebSockets
 */
import { definePropertySuite, memoryWorld } from './property.test-support.js';

definePropertySuite({ label: 'the repository in memory', prefix: 'B', runs: 40, world: memoryWorld });
