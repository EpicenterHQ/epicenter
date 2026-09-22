import type { openWhisperingResources } from './resources.js';
import type { DeclaredData, Data } from '@epicenter/app/store';
import type { InferenceCatalog } from '@epicenter/app-shell/inference-picker';
import type { Account } from '@epicenter/auth';
import type { whisperingDefinition } from '../data';
import type { WhisperingRecording } from '../operations/recording.svelte.js';

/** Resources acquired together for one Whispering UI session. */
export type WhisperingAppHandle = Awaited<
	ReturnType<typeof openWhisperingResources>
>;
export type WhisperingData = DeclaredData<typeof whisperingDefinition> &
	Pick<Data<typeof whisperingDefinition>, 'persistence' | 'transact'>;

export type WhisperingApp = WhisperingAppHandle & {
	/** The UI lifetime still accepts new capture. */
	readonly recordingEnabled: boolean;
	readonly authAccount: Account | undefined;
	readonly library: WhisperingData;
	readonly catalog: InferenceCatalog;
	readonly recording: WhisperingRecording;
};
