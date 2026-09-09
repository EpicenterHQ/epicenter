import type { AppAiBinding } from '@epicenter/app';
import { createBrowserAppAi } from '@epicenter/app/browser';
import { createNativeInferenceTransport } from '@epicenter/app/native-ai';

// Native HTTP retains configured credentials without borrowing Account transport.
export const ai: AppAiBinding = {
	...createBrowserAppAi('whispering', async (input, init) => {
		const { fetch } = await import('@tauri-apps/plugin-http');
		return fetch(input, init);
	}),
	runtime: createNativeInferenceTransport(),
};
