/**
 * Publish Capture's contract as `static/contract.json`, the URL `epicenter
 * check` takes. `src/lib/contract.test.ts` fails when the two disagree.
 *
 *   bun run contract
 */
import { capture } from '../src/lib/model/index.js';

await Bun.write(
	new URL('../static/contract.json', import.meta.url),
	`${JSON.stringify(capture, null, '\t')}\n`,
);
