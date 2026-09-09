export const TRANSCRIPTION_SERVICE_IDS = [
	'connection',
	'epicenter',
	'OpenAI',
	'Groq',
	'ElevenLabs',
	'Deepgram',
	'Mistral',
	'local',
	'speaches',
] as const;

export type TranscriptionServiceId = (typeof TRANSCRIPTION_SERVICE_IDS)[number];
