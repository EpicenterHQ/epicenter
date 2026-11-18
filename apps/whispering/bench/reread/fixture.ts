/**
 * Write the folder `fixture-files.ts` describes to `<dir>`.
 *
 * Usage: `bun bench/reread/fixture.ts <dir> <count>`
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixtureFiles } from './fixture-files.js';

const [dir, countText] = process.argv.slice(2);
if (dir === undefined || countText === undefined) {
	console.error('Usage: bun bench/reread/fixture.ts <dir> <count>');
	process.exit(1);
}
const count = Number(countText);
mkdirSync(join(dir, 'recordings'), { recursive: true });
mkdirSync(join(dir, 'transcriptions'), { recursive: true });
let recordings = 0;
let transcripts = 0;
let bytes = 0;
for (const [path, text] of fixtureFiles(count)) {
	writeFileSync(join(dir, path), text);
	bytes += Buffer.byteLength(text);
	if (path.startsWith('transcriptions/')) transcripts++;
	else if (path.endsWith('.md')) recordings++;
}
console.log(
	`${dir}: ${recordings} recordings, ${transcripts} transcripts, ${(bytes / 1e6).toFixed(1)} MB of notes`,
);
