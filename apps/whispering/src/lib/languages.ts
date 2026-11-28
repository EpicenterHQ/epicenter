/**
 * The languages a person can say they dictate in, each with the two-letter
 * code a Whisper model and an OpenAI-compatible server take. An empty code
 * leaves the language to be detected, which is right for someone who
 * switches languages and can guess wrong on a take of a few words.
 */
export const LANGUAGES = [
	{ code: '', name: 'Detect it' },
	{ code: 'ar', name: 'Arabic' },
	{ code: 'zh', name: 'Chinese' },
	{ code: 'cs', name: 'Czech' },
	{ code: 'da', name: 'Danish' },
	{ code: 'nl', name: 'Dutch' },
	{ code: 'en', name: 'English' },
	{ code: 'fi', name: 'Finnish' },
	{ code: 'fr', name: 'French' },
	{ code: 'de', name: 'German' },
	{ code: 'el', name: 'Greek' },
	{ code: 'he', name: 'Hebrew' },
	{ code: 'hi', name: 'Hindi' },
	{ code: 'hu', name: 'Hungarian' },
	{ code: 'id', name: 'Indonesian' },
	{ code: 'it', name: 'Italian' },
	{ code: 'ja', name: 'Japanese' },
	{ code: 'ko', name: 'Korean' },
	{ code: 'no', name: 'Norwegian' },
	{ code: 'pl', name: 'Polish' },
	{ code: 'pt', name: 'Portuguese' },
	{ code: 'ro', name: 'Romanian' },
	{ code: 'ru', name: 'Russian' },
	{ code: 'es', name: 'Spanish' },
	{ code: 'sv', name: 'Swedish' },
	{ code: 'th', name: 'Thai' },
	{ code: 'tr', name: 'Turkish' },
	{ code: 'uk', name: 'Ukrainian' },
	{ code: 'vi', name: 'Vietnamese' },
] as const;
