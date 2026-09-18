import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import type { WhisperingAppHandle } from '../whispering/app.js';

export function createWhisperingConnections(
	app: WhisperingAppHandle,
	selections: InferenceSelections,
) {
	return createInferenceConnections({
		connections: app.device.connections,
		accountConnection: app.account?.connection ?? null,
		selections,
		hostedModels: toHostedCatalog(['gpt-5.4-mini', 'gpt-5.5']),
	});
}
