/**
 * How an action reaches a language model (ADR-0949). The home's `.env` names
 * each connection with two lines, `<NAME>_BASE_URL` and `<NAME>_API_KEY`, and
 * the default model with `MODEL`. A model's name is `<connection>/<id>`, split
 * at the first `/`, so `epicenter/openai/gpt-5.5` asks the `epicenter`
 * connection for `openai/gpt-5.5`.
 *
 * ```ts
 * const chosen = model(); // MODEL; or model('ollama/qwen3.5:9b')
 * if (chosen.error) return chosen;
 * const { baseURL, id, apiKey } = chosen.data;
 * await fetch(`${baseURL}/chat/completions`, {
 * 	method: 'POST',
 * 	headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
 * 	body: JSON.stringify({ model: id, messages, stream: true }),
 * });
 * ```
 *
 * It returns plain data and sends nothing; the action makes the request.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import { runEnv } from './context.ts';

export const ModelError = defineErrors({
	/** The name, or a line the home's `.env` needs for it, is missing or malformed. */
	Unset: ({ message }: { message: string }) => ({ message }),
});
export type ModelError = InferErrors<typeof ModelError>;

/** Where to send a model request, and the model's id and key there. */
export type ModelConnection = { baseURL: string; id: string; apiKey: string };

const CONNECTION = /^[a-z][a-z0-9]*$/;

/**
 * Turn `name`, or the home's `MODEL` when none is given, into the connection's
 * base URL, the model's id there, and the connection's key, all read from the
 * home's `.env` as the run began. Throws outside an action's run, as `folder` does.
 */
export function model(name?: string): Result<ModelConnection, ModelError> {
	const { path, values } = runEnv();
	const add = (line: string) =>
		ModelError.Unset({ message: `Add ${line} to ${path}` });
	const chosen = name ?? values.MODEL;
	if (!chosen) return add('MODEL=<connection>/<model>');
	const slash = chosen.indexOf('/');
	const connection = slash === -1 ? chosen : chosen.slice(0, slash);
	const id = slash === -1 ? '' : chosen.slice(slash + 1);
	if (!CONNECTION.test(connection) || id === '')
		return ModelError.Unset({
			message: `${JSON.stringify(chosen)} is not a model name; one is <connection>/<model>, such as ollama/qwen3, and a connection is lowercase letters and digits`,
		});
	const prefix = connection.toUpperCase();
	const baseURL = values[`${prefix}_BASE_URL`]?.replace(/\/+$/, '');
	if (!baseURL) return add(`${prefix}_BASE_URL=<address>`);
	const apiKey = values[`${prefix}_API_KEY`];
	if (!apiKey) return add(`${prefix}_API_KEY=<key>`);
	return Ok({ baseURL, id, apiKey });
}
