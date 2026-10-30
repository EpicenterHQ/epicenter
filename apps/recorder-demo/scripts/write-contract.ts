/**
 * Publish the contract as `public/contract.json`, the URL `epicenter check`
 * takes. `src/contract.test.ts` fails when the two disagree.
 *
 *   bun run contract
 */
import { recorder } from '../src/contract.ts';

await Bun.write(
	new URL('../public/contract.json', import.meta.url),
	`${JSON.stringify(recorder, null, '\t')}\n`,
);
