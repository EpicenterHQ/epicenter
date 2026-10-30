/**
 * Publish Whispering's contract as `static/contract.json`, the URL
 * `epicenter check` takes, in the repository's format so a rewrite of an
 * unchanged contract changes nothing. `src/lib/contract.test.ts` fails when
 * the two disagree.
 *
 *   bun run contract
 */
import { $ } from 'bun';
import { fileURLToPath } from 'node:url';
import { whispering } from '../src/lib/contract.ts';

const published = fileURLToPath(
	new URL('../static/contract.json', import.meta.url),
);
await Bun.write(published, `${JSON.stringify(whispering, null, '\t')}\n`);
await $`bun x biome format --write ${published}`.quiet();
