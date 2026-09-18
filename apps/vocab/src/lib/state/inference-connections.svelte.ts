import type { App } from '@epicenter/app';
import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import type { InferenceSelections } from '@epicenter/app-shell/inference-selections';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import type { vocabDefinition } from '$lib/data';
import { VOCAB_MODEL } from '$lib/data';

export const createVocabConnections = (
	app: App<typeof vocabDefinition>,
	selections: InferenceSelections,
) =>
	createInferenceConnections({
		connections: app.device.connections,
		accountConnection: app.account?.connection ?? null,
		selections,
		hostedModels: toHostedCatalog([VOCAB_MODEL]),
	});
