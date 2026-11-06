/** Make the scratch directories tests run in. */
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function scratch(prefix: string): Promise<string> {
	return mkdtemp(join(tmpdir(), prefix));
}
