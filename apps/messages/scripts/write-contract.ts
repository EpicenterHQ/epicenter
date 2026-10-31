/**
 * Publish the contract as `static/contract.json`, the URL `epicenter check`
 * takes. `src/lib/contract.test.ts` fails when the two disagree.
 *
 *   bun run contract
 */
import { messages } from '../src/lib/contract.ts';

await Bun.write(
	new URL('../static/contract.json', import.meta.url),
	`${JSON.stringify(messages, null, '\t')}\n`,
);
