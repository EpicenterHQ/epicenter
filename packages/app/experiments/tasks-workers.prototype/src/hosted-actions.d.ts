import { WorkerEntrypoint } from 'cloudflare:workers';
// RPC contract implemented by the raw server-source.ts adapter.
export declare class HostedActions extends WorkerEntrypoint {
	describe(): string[];
	run(
		name: string,
		input: unknown,
		files: unknown,
	): Promise<{
		returned?: unknown;
		threw?: { message: string };
		error?: { name: string; message: string };
	}>;
}
