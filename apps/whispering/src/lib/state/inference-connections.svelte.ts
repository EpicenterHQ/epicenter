import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import type { WhisperingAppHandle } from '../whispering/app.js';

export function createWhisperingConnections(app: WhisperingAppHandle) {
 return createInferenceConnections({ app, hostedModels: toHostedCatalog(['gpt-5.4-mini', 'gpt-5.5']) });
}
