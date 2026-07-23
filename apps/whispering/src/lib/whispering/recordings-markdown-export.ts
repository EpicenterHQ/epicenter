import { strToU8, zipSync } from 'fflate';
import yaml from 'js-yaml';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { type DownloadError, DownloadServiceLive } from '#platform/download';
import type { Recording } from '$lib/data';
import type { WhisperingApp } from '$lib/whispering/app';

function recordingToMarkdown(recording: Recording): string {
	const { transcript, ...frontmatter } = recording;
	const yamlStr = yaml.dump(frontmatter, { lineWidth: -1 });
	return `---\n${yamlStr}---\n${transcript || ''}\n`;
}

/** Export the current app-level recording projection as one inert zip. */
export async function exportRecordingsMarkdown(
	app: WhisperingApp,
): Promise<Result<{ written: number }, DownloadError>> {
	await app.recordings.refresh();
	const rows = app.recordings.sorted;
	if (rows.length === 0) return Ok({ written: 0 });

	const files: Record<string, Uint8Array> = {};
	for (const row of rows) {
		files[`${row.id}.md`] = strToU8(recordingToMarkdown(row));
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
