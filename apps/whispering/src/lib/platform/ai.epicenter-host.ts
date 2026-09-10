import type { AppAiBinding } from '@epicenter/app';
import { createEpicenterHostAppAi } from '@epicenter/app/epicenter-host';
import { createNativeInferenceTransport } from '@epicenter/app/native-ai';

export const ai: AppAiBinding = {
	...createEpicenterHostAppAi('whispering'),
	runtime: createNativeInferenceTransport(),
};
