import { WorkerEntrypoint } from 'cloudflare:workers';
export type Description = {
	schema: Record<string, unknown>;
	privateInput?: boolean;
};
export declare class HostedActions extends WorkerEntrypoint {
	describe(): Record<string, Description>;
	run(
		name: string,
		input: unknown,
		files: unknown,
		sink: unknown,
	): Promise<{
		data: unknown;
		error: null | { kind: string; reason?: unknown; message?: string };
	}>;
}
