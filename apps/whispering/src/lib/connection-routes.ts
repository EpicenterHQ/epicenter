/**
 * Where one of Whispering's requests goes, decided when it is sent.
 *
 * Each operation names a connection, a row of this device's `so.epicenter`,
 * by id in `kv.json` (ADR-0564). A route is that row read now: its kind, the
 * exact model, and the endpoint the request reaches. The result row records
 * the connection, endpoint, and model, and running it again rebuilds the
 * route from what it recorded, so a request is sent again only over the
 * connection it first went over, and only while that still reaches the same
 * endpoint (`send.ts` refuses the rest).
 */
import type { ConnectionKind } from '@epicenter/ai/send';
import type { ConnectionFields } from '@epicenter/ai/ui';
import type { FileTable } from '@epicenter/folder';
import { Err, Ok, type Result } from 'wellcrafted/result';
import {
	readTranscription,
	readTransformation,
	type TranscriptionAudio,
	transcriptionRequest,
	transformationRequest,
} from './requests.js';
import type { ConnectionTarget, Workspace } from './workspace/types.js';

export type Operation = 'transcription' | 'text';

/** What one request goes over, and what its result row records. */
export type Route = {
	readonly connection: string;
	readonly kind: ConnectionKind;
	readonly title: string;
	/** The exact model: the row's, a recipe's own, or this computer's active local model. */
	readonly model: string;
	/** Where the request goes: the saved endpoint, the account's `/v1`, or empty for this computer's local model. */
	readonly endpoint: string;
};

/**
 * The connection an operation names, as the screen shows it before anything
 * is sent. Advisory: a request resolves its route again when it goes out.
 */
export type ChosenConnection = {
	readonly connection: string;
	readonly title: string;
	/** Undefined when the row it names is gone. */
	readonly kind: ConnectionKind | undefined;
	readonly model: string;
	/** Why it cannot carry the operation here, if it cannot. */
	readonly unusable: string | undefined;
};

/** The routing a run uses: routes read now or from a row, and the two requests over one. */
export type Routing = {
	route(operation: Operation, model?: string): Promise<Result<Route, string>>;
	recorded(
		operation: Operation,
		fields: {
			readonly connection?: string;
			readonly endpoint: string;
			readonly model: string;
		},
	): Promise<Result<Route, string>>;
	transcribe(
		route: Route,
		audioPath: string,
	): Promise<Result<{ text: string }, { message: string }>>;
	transform(
		route: Route,
		request: { readonly prompt: string; readonly input: string },
	): Promise<Result<{ text: string }, { message: string }>>;
};

/** What routing reads: the workspace, and the `connections` table of its `so.epicenter`. */
export type RoutePorts = {
	readonly workspace: Pick<Workspace, 'connections' | 'localTranscription'>;
	readonly rows: Pick<FileTable<ConnectionFields>, 'get'>;
};

/** Whether a connection of `kind` can carry `operation` in this workspace, or why not, naming it `name`. */
export function unusable(
	ports: Pick<RoutePorts, 'workspace'>,
	operation: Operation,
	kind: ConnectionKind,
	name: string,
): string | undefined {
	if (!ports.workspace.connections.kinds.includes(kind))
		return kind === 'local'
			? `${name} runs on a computer’s local transcription model, which this browser does not have.`
			: `${name} sends to an Epicenter account, which Whispering in a browser does not sign in to.`;
	if (kind === 'local' && operation === 'text')
		return `${name} runs on this computer’s local transcription model, which only transcribes.`;
	return undefined;
}

async function readRow(
	{ rows }: RoutePorts,
	connection: string,
): Promise<Result<ConnectionFields | undefined, string>> {
	const { data: stored, error } = await rows.get(connection);
	if (error !== null)
		return Err(`connections/${connection}.md does not read: ${error.message}`);
	return Ok(stored?.row.fields);
}

/**
 * The route for `operation` over `connection`, the id `kv.json` names, read
 * now. `model` is a recipe's own model, used instead of the row's.
 */
export async function routeOf(
	ports: RoutePorts,
	operation: Operation,
	connection: string | undefined,
	model?: string,
): Promise<Result<Route, string>> {
	if (!connection)
		return Err(
			`No ${operation} connection is chosen. Choose one in Settings.`,
		);
	const { data: row, error } = await readRow(ports, connection);
	if (error !== null) return Err(error);
	if (row === undefined)
		return Err(
			`The ${operation} connection is gone. Choose another in Settings.`,
		);
	const name = row.title || connection;
	const why = unusable(ports, operation, row.kind, name);
	if (why !== undefined) return Err(why);
	const { connections, localTranscription } = ports.workspace;
	const named = model?.trim() || row.model.trim();
	const route = { connection, kind: row.kind, title: name };
	if (row.kind === 'local') {
		if (named) return Ok({ ...route, model: named, endpoint: '' });
		const { data: active, error: modelError } =
			// `unusable` refused `local` where there is no local transcription.
			await (localTranscription as NonNullable<typeof localTranscription>)
				.activeModel();
		if (modelError !== null) return Err(modelError);
		return Ok({ ...route, model: active, endpoint: '' });
	}
	if (!named) return Err(`${name} names no model. Add one in Settings.`);
	if (row.kind === 'epicenter') {
		const { data: endpoint, error: accountError } =
			await connections.epicenterEndpoint();
		if (accountError !== null)
			return Err(`${name} sends to your Epicenter account: ${accountError}`);
		return Ok({ ...route, model: named, endpoint });
	}
	const { data: saved, error: keyError } =
		await connections.keys.state(connection);
	if (keyError !== null)
		return Err(`${name}’s endpoint could not be read: ${keyError}`);
	if (saved.state === 'missing')
		return Err(`${name} has no endpoint saved yet. Add one in Settings.`);
	return Ok({ ...route, model: named, endpoint: saved.endpoint });
}

/**
 * The route a result row recorded, to send its request again: over the same
 * connection and model, and only to the endpoint it recorded.
 */
export async function recordedRoute(
	ports: RoutePorts,
	operation: Operation,
	fields: {
		readonly connection?: string;
		readonly endpoint: string;
		readonly model: string;
	},
): Promise<Result<Route, string>> {
	const { connection, endpoint, model } = fields;
	if (!connection)
		return Err(
			'This was made before connections were chosen in Settings, so it is not sent again. Delete it and run it anew.',
		);
	const { data: row, error } = await readRow(ports, connection);
	if (error !== null) return Err(error);
	if (row === undefined)
		return Err(
			'The connection this was run over is gone, so it was not sent again. Delete it and run it anew.',
		);
	const name = row.title || connection;
	const why = unusable(ports, operation, row.kind, name);
	if (why !== undefined) return Err(why);
	if (row.kind === 'epicenter') {
		const { data: now, error: accountError } =
			await ports.workspace.connections.epicenterEndpoint();
		if (accountError !== null)
			return Err(`${name} sends to your Epicenter account: ${accountError}`);
		if (now !== endpoint)
			return Err(
				`This was run with ${endpoint}, and ${name} now sends to ${now}, so it was not sent again. Delete it and run it anew.`,
			);
	}
	return Ok({ connection, kind: row.kind, title: name, model, endpoint });
}

function targetOf(route: Route): ConnectionTarget {
	return route.kind === 'openai-compatible'
		? {
				kind: 'openai-compatible',
				connection: route.connection,
				endpoint: route.endpoint,
			}
		: { kind: route.kind, connection: route.connection };
}

/**
 * Transcribe the audio at `audioPath` over `route`: on this computer for a
 * `local` connection, otherwise as a request to its endpoint.
 */
export async function transcribeOver(
	{ workspace }: Pick<RoutePorts, 'workspace'>,
	route: Route,
	audioPath: string,
	readAudio: (path: string) => Promise<Result<TranscriptionAudio, string>>,
): Promise<Result<{ text: string }, { message: string }>> {
	if (route.kind === 'local')
		return (
			workspace.localTranscription?.transcribe(audioPath, route.model) ??
			Err({ message: 'This browser has no local transcription model.' })
		);
	const { data: audio, error: readError } = await readAudio(audioPath);
	if (readError !== null)
		return Err({
			message: `The audio at '${audioPath}' could not be read: ${readError}`,
		});
	const { data: response, error } = await workspace.connections.send(
		targetOf(route),
		await transcriptionRequest(audio, route.model),
	);
	if (error !== null) return Err(error);
	return readTranscription(response);
}

/** Run instructions over a text, over `route`. */
export async function transformOver(
	{ workspace }: Pick<RoutePorts, 'workspace'>,
	route: Route,
	{ prompt, input }: { readonly prompt: string; readonly input: string },
): Promise<Result<{ text: string }, { message: string }>> {
	const { data: response, error } = await workspace.connections.send(
		targetOf(route),
		transformationRequest({ model: route.model, prompt, input }),
	);
	if (error !== null) return Err(error);
	return readTransformation(response);
}
