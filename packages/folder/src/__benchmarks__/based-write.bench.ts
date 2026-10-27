/** Run with `bun src/__benchmarks__/based-write.bench.ts` from packages/folder. */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Type } from 'typebox';
import { openFolder as openBunFolder } from '../bun.js';
import { createFolder } from '../folder.js';
import { merge } from '../shared/merge.js';
import { memoryHost } from '../testing.js';

const path = 'notes/a.md';
const body = `${'a'.repeat(99)}\n`.repeat(1000);
const base = `---\ntitle: Benchmark\npinned: false\n---\n${body}`;
const tables = {
	notes: Type.Object({ title: Type.String(), pinned: Type.Boolean() }),
};

function p95(samples: number[]) {
	return samples.toSorted((a, b) => a - b)[
		Math.ceil(samples.length * 0.95) - 1
	];
}

async function mergeCost() {
	let current = base;
	let total = 0;
	for (let count = 1; count <= 100; count++) {
		if (count % 10 !== 0) {
			current += 'x';
			continue;
		}
		const changed = current.replace(/title: .*\n/, `title: Field ${count}\n`);
		const start = performance.now();
		const result = await merge(path, {
			base: current,
			current: changed,
			change: `${current}x`,
		});
		total += performance.now() - start;
		if (typeof result.content !== 'string')
			throw new Error('Expected merged text');
		current = result.content;
	}
	return total;
}

async function run(host: 'memory' | 'bun', based: boolean) {
	const directory =
		host === 'bun'
			? await mkdtemp(join(import.meta.dir, 'based-write-'))
			: undefined;
	try {
		if (directory !== undefined) {
			await mkdir(join(directory, 'notes'));
			await writeFile(join(directory, path), base);
		}
		const opened =
			directory === undefined
				? await createFolder(memoryHost({ [path]: base }).storage, { tables })
				: await openBunFolder({ directory, tables });
		if (opened.error !== null) throw opened.error;
		const folder = opened.data;
		try {
			const latencies: number[] = [];
			const saves: Promise<unknown>[] = [];
			const cpuStart = process.cpuUsage();
			const wallStart = performance.now();
			for (let count = 1; count <= 100; count++) {
				const observed = folder.file(path)?.data;
				if (typeof observed !== 'string')
					throw new Error('Missing current text');
				if (count % 10 === 0) {
					const field = folder.tables.notes
						.update('a', { fields: { title: `Field ${count}` } })
						.then((result) => {
							if (result.error !== null) throw result.error;
						});
					saves.push(field);
				}
				const started = performance.now();
				const saved = folder
					.write(path, `${observed}x`, based ? { base: observed } : undefined)
					.then((result) => {
						if (result.error !== null) throw result.error;
						latencies.push(performance.now() - started);
					});
				saves.push(saved);
				await Bun.sleep(30);
			}
			await Promise.all(saves);
			await folder.idle();
			const cpu = process.cpuUsage(cpuStart);
			const wall = performance.now() - wallStart;
			const landed = folder.file(path)?.data;
			if (typeof landed !== 'string') throw new Error('Missing landed text');
			return {
				host,
				based,
				bytes: new TextEncoder().encode(base).length,
				mergeMs: based ? await mergeCost() : 0,
				p95Ms: p95(latencies),
				cpuMs: (cpu.user + cpu.system) / 1000,
				wallMs: wall,
				fieldSurvived: landed.includes('title: Field 100'),
			};
		} finally {
			await folder.close();
		}
	} finally {
		if (directory !== undefined) {
			await rm(directory, { recursive: true, force: true });
			await rm(
				join(import.meta.dir, `.${basename(directory)}.epicenter-save-lock`),
				{ force: true },
			);
		}
	}
}

for (const host of ['memory', 'bun'] as const)
	for (const based of [false, true])
		console.log(JSON.stringify(await run(host, based)));
