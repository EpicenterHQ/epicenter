/**
 * The transcription server: an OpenAI-compatible address and model. Its API
 * key is not here; `platform/servers` keeps one per origin.
 */
import { Ok, trySync } from 'wellcrafted/result';

/** A server to ask and the model to ask it for. */
export type Server = { baseUrl: string; model: string };

/**
 * Servers the settings form can fill in. A preset only fills the fields; a
 * preset without a model leaves the model field as it is.
 */
export const PRESETS: { label: string; baseUrl: string; model?: string }[] = [
	{ label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'whisper-1' },
	{
		label: 'Groq',
		baseUrl: 'https://api.groq.com/openai/v1',
		model: 'whisper-large-v3-turbo',
	},
	{ label: 'Local server', baseUrl: 'http://localhost:8000/v1' },
];

/** The origin of `baseUrl` (`https://api.openai.com`), or undefined when it is not an http or https address. */
export function originOf(baseUrl: string): string | undefined {
	// `new URL`, not `URL.parse`: an older macOS's WebView lacks `URL.parse`.
	const { data: url } = trySync({
		try: (): URL | undefined => new URL(baseUrl.trim()),
		catch: () => Ok(undefined),
	});
	if (!url || (url.protocol !== 'http:' && url.protocol !== 'https:'))
		return undefined;
	return url.origin;
}
