/**
 * The folder as one file to download: every note, its audio and
 * `settings.md`, in a zip archive whose entries are stored, not
 * compressed (audio is already compressed). A browser's recordings live in
 * its storage for this site, which it may clear, so export is how they
 * leave it (ADR-0894); the archive holds the same tree as the desktop's
 * folder.
 */
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { Files, FilesError } from './files/files.js';

/** The directories Whispering writes, and the one file at the top. */
const DIRECTORIES = [
	'recordings',
	'transcriptions',
	'transformations',
	'transformation_runs',
	'text_runs',
];
const TOP = ['settings.md'];

/** Every file Whispering wrote, with its bytes. */
export async function folderFiles(
	files: Files,
): Promise<Result<{ path: string; bytes: Uint8Array }[], FilesError>> {
	const paths: string[] = [...TOP];
	for (const dir of DIRECTORIES) {
		const listed = await files.list(dir);
		if (listed.error !== null) return Err(listed.error);
		for (const { name } of listed.data) paths.push(`${dir}/${name}`);
	}
	const out: { path: string; bytes: Uint8Array }[] = [];
	for (const path of paths) {
		const read = await files.read(path);
		if (read.error !== null) return Err(read.error);
		if (read.data !== null) out.push({ path, bytes: read.data });
	}
	return Ok(out);
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let crc = 0xffffffff;
	for (const byte of bytes)
		crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8);
	return (crc ^ 0xffffffff) >>> 0;
}

/**
 * `entries` as a zip archive, each stored as it is, under a folder named
 * `root`, or why not: a plain zip holds at most 65,535 files and 4 GB.
 */
export function zipOf(
	root: string,
	entries: readonly { path: string; bytes: Uint8Array }[],
): Result<Blob, string> {
	const total = entries.reduce((sum, { bytes }) => sum + bytes.length, 0);
	if (entries.length > 0xffff || total > 0xf0000000)
		return Err(
			'The folder is too large for one zip file (more than 65,535 files or 4 GB).',
		);
	const encoder = new TextEncoder();
	const parts: BlobPart[] = [];
	const central: Uint8Array[] = [];
	let offset = 0;
	for (const { path, bytes } of entries) {
		const name = encoder.encode(`${root}/${path}`);
		const crc = crc32(bytes);
		const local = new DataView(new ArrayBuffer(30));
		local.setUint32(0, 0x04034b50, true);
		local.setUint16(4, 20, true); // version needed
		local.setUint16(6, 0x0800, true); // names are UTF-8
		local.setUint16(8, 0, true); // stored
		local.setUint32(14, crc, true);
		local.setUint32(18, bytes.length, true);
		local.setUint32(22, bytes.length, true);
		local.setUint16(26, name.length, true);
		parts.push(local.buffer, name, bytes as Uint8Array<ArrayBuffer>);
		const entry = new DataView(new ArrayBuffer(46));
		entry.setUint32(0, 0x02014b50, true);
		entry.setUint16(4, 20, true); // version made by
		entry.setUint16(6, 20, true); // version needed
		entry.setUint16(8, 0x0800, true);
		entry.setUint16(10, 0, true);
		entry.setUint32(16, crc, true);
		entry.setUint32(20, bytes.length, true);
		entry.setUint32(24, bytes.length, true);
		entry.setUint16(28, name.length, true);
		entry.setUint32(42, offset, true);
		const record = new Uint8Array(46 + name.length);
		record.set(new Uint8Array(entry.buffer), 0);
		record.set(name, 46);
		central.push(record);
		offset += 30 + name.length + bytes.length;
	}
	const size = central.reduce((sum, record) => sum + record.length, 0);
	const end = new DataView(new ArrayBuffer(22));
	end.setUint32(0, 0x06054b50, true);
	end.setUint16(8, entries.length, true);
	end.setUint16(10, entries.length, true);
	end.setUint32(12, size, true);
	end.setUint32(16, offset, true);
	return Ok(
		new Blob(
			[...parts, ...(central as Uint8Array<ArrayBuffer>[]), end.buffer],
			{
				type: 'application/zip',
			},
		),
	);
}
