import { save } from '@tauri-apps/plugin-dialog';
import { writeFile } from '@tauri-apps/plugin-fs';
import { Err, tryAsync } from 'wellcrafted/result';
import type { DownloadService } from './types.js';
import { DownloadError } from './types.js';

export type { DownloadError, DownloadService } from './types.js';

export const DownloadServiceLive: DownloadService = {
	downloadBlob: async ({ name, blob }) => {
		const extension = name.includes('.') ? name.split('.').at(-1) : undefined;
		const { data: path, error: saveError } = await tryAsync({
			try: () =>
				save({
					defaultPath: name,
					...(extension
						? { filters: [{ name, extensions: [extension] }] }
						: {}),
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
