import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { basename, extname, join, relative, sep } from 'node:path';
import { hashFile, storeBlob } from '../blobs/store.js';
import type {
	BlobInput,
	ClaimInput,
	ImportItemInput,
	ImportSummary,
	ImportWarning,
	SourceKind,
} from '../db.js';
import { openPhotosDb } from '../db.js';
import { blobsDir, photosDbPath } from '../paths.js';
import {
	type MediaCandidate,
	matchSidecars,
	type SidecarCandidate,
} from './sidecar-match.js';

const IMAGE_EXTENSIONS = new Set([
	'.avif',
	'.bmp',
	'.cr2',
	'.cr3',
	'.dng',
	'.gif',
	'.heic',
	'.heif',
	'.jpeg',
	'.jpg',
	'.nef',
	'.orf',
	'.png',
	'.raf',
	'.raw',
	'.rw2',
	'.tif',
	'.tiff',
	'.webp',
]);
const VIDEO_EXTENSIONS = new Set([
	'.3gp',
	'.avi',
	'.m4v',
	'.mkv',
	'.mov',
	'.mp4',
	'.mts',
	'.webm',
]);

type JsonObject = Record<string, unknown>;

type ScannedFile = {
	absolutePath: string;
	archivePath: string;
	fileName: string;
	bytes: number;
	contentHash: string;
	kind: 'image' | 'video' | 'json' | 'unknown';
	rawText: string | null;
	json: JsonObject | null;
};

export type ImportTakeoutOptions = {
	dataDir: string;
	path: string;
	incremental?: boolean;
};

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(raw: string): JsonObject | null {
	try {
		const value: unknown = JSON.parse(raw);
		return isJsonObject(value) ? value : null;
	} catch {
		return null;
	}
}

function isTakeoutSidecar(value: JsonObject): boolean {
	return (
		isJsonObject(value.photoTakenTime) ||
		isJsonObject(value.geoData) ||
		isJsonObject(value.geoDataExif)
	);
}

function classify(path: string): ScannedFile['kind'] {
	const extension = extname(path).toLowerCase();
	if (IMAGE_EXTENSIONS.has(extension)) return 'image';
	if (VIDEO_EXTENSIONS.has(extension)) return 'video';
	if (extension === '.json') return 'json';
	return 'unknown';
}

async function walkFiles(
	root: string,
	warnings: ImportWarning[],
): Promise<string[]> {
	const files: string[] = [];

	async function walk(directory: string): Promise<void> {
		const entries = await readdir(directory, { withFileTypes: true });
		entries.sort((a, b) => a.name.localeCompare(b.name));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (entry.isFile()) {
				files.push(path);
				continue;
			}
			warnings.push({
				code: 'unsupported_file_type',
				path: relative(root, path).split(sep).join('/'),
				message: 'Skipped a non-regular file. Symlinks are not followed.',
			});
		}
	}

	await walk(root);
	return files;
}

async function scanFile(
	root: string,
	absolutePath: string,
): Promise<ScannedFile> {
	const fileStat = await stat(absolutePath);
	const kind = classify(absolutePath);
	const rawText = kind === 'json' ? await Bun.file(absolutePath).text() : null;
	const archivePath = relative(root, absolutePath).split(sep).join('/');
	return {
		absolutePath,
		archivePath,
		fileName: basename(absolutePath),
		bytes: fileStat.size,
		contentHash: await hashFile(absolutePath),
		kind,
		rawText,
		json: rawText === null ? null : parseJson(rawText),
	};
}

function importFingerprint(files: ScannedFile[]): string {
	const hasher = new Bun.CryptoHasher('sha256');
	hasher.update('local-photos-import-v1\n');
	for (const file of files) {
		hasher.update(
			`${JSON.stringify([file.archivePath, file.bytes, file.contentHash])}\n`,
		);
	}
	return hasher.digest('hex');
}

function nestedObject(object: JsonObject, key: string): JsonObject | null {
	const value = object[key];
	return isJsonObject(value) ? value : null;
}

function timestampFromSidecar(sidecar: JsonObject): string | null {
	const raw = nestedObject(sidecar, 'photoTakenTime')?.timestamp;
	if (typeof raw !== 'string' && typeof raw !== 'number') return null;
	const milliseconds = Number(raw) * 1000;
	if (!Number.isFinite(milliseconds)) return null;
	const date = new Date(milliseconds);
	return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function coordinatesFrom(
	value: JsonObject | null,
): { latitude: number; longitude: number } | null {
	const latitude = value?.latitude;
	const longitude = value?.longitude;
	if (
		typeof latitude !== 'number' ||
		typeof longitude !== 'number' ||
		!Number.isFinite(latitude) ||
		!Number.isFinite(longitude) ||
		latitude < -90 ||
		latitude > 90 ||
		longitude < -180 ||
		longitude > 180 ||
		(latitude === 0 && longitude === 0)
	) {
		return null;
	}
	return { latitude, longitude };
}

function coordinatesFromSidecar(
	sidecar: JsonObject,
): { latitude: number; longitude: number } | null {
	return (
		coordinatesFrom(nestedObject(sidecar, 'geoDataExif')) ??
		coordinatesFrom(nestedObject(sidecar, 'geoData'))
	);
}

function claimedTitle(sidecar: ScannedFile): string | null {
	const title = sidecar.json?.title;
	return typeof title === 'string' && title.length > 0 ? title : null;
}

export async function importTakeout({
	dataDir,
	path,
	incremental = false,
}: ImportTakeoutOptions): Promise<ImportSummary> {
	const startedAt = new Date().toISOString();
	const sourceLocator = await realpath(path);
	const sourceStat = await lstat(sourceLocator);
	if (!sourceStat.isDirectory()) {
		throw new Error(
			'V1 currently imports an extracted Takeout directory. Extract the archive and pass that directory.',
		);
	}

	const warnings: ImportWarning[] = [];
	const paths = await walkFiles(sourceLocator, warnings);
	const files: ScannedFile[] = [];
	for (const filePath of paths)
		files.push(await scanFile(sourceLocator, filePath));
	files.sort((a, b) => a.archivePath.localeCompare(b.archivePath));

	const fingerprint = importFingerprint(files);
	const db = openPhotosDb(photosDbPath(dataDir));
	try {
		const existing = db.findImportByFingerprint(fingerprint);
		if (existing) return existing;

		const mediaFiles = files.filter(
			(file) => file.kind === 'image' || file.kind === 'video',
		);
		const sidecarFiles = files.filter(
			(file) =>
				file.kind === 'json' && file.json && isTakeoutSidecar(file.json),
		);
		const mediaCandidates: MediaCandidate[] = mediaFiles.map((file) => ({
			archivePath: file.archivePath,
			fileName: file.fileName,
		}));
		const sidecarCandidates: SidecarCandidate[] = sidecarFiles.map((file) => ({
			archivePath: file.archivePath,
			fileName: file.fileName,
			claimedTitle: claimedTitle(file),
		}));
		const matching = matchSidecars({
			media: mediaCandidates,
			sidecars: sidecarCandidates,
		});
		for (const unmatched of matching.unmatched) {
			warnings.push({
				code: `sidecar_${unmatched.reason}`,
				path: unmatched.sidecarPath,
				message: 'Preserved a Takeout sidecar but did not attach it to media.',
			});
		}
		const matchedSidecarByMedia = new Map(
			matching.matches.map((match) => [match.mediaPath, match.sidecarPath]),
		);
		const fileByArchivePath = new Map(
			files.map((file) => [file.archivePath, file]),
		);

		const blobs: BlobInput[] = [];
		const seenBlobs = new Set<string>();
		const items: ImportItemInput[] = [];
		const claims: ClaimInput[] = [];
		let blobsNew = 0;
		for (const file of files) {
			if (file.kind !== 'image' && file.kind !== 'video') {
				const itemKind: ImportItemInput['kind'] =
					file.kind === 'json'
						? file.json && isTakeoutSidecar(file.json)
							? 'sidecar'
							: 'album_metadata'
						: 'unknown';
				items.push({
					blobHash: null,
					contentHash: file.contentHash,
					archivePath: file.archivePath,
					originalName: file.fileName,
					sidecarPath: null,
					kind: itemKind,
					rawSidecar: itemKind === 'sidecar' ? file.rawText : null,
				});
				continue;
			}

			const stored = await storeBlob({
				sourcePath: file.absolutePath,
				blobDir: blobsDir(dataDir),
				hash: file.contentHash,
			});
			if (stored.isNew) blobsNew += 1;
			if (!seenBlobs.has(stored.hash)) {
				seenBlobs.add(stored.hash);
				blobs.push({
					hash: stored.hash,
					bytes: stored.bytes,
					mime: stored.mime,
					kind: file.kind,
				});
			}

			const sidecarPath = matchedSidecarByMedia.get(file.archivePath) ?? null;
			const sidecar = sidecarPath
				? (fileByArchivePath.get(sidecarPath) ?? null)
				: null;
			items.push({
				blobHash: stored.hash,
				contentHash: file.contentHash,
				archivePath: file.archivePath,
				originalName: file.fileName,
				sidecarPath,
				kind: 'media',
				rawSidecar: null,
			});
			claims.push({
				assetHash: stored.hash,
				origin: 'filename',
				takenAt: null,
				geoLat: null,
				geoLng: null,
				claimedName: file.fileName,
				raw: null,
			});
			if (sidecar?.json && sidecar.rawText !== null) {
				const coordinates = coordinatesFromSidecar(sidecar.json);
				claims.push({
					assetHash: stored.hash,
					origin: 'takeout_json',
					takenAt: timestampFromSidecar(sidecar.json),
					geoLat: coordinates?.latitude ?? null,
					geoLng: coordinates?.longitude ?? null,
					claimedName: claimedTitle(sidecar) ?? file.fileName,
					raw: sidecar.rawText,
				});
			}
		}

		const sourceKind: SourceKind = incremental
			? 'google_takeout_incremental'
			: 'google_takeout_full';
		const summary = db.recordImport({
			id: randomUUID(),
			fingerprint,
			sourceKind,
			sourceLocator,
			startedAt,
			finishedAt: new Date().toISOString(),
			filesSeen: files.length,
			blobsNew,
			sidecarsSeen: sidecarFiles.length,
			warnings,
			items,
			blobs,
			claims,
		});
		db.resolveAssets();
		return summary;
	} finally {
		db.close();
	}
}
