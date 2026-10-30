declare global {
	interface Window {
		__codexVoiceQueueFragment?: string;
	}

	namespace App {
		interface PageState {
			view?: 'thread';
		}
	}
}

export {};
