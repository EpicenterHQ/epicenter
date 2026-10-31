/** How the desktop shell's refusal to open a window's folder reads in the page. */
import { OpenFolderError } from '../errors.js';
import type { WindowError } from './bindings.gen.js';

/** What a refused open tells the page. */
export function openRefusal(refusal: WindowError) {
	switch (refusal.name) {
		case 'NotBound':
			return OpenFolderError.NotBound();
		case 'Missing':
			return OpenFolderError.Missing();
		case 'Unavailable':
			return OpenFolderError.Unavailable({ cause: refusal.message });
		case 'ShuttingDown':
			return OpenFolderError.ShuttingDown();
		case 'NotGranted':
			return OpenFolderError.Unavailable({
				cause: `This window may not open ${refusal.root}.`,
			});
		default:
			return OpenFolderError.Unavailable({ cause: refusal });
	}
}
