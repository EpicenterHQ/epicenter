export const TRANSCRIPTION_SERVICE_IDS = [
	'epicenter',
	'OpenAI',
	'Groq',
	'ElevenLabs',
	'Deepgram',
	'Mistral',
	'local',
	'speaches',
	'openai-compatible',
] as const;

export type TranscriptionServiceId = (typeof TRANSCRIPTION_SERVICE_IDS)[number];
