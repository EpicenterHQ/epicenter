/**
 * Publish the contract as `static/contract.json`, the URL `epicenter check`
 * takes. `src/lib/contract.test.ts` fails when the two disagree.
 *
 *   bun run contract
 */
import { honeycrisp } from '../src/lib/contract.ts';

await Bun.write(
	new URL('../static/contract.json', import.meta.url),
	`${JSON.stringify(honeycrisp, null, '\t')}\n`,
);
