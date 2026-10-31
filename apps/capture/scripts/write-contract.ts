/**
 * Publish Capture's contract as `static/contract.json`, the URL `epicenter
 * check` takes. `src/lib/contract.test.ts` fails when the two disagree.
 *
 *   bun run contract
 */
import { capture } from '@epicenter/capture';

await Bun.write(
	new URL('../static/contract.json', import.meta.url),
	`${JSON.stringify(capture, null, '\t')}\n`,
);
