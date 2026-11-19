/**
 * Preloaded before every test (`bunfig.toml`). Only serve runs an action, so
 * a fixture starts one for its Epicenter when a test first runs an action
 * (`runner.test-support.ts`); this stops those after each test.
 */
import { afterAll, afterEach } from 'bun:test';
import { stopFixtureServes } from './runner.test-support.ts';

afterEach(stopFixtureServes);
afterAll(stopFixtureServes);
