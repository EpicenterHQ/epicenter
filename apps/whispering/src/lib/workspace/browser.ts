/**
 * The browser workspace: a logical folder and its Git history in OPFS.
 *
 * The same tables, files, and history as the desktop folder, in a private browser
 * directory. The terminal is the in-page shell over those files. AI
 * connections are rows of this origin's own `so.epicenter`, with each
 * endpoint and key in this tab's storage (ADR-0581), and requests go straight
 * from the page, so an endpoint must allow this origin.
 *
 * The opener is the browser one, named explicitly. It refuses inside a
 * desktop app or when browser storage cannot be opened. Any refusal is what
 * the person is shown: nothing else is opened in its place.
 */
import {
	browserSecrets,
	openBrowserConnections,
	sendFromBrowser,
} from '@epicenter/ai/browser';
import { browserKeys } from '@epicenter/ai/ui';
import { openFolder } from '@epicenter/folder/browser';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { createFixtureDevice, toneWav } from '../capture.js';
import { whisperingDefinition } from '../definition.js';
import { createWebViewMicrophone } from '../webview-microphone.js';
import { localPreferences } from './microphone-preference.js';
import {
	type ConnectionsFolder,
	type OpenWorkspace,
	WHISPERING_FOLDER_ID,
	WorkspaceError,
} from './types.js';

/**
 * A development build opened with `?fixture=tone` records a generated tone
 * instead of the microphone. A production build never does.
 */
function wantsToneFixture(): boolean {
	return (
		import.meta.env.DEV &&
		new URLSearchParams(location.search).get('fixture') === 'tone'
	);
}

/** The `#platform/workspace` leaf of every build Epicenter does not serve. */
export const openWorkspace: OpenWorkspace = async () => {
	const { data: folder, error: openError } = await openFolder({
		id: WHISPERING_FOLDER_ID,
		definition: whisperingDefinition,
		browser: {
			author: { name: 'Whispering', email: 'whispering@localhost' },
		},
	});
	if (openError !== null)
		return WorkspaceError.BrowserFolder({ refusal: openError });
	const secrets = browserSecrets();
	// Opened when first asked for, once; a failed open is tried again.
	let connectionsFolder: Promise<Result<ConnectionsFolder, string>> | undefined;
	function openConnections() {
		connectionsFolder ??= openBrowserConnections().then(({ data, error }) => {
			if (error === null) return Ok(data);
			connectionsFolder = undefined;
			return Err(`This browser’s connections did not open: ${error.message}`);
		});
		return connectionsFolder;
	}

	return Ok({
		kind: 'browser',
		folder,
		folderId: WHISPERING_FOLDER_ID,
		location: 'Private files for this site in this browser',
		terminal: undefined,
		capture: wantsToneFixture()
			? createFixtureDevice({
					name: 'generated tone',
					load: async () => ({ name: 'tone.wav', bytes: toneWav() }),
				})
			: createWebViewMicrophone(),
		captureNotice: undefined,
		reveal: undefined,
		localTranscription: undefined,
		connections: {
			// Whispering in a browser signs in to no account and has no local model.
			kinds: ['openai-compatible'],
			keys: browserKeys(secrets),
			epicenterNote: '',
			note: `Requests are sent from this browser tab, so an endpoint must allow requests from ${location.origin} (CORS). Most hosted providers refuse that; a local endpoint, or Whispering in Epicenter, works.`,
			open: openConnections,
			epicenterEndpoint: async () =>
				Err('Whispering in a browser does not sign in to Epicenter'),
			async send(target, request) {
				const { data: response, error } = await sendFromBrowser({
					target,
					request,
					secrets,
				});
				if (error === null) return Ok(response);
				// A browser reports a refused cross-origin request only as a failed
				// fetch, so say what a tab needs that Epicenter does not.
				return Err({
					message:
						error.name === 'Unreachable'
							? `${error.message}. In a browser tab the endpoint must allow requests from ${location.origin} (CORS); Whispering in Epicenter has no such limit`
							: error.message,
				});
			},
		},
		preferences: localPreferences,
		debugControls: import.meta.env.DEV,
		injection: undefined,
		close: async () => {
			const opened = await connectionsFolder;
			await Promise.all([folder.close(), opened?.data?.close()]);
		},
	});
};
