/** Real-directory read costs for the shared folder query polling policy. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { openFolder } from '../bun.js';
import { readDocuments } from '../documents.js';

const root = await mkdtemp(join(tmpdir(), 'epicenter-folder-reads-'));
const reports = [];
try {
	for (const count of [1_000, 10_000]) {
		const directory = join(root, String(count));
		await mkdir(join(directory, 'notes'), { recursive: true });
		for (let start = 0; start < count; start += 32)
			await Promise.all(
				Array.from({ length: Math.min(32, count - start) }, (_, offset) =>
					writeFile(
						join(directory, 'notes', `${start + offset}.md`),
						`---\ntitle: Note ${start + offset}\ndone: false\n---\n${'A paragraph of local text.\n'.repeat(40)}`,
					),
				),
			);
		const opened = await openFolder({
			directory,
			tables: {
				notes: Type.Object({ title: Type.String(), done: Type.Boolean() }),
			},
		});
		if (opened.error !== null) throw opened.error;
		const folder = opened.data;
		for (const [name, read] of [
			['rows', () => folder.tables.notes.list()],
			['documents', () => readDocuments(folder.files)],
		] as const) {
			for (let pass = 0; pass < 3; pass++) {
				const start = performance.now();
				const result = await read();
				if (result.error !== null) throw result.error;
				reports.push({
					files: count,
					reader: name,
					pass,
					milliseconds: +(performance.now() - start).toFixed(1),
				});
			}
		}
		await folder.close();
	}
	console.table(reports);
} finally {
	await rm(root, { recursive: true, force: true });
}
