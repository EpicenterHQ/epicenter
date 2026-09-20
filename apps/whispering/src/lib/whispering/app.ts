import type { App } from '@epicenter/app/open';
import type { InferenceCatalog } from '@epicenter/app-shell/inference-picker';
import type { Account } from '@epicenter/auth';
import type { whisperingDefinition } from '../data';
import type { WhisperingRecording } from '../operations/recording.svelte.js';

/** One local or account dataset's retained portable work. */
export type WhisperingAppHandle = App<typeof whisperingDefinition>;
export type WhisperingData = NonNullable<
	WhisperingAppHandle['account']
>['personal'];

export type WhisperingApp = {
	readonly signal: AbortSignal;
	/** The UI lifetime still accepts new capture. */
	readonly recordingEnabled: boolean;
	readonly account: Account | undefined;
	readonly device: Pick<WhisperingAppHandle['device'], 'kv'>;
	readonly library: WhisperingData;
	readonly catalog: InferenceCatalog;
	readonly blobs: WhisperingAppHandle['blobs'];
	readonly recording: WhisperingRecording;
};
