/**
 * Form defaults for connecting a provider. A preset does not select a
 * protocol or promise a model. Servers on this computer (Ollama, LM Studio)
 * need no form: `localServers()` finds them.
 */
export const CONNECTION_PRESETS = [
	{ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
	{
		id: 'openrouter',
		label: 'OpenRouter',
		baseUrl: 'https://openrouter.ai/api/v1',
	},
	{ id: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' },
] as const;

export type PresetId = (typeof CONNECTION_PRESETS)[number]['id'];
