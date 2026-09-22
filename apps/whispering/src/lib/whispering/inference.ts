import { createBrowserInferenceSelections } from '@epicenter/app-shell/inference-selections';
import type { InferenceTarget } from '@epicenter/app-shell/inference-target';
import type { AccountIdentity } from '@epicenter/principal';
import type { WhisperingSettingValues } from '../data.js';
import type { WhisperingAppHandle } from './app.js';

type Workflow = 'transcription' | 'completion';
type DeviceKv = WhisperingAppHandle['local']['kv'];

/** Read the connection and model the device chose for this workflow. */
export function getInferenceTarget(
	kv: DeviceKv,
	workflow: Workflow,
): InferenceTarget | null {
	const connectionId = kv.get(`${workflow}Connection`);
	return connectionId == null
		? null
		: { connectionId, model: kv.get(`${workflow}Model`) ?? '' };
}

/** Import pre-KV choices once, before recording and queries start. */
export function importLegacyInferenceSelections(
	kv: DeviceKv,
	identity?: AccountIdentity,
) {
	const workflows = (['transcription', 'completion'] as const).filter(
		(workflow) => kv.get(`${workflow}Connection`) === undefined,
	);
	if (workflows.length === 0) return;

	let targets: Partial<Record<Workflow, InferenceTarget | null>> = {};
	try {
		const legacy = createBrowserInferenceSelections('whispering', identity);
		try {
			targets = {
				transcription: legacy.get('transcription'),
				completion: legacy.get('completion'),
			};
		} finally {
			legacy[Symbol.dispose]();
		}
	} catch {
		// Malformed or inaccessible legacy storage leaves the workflow unselected.
	}

	let changes: Partial<WhisperingSettingValues> = {};
	for (const workflow of workflows) {
		const target = targets[workflow];
		const previousModel =
			kv.get(`${workflow}Model`) ??
			(workflow === 'completion' ? 'gemini-2.5-flash' : '');
		const matches =
			target && target.model.trim() && target.model === previousModel;
		changes = {
			...changes,
			[`${workflow}Connection`]: matches ? target.connectionId : null,
			...(matches ? { [`${workflow}Model`]: target.model } : {}),
		};
	}
	// Explicit null records initialization and prevents reset from resurrecting
	// the old choice. Leave legacy bytes intact so a crash before KV persistence
	// can retry. Retire this importer when pre-KV upgrades are no longer supported.
	kv.update(changes);
}
