/**
 * The browser's half of the re-read timing (`README.md`): the fixture
 * written into the Origin Private File System, and `folder.read()` timed
 * over `opfsFiles`, the app's own browser `Files`. Run it in the dev page's
 * console (`bun dev:whispering:ui`):
 *
 * ```js
 * const bench = await import('/bench/reread/opfs.ts');
 * await bench.writeFixture('bench-15000', 15000);
 * await bench.timeRead('bench-15000');
 * await bench.removeFixture('bench-15000');
 * ```
 *
 * Writing to `data` instead fills the app's own folder, so a reload shows
 * the table at that size; remove it the same way after.
 */
import { encode } from '../../src/lib/files/files.js';
import { opfsFiles } from '../../src/lib/files/opfs.js';
import { openFolder } from '../../src/lib/folder.js';
import { fixtureFiles } from './fixture-files.js';

/** Write `count` recordings' files into the OPFS directory `dir`, a few at a time. */
export async function writeFixture(dir: string, count: number) {
	const files = opfsFiles(dir);
	const queue = [...fixtureFiles(count)];
	const at = performance.now();
	await Promise.all(
		Array.from({ length: 16 }, async () => {
			for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
				const written = await files.write(next[0], encode(next[1]));
				if (written.error !== null) throw new Error(written.error.message);
			}
		}),
	);
	return `wrote ${count} recordings to ${dir} in ${Math.round(performance.now() - at)} ms`;
}

/** Time `runs` reads of `dir`: each listing, each `readMany`, and `folder.read()` whole. */
export async function timeRead(dir: string, runs = 6) {
	const files = opfsFiles(dir);
	const folder = openFolder(files);
	const rows: string[] = [];
	for (let run = 0; run < runs; run++) {
		let at = performance.now();
		const recordings = await files.list('recordings');
		const transcriptions = await files.list('transcriptions');
		const list = performance.now() - at;
		const paths = (kind: string, listed: typeof recordings) =>
			(listed.data ?? [])
				.filter(({ name }) => name.endsWith('.md'))
				.map(({ name }) => `${kind}/${name}`);
		at = performance.now();
		await files.readMany(paths('recordings', recordings));
		await files.readMany(paths('transcriptions', transcriptions));
		const readMany = performance.now() - at;
		at = performance.now();
		const read = await folder.read();
		if (read.error !== null) throw new Error(read.error.message);
		const whole = performance.now() - at;
		rows.push(
			`${run},${list.toFixed(0)},${readMany.toFixed(0)},${whole.toFixed(0)},${read.data.recordings.items.length},${read.data.transcriptions.items.length}`,
		);
	}
	return [
		'run,list_ms,readMany_ms,folder_read_ms,recordings,transcripts',
		...rows,
	].join('\n');
}

/** Remove the OPFS directory `dir` and everything in it. */
export async function removeFixture(dir: string) {
	const root = await navigator.storage.getDirectory();
	await root.removeEntry(dir, { recursive: true });
	return `removed ${dir}`;
}
