import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { Err, tryAsync } from 'wellcrafted/result';
import { getAudioExtension } from '$lib/services/transcription/utils';
import type { DownloadService } from './types';
import { DownloadError } from './types';

export type { DownloadError, DownloadService } from './types';

export const DownloadServiceLive: DownloadService = {
	downloadBlob: async ({ name, blob }) => {
		const extension = getAudioExtension(blob.type);
		const { data: path, error: saveError } = await tryAsync({
			try: () =>
				save({
					filters: [{ name, extensions: [extension] }],
				}),
			catch: (error) => DownloadError.SaveDialogFailed({ cause: error }),
		});
		if (saveError) return Err(saveError);
		if (path === null) {
			return DownloadError.SaveCancelled();
		}
		return tryAsync({
			try: async () => {
				const contents = new Uint8Array(await blob.arrayBuffer());
				await writeFile(path, contents);
			},
			catch: (error) => DownloadError.WriteFailed({ cause: error }),
		});
	},
};
