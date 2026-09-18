/** Form defaults only. A preset does not select a protocol or promise a model. */
export type PresetId = 'ollama' | 'lmstudio' | 'openai' | 'openrouter' | 'groq';

export type ConnectionPreset = {
	id: PresetId;
	label: string;
	baseUrl: string;
	requiresKey: boolean;
};

/** Users can override each URL and optional bearer key, or enter a custom URL. */
export const CONNECTION_PRESETS = [
	{
		id: 'ollama',
		label: 'Ollama',
		baseUrl: 'http://localhost:11434/v1',
		requiresKey: false,
	},
	{
		id: 'lmstudio',
		label: 'LM Studio',
		baseUrl: 'http://localhost:1234/v1',
		requiresKey: false,
	},
	{
		id: 'openai',
		label: 'OpenAI',
		baseUrl: 'https://api.openai.com/v1',
		requiresKey: true,
	},
	{
		id: 'openrouter',
		label: 'OpenRouter',
		baseUrl: 'https://openrouter.ai/api/v1',
		requiresKey: true,
	},
	{
		id: 'groq',
		label: 'Groq',
		baseUrl: 'https://api.groq.com/openai/v1',
		requiresKey: true,
	},
] as const satisfies readonly ConnectionPreset[];
