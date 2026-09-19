import {
	IMPORTABLE_AUDIO_EXTENSIONS,
	IMPORTABLE_MIME_PREFIXES,
	IMPORTABLE_VIDEO_EXTENSIONS,
	MAX_IMPORT_FILE_SIZE,
	MAX_IMPORT_FILES,
} from '../constants/import-formats.js';
import { report } from '../report/index.js';
import type { WhisperingApp } from '../whispering/app.js';
import { logAnalyticsEvent } from './analytics.js';
import { processRecordingPipeline } from './pipeline.js';
import { saveAudioRecording } from './save-audio-recording.js';
import { captureTranscription } from './transcribe.js';

type RejectedImportFile = { file: File; reason: string };

function displaySize(bytes: number): string {
	const kilobyte = 1024;
	const megabyte = 1024 * kilobyte;
	const gigabyte = 1024 * megabyte;

	if (bytes < kilobyte) return `${bytes.toFixed(0)} B`;
	if (bytes < megabyte) return `${(bytes / kilobyte).toFixed(0)} KB`;
	if (bytes < gigabyte) return `${(bytes / megabyte).toFixed(0)} MB`;
	return `${(bytes / gigabyte).toFixed(0)} GB`;
}

function fileExtension(file: File) {
	return file.name.split('.').pop()?.toLowerCase() ?? '';
}

function isImportableFile(file: File) {
	if (
		IMPORTABLE_MIME_PREFIXES.some((prefix) =>
			file.type.toLowerCase().startsWith(prefix),
		)
	) {
		return true;
	}

	const extension = fileExtension(file);
	return (
		IMPORTABLE_AUDIO_EXTENSIONS.includes(
			extension as (typeof IMPORTABLE_AUDIO_EXTENSIONS)[number],
		) ||
		IMPORTABLE_VIDEO_EXTENSIONS.includes(
			extension as (typeof IMPORTABLE_VIDEO_EXTENSIONS)[number],
		)
	);
}

function partitionByImportPolicy(files: File[]) {
	const valid: File[] = [];
	const rejected: RejectedImportFile[] = [];

	for (const file of files) {
		if (!isImportableFile(file)) {
			rejected.push({ file, reason: 'Not an audio or video file' });
			continue;
		}

		if (file.size > MAX_IMPORT_FILE_SIZE) {
			rejected.push({
				file,
				reason: `Larger than the ${displaySize(MAX_IMPORT_FILE_SIZE)} limit`,
			});
			continue;
		}

		if (valid.length >= MAX_IMPORT_FILES) {
			rejected.push({
				file,
				reason: `Over the ${MAX_IMPORT_FILES}-file limit`,
			});
			continue;
		}

		valid.push(file);
	}

	return { valid, rejected };
}

/**
 * Imports audio/video files and runs each through the transcription pipeline.
 * This is its own surface, separate from the microphone recording triggers:
 * importing a file never touches `recordingTrigger`. Works on web (the file
 * picker) and desktop (the picker plus drag-and-drop).
 */
export async function importFiles(
	app: WhisperingApp,
	{ files }: { files: File[] },
): Promise<void> {
	if (!app.recordingEnabled) throw new Error('Whispering is closing.');
	const { valid, rejected } = partitionByImportPolicy(files);

	if (rejected.length > 0) {
		report.info({
			title: `${rejected.length} file${rejected.length === 1 ? '' : 's'} skipped`,
			description: rejected
				.map(({ file, reason }) => `${file.name}: ${reason}`)
				.join('\n'),
		});
	}

	if (valid.length === 0) return;

	await Promise.all(
		valid.map(async (file) => {
			void logAnalyticsEvent(app, {
				type: 'file_import_completed',
				blob_size: file.size,
			});

			const transcribe = captureTranscription(app);
			const { data: recording, error } = await saveAudioRecording(app, file);
			if (error !== null) throw error;
			if (recording === null) return;
			await processRecordingPipeline(app, {
				recordingId: recording.id,
				transcribe,
				deliverySource: 'import',
			});
		}),
	);
}
