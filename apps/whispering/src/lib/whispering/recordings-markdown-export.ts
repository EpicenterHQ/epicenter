import { strToU8, zipSync } from 'fflate';
import yaml from 'js-yaml';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type DownloadError, DownloadServiceLive } from '#platform/download';
import type { WhisperingData } from '$lib/whispering/app';
import type { Recording, Transcription } from '../data.js';
import { sortedRecordings } from './recordings.js';
import { transcriptionsForRecording } from './transcriptions.js';

function recordingToMarkdown(recording: Recording, results: Transcription[]): string {
	const yamlStr = yaml.dump(recording, { lineWidth: -1 });
	const history = results.map((result) =>
		`## Transcription ${result.attemptedAt}\n\nResult ID: ${result.id}\n\n### Original\n\n${result.rawText}\n` +
		(result.cleanedText === null ? '' : `\n### Cleaned\n\n${result.cleanedText}\n`),
	).join('\n');
	return `---\n${yamlStr}---\n${history}`;
}

/** Export the current app-level recording projection as one inert zip. */
export async function exportRecordingsMarkdown(
	store: WhisperingData,
): Promise<Result<{ written: number }, DownloadError>> {
	const rows = sortedRecordings(store);
	if (rows.length === 0) return Ok({ written: 0 });

	const files: Record<string, Uint8Array> = {};
	for (const row of rows) {
		files[`${row.id}.md`] = strToU8(
			recordingToMarkdown(row, transcriptionsForRecording(store, row.id)),
		);
	}
	const blob = new Blob([zipSync(files) as BlobPart], {
		type: 'application/zip',
	});
	const { error } = await DownloadServiceLive.downloadBlob({
		name: 'recordings.zip',
		blob,
	});
	if (error) return Err(error);
	return Ok({ written: rows.length });
}
