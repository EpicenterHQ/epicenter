import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

type EvidenceFile = {
	path: string;
	sha256: string;
};

type EvidenceAggregate = {
	name: string;
	sha256: string;
	entries: (EvidenceFile & { logicalPath: string })[];
};

type EvidenceManifest = {
	files: EvidenceFile[];
	aggregates?: EvidenceAggregate[];
};

const root = resolve(import.meta.dir, '..');
const manifests = [
	'docs/benchmarks/replica-layout/provenance.json',
	'docs/benchmarks/authority-layout/provenance.json',
	'docs/benchmarks/document-struct-bound/provenance.json',
];

async function sha256(path: string): Promise<string> {
	return createHash('sha256')
		.update(await readFile(resolve(root, path)))
		.digest('hex');
}

async function verifyFile(file: EvidenceFile): Promise<void> {
	const actual = await sha256(file.path);
	if (actual !== file.sha256) {
		throw new Error(
			`benchmark evidence hash mismatch for ${file.path}: expected ${file.sha256}, received ${actual}`,
		);
	}
}

for (const manifestPath of manifests) {
	const manifest = JSON.parse(
		await readFile(resolve(root, manifestPath), 'utf8'),
	) as EvidenceManifest;
	for (const file of manifest.files) await verifyFile(file);
	for (const aggregate of manifest.aggregates ?? []) {
		const hash = createHash('sha256');
		for (const entry of aggregate.entries) {
			await verifyFile(entry);
			hash.update(entry.logicalPath);
			hash.update('\0');
			hash.update(entry.sha256);
			hash.update('\0');
		}
		const actual = hash.digest('hex');
		if (actual !== aggregate.sha256) {
			throw new Error(
				`benchmark evidence aggregate mismatch for ${aggregate.name}: expected ${aggregate.sha256}, received ${actual}`,
			);
		}
	}
}

console.log(`Benchmark evidence OK. ${manifests.length} manifests verified.`);
