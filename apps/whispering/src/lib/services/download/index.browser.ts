import { tryAsync } from 'wellcrafted/result';
import { DownloadError, type DownloadService } from './types.js';

export type { DownloadError, DownloadService } from './types.js';

export const DownloadServiceLive: DownloadService = {
	downloadBlob: ({ name, blob }) =>
		tryAsync({
			try: async () => {
				const url = URL.createObjectURL(blob);
				try {
					const link = document.createElement('a');
					link.href = url;
					link.download = name;
					link.click();
				} finally {
					// The browser consumes the URL after the click's default action.
					setTimeout(() => URL.revokeObjectURL(url), 0);
				}
			},
			catch: (cause) => DownloadError.BrowserDownloadFailed({ cause }),
		}),
};
