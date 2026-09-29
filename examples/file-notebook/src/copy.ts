import { unzipSync, zipSync } from 'fflate';
import type { BrowserAccountFiles } from './browser-files.js';
import { type AccountFiles, checkedPath, isLfsPointer } from './files.js';

function isAttachment(path: string) {
	return /\.(?:jpg|jpeg|png|webp|gif|opus|mp3|mp4|pdf)$/i.test(path);
}

export async function exportAccountFiles(
	files: AccountFiles,
): Promise<Uint8Array> {
	const snapshot = await files.snapshot();
	for (const file of snapshot) {
		if (isAttachment(file.path) && isLfsPointer(file.bytes)) {
			throw new Error(
				`Attachment is an LFS pointer, not complete bytes: ${file.path}`,
			);
		}
	}
	return zipSync(
		Object.fromEntries(snapshot.map((file) => [file.path, file.bytes])),
	);
}

export async function importEmptyAccountFiles(
	files: BrowserAccountFiles,
	archive: Uint8Array,
): Promise<void> {
	const entries = Object.entries(unzipSync(archive)).filter(
		([path]) => !path.endsWith('/'),
	);
	const incoming = entries.map(([path, bytes]) => ({
		path: checkedPath(path),
		bytes,
	}));
	for (const file of incoming) {
		if (isAttachment(file.path) && isLfsPointer(file.bytes))
			throw new Error(`Attachment is an LFS pointer: ${file.path}`);
	}
	await files.applyIncoming([], incoming);
}
