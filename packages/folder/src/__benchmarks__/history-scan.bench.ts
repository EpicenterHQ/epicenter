/**
 * Request-owned Git inspection over real, disposable repositories.
 * Run with `bun packages/folder/src/__benchmarks__/history-scan.bench.ts`.
 * Optional --output=path saves raw samples; --case=name selects a fixture.
 * One warmup precedes three measured repetitions. No cache flushing: timings
 * include warm filesystem caches. Read bytes are logical, not physical I/O.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nodeDirectoryPrimitives } from '../directory-node.js';
import { createDirectoryStorage } from '../directory-store.js';
import { createNativeGitBackend } from '../git/native-backend.js';
import { runNativeHistory } from '../git/native-history.js';
import { createGitRunner } from '../git/native-host.js';
import { scratchDirectory } from '../native/directory.js';

const MiB = 1024 * 1024;
const fixtures = [
	{ name: '1k-notes', notes: 1_000, audioFiles: 0, audioBytes: 0 },
	{
		name: '1k-notes-512MiB-audio',
		notes: 1_000,
		audioFiles: 4,
		audioBytes: 128 * MiB,
	},
	{ name: '10k-notes', notes: 10_000, audioFiles: 0, audioBytes: 0 },
	{
		name: '10k-notes-512MiB-audio',
		notes: 10_000,
		audioFiles: 4,
		audioBytes: 128 * MiB,
	},
	{
		name: '1k-notes-8k-audio-files',
		notes: 1_000,
		audioFiles: 8_192,
		audioBytes: 64 * 1024,
	},
];
const option = (name: string) =>
	process.argv
		.find((arg) => arg.startsWith(`--${name}=`))
		?.slice(name.length + 3);
const selected = option('case');
if (
	selected !== undefined &&
	!fixtures.some((fixture) => fixture.name === selected)
)
	throw new Error(`Unknown fixture: ${selected}`);
const root = await mkdtemp(join(tmpdir(), 'epicenter-history-scan-'));
const reports = [];
try {
	for (const fixture of fixtures) {
		if (selected !== undefined && selected !== fixture.name) continue;
		const directory = join(root, fixture.name);
		await mkdir(directory);
		const run = createGitRunner(directory);
		const files = nodeDirectoryPrimitives;
		const backend = await createNativeGitBackend({
			root: directory,
			branch: 'main',
			host: { run, files },
		});
		await backend.createRepository?.();
		await writeFile(join(directory, '.gitignore'), '*.wav\n');
		const note = 'A paragraph of local text.\n'.repeat(80);
		for (let index = 0; index < fixture.notes; index++) {
			const path = join(
				directory,
				'notes',
				String(Math.floor(index / 100)),
				`${index}.md`,
			);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, note);
		}
		await run(['add', '--', '.gitignore', 'notes']);
		await run([
			'-c',
			'user.name=Benchmark',
			'-c',
			'user.email=benchmark@example.test',
			'commit',
			'--quiet',
			'-m',
			'Fixture',
		]);
		// Real allocated bytes; no sparse files or special treatment of extensions.
		const audio = new Uint8Array(fixture.audioBytes).fill(137);
		for (let index = 0; index < fixture.audioFiles; index++) {
			const path = join(
				directory,
				'audio',
				String(Math.floor(index / 100)),
				`${index}.wav`,
			);
			await mkdir(dirname(path), { recursive: true });
			await writeFile(path, audio);
		}
		const storage = createDirectoryStorage({
			root: directory,
			primitives: files,
			scratch: scratchDirectory(directory),
			hold: { lock: <T>(work: () => Promise<T>) => work(), held: files },
		});
		for (const op of ['status', 'saveVersion'] as const) {
			for (let pass = -1; pass < 3; pass++) {
				const scans: {
					listMs: number;
					readMs: number;
					reads: number;
					bytes: number;
					audioReads: number;
					audioBytes: number;
				}[] = [];
				const start = performance.now();
				const reply = await runNativeHistory({
					rootPath: directory,
					host: { run, files },
					author: { name: 'Benchmark', email: 'benchmark@example.test' },
					request: { op },
					boundary: {
						...storage,
						async list() {
							const scan = {
								listMs: 0,
								readMs: 0,
								reads: 0,
								bytes: 0,
								audioReads: 0,
								audioBytes: 0,
							};
							scans.push(scan);
							const start = performance.now();
							const result = await storage.list();
							scan.listMs = performance.now() - start;
							return result;
						},
						async read(path) {
							const scan = scans.at(-1);
							if (scan === undefined) throw new Error('Read before listing');
							const start = performance.now();
							const result = await storage.read(path);
							scan.readMs += performance.now() - start;
							scan.reads++;
							if (result.error === null) {
								scan.bytes += result.data.bytes.byteLength;
								if (path.endsWith('.wav')) {
									scan.audioReads++;
									scan.audioBytes += result.data.bytes.byteLength;
								}
							}
							return result;
						},
					},
				});
				const milliseconds = performance.now() - start;
				if (
					reply.state.files === undefined ||
					('status' in reply.result && reply.result.status !== 'unchanged')
				)
					throw new Error(
						`Unexpected benchmark result: ${JSON.stringify(reply)}`,
					);
				if (pass >= 0)
					reports.push({
						fixture: fixture.name,
						op,
						pass,
						milliseconds,
						scans,
					});
			}
		}
		console.error(`Measured ${fixture.name}`);
		await rm(directory, { recursive: true, force: true });
	}
	const result = {
		measuredAt: new Date().toISOString(),
		bun: Bun.version,
		cpu: cpus()[0]?.model,
		platform: process.platform,
		note: 'Warm caches; logical byte counts at storage boundary; final scan is scans.at(-1). Status isolates inspection; saveVersion includes checkpoint, protection, lock, index and inspection.',
		reports,
	};
	const output = option('output');
	if (output !== undefined) {
		await mkdir(dirname(output), { recursive: true });
		await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
	}
	console.log(JSON.stringify(result, null, 2));
} finally {
	await rm(root, { recursive: true, force: true });
}
