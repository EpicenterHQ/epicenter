import { extractErrorMessage } from 'wellcrafted/error';

import {
	executeSnapshotQuery,
	type HomeSnapshotQueryResult,
} from './snapshot-query-execution.ts';

type SnapshotQueryProcessRequest = { path: string; sql: string };
type SnapshotQueryProcessResponse =
	| { data: HomeSnapshotQueryResult; error: null }
	| { data: null; error: { message: string } };

export async function runSnapshotQueryProcess(): Promise<void> {
	let response: SnapshotQueryProcessResponse;
	try {
		const input: unknown = JSON.parse(
			await new Response(Bun.stdin.stream()).text(),
		);
		if (
			typeof input !== 'object' ||
			input === null ||
			!('path' in input) ||
			typeof input.path !== 'string' ||
			!('sql' in input) ||
			typeof input.sql !== 'string'
		) {
			throw new Error('Invalid snapshot query process request');
		}
		response = {
			data: executeSnapshotQuery(input.path, input.sql),
			error: null,
		};
	} catch (cause) {
		response = { data: null, error: { message: extractErrorMessage(cause) } };
	}
	await Bun.write(Bun.stdout, JSON.stringify(response));
}

export type SnapshotQueryProcessRunner = (
	request: SnapshotQueryProcessRequest,
) => Promise<HomeSnapshotQueryResult>;

export function createSnapshotQueryProcessRunner({
	command = [
		process.execPath,
		new URL('./snapshot-query-process-entry.ts', import.meta.url).pathname,
	],
	timeoutMs = 2_000,
}: {
	command?: string[];
	timeoutMs?: number;
} = {}): SnapshotQueryProcessRunner {
	return async (request) => {
		const child = Bun.spawn({
			cmd: command,
			env: { ...process.env, EPICENTER_SNAPSHOT_QUERY_PROCESS: '1' },
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'pipe',
		});
		child.stdin.write(JSON.stringify(request));
		child.stdin.end();
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill();
		}, timeoutMs);
		try {
			const [exitCode, output, stderr] = await Promise.all([
				child.exited,
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
			]);
			if (timedOut) {
				throw new Error(`Snapshot query exceeded ${timeoutMs} milliseconds`);
			}
			if (exitCode !== 0) {
				throw new Error(
					stderr.trim() || `Snapshot query process exited with ${exitCode}`,
				);
			}
			const response = JSON.parse(output) as SnapshotQueryProcessResponse;
			if (response.error !== null) throw new Error(response.error.message);
			return response.data;
		} finally {
			clearTimeout(timeout);
			if (child.exitCode === null) child.kill();
		}
	};
}
