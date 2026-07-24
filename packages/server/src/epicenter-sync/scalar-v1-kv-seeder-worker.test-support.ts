import { DurableObject } from 'cloudflare:workers';

class DataAuthority extends DurableObject {
	async seedPlatformKv(): Promise<string[]> {
		await this.ctx.storage.put('platform-seed', true);
		return this.ctx.storage.sql
			.exec<{ name: string; type: string }>(
				`SELECT type, name FROM sqlite_schema
				WHERE type IN ('table', 'index') ORDER BY type, name`,
			)
			.toArray()
			.map(({ type, name }) => `${type}:${name}`);
	}

	async hasPlatformSeed(): Promise<boolean> {
		return (await this.ctx.storage.get('platform-seed')) !== undefined;
	}
}

type TestEnv = {
	DATA_AUTHORITY: {
		getByName(name: string): {
			hasPlatformSeed(): Promise<boolean>;
			seedPlatformKv(): Promise<string[]>;
		};
	};
};

export default {
	async fetch(request: Request, env: TestEnv): Promise<Response> {
		const command = (await request.json()) as {
			object: string;
			operation: 'inspect' | 'seed';
		};
		const authority = env.DATA_AUTHORITY.getByName(command.object);
		switch (command.operation) {
			case 'inspect':
				return Response.json({
					hasPlatformSeed: await authority.hasPlatformSeed(),
				});
			case 'seed':
				return Response.json({
					objects: await authority.seedPlatformKv(),
				});
		}
	},
};

export { DataAuthority };
