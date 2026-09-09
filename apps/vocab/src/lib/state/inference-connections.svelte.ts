import type { App } from '@epicenter/app';
import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import type { vocabDefinition } from '$lib/data';
import { VOCAB_MODEL } from '$lib/data';

export const createVocabConnections = (app: App<typeof vocabDefinition>) =>
 createInferenceConnections({ app, hostedModels: toHostedCatalog([VOCAB_MODEL]) });
