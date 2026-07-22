import type {
	AuthorityError,
	FactsResponse,
	SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import type { Result } from 'wellcrafted/result';

import { DataAuthority } from './scalar-v1-cloudflare.js';

type AuthorityStub = {
	readFacts(request: unknown): Promise<Result<FactsResponse, AuthorityError>>;
	submit(request: unknown): Promise<Result<SubmissionResponse, AuthorityError>>;
	deleteAccount(): Promise<void>;
};

type TestEnv = {
	DATA_AUTHORITY: {
		getByName(name: string): AuthorityStub;
	};
};

type Command = {
	object: string;
	operation: 'deleteAccount' | 'readFacts' | 'submit';
	request?: unknown;
};

export default {
	async fetch(request: Request, env: TestEnv): Promise<Response> {
		const command = (await request.json()) as Command;
		const authority = env.DATA_AUTHORITY.getByName(command.object);
		switch (command.operation) {
			case 'readFacts':
				return Response.json(await authority.readFacts(command.request));
			case 'submit':
				return Response.json(await authority.submit(command.request));
			case 'deleteAccount':
				await authority.deleteAccount();
				return Response.json({ deleted: true });
		}
	},
};

export { DataAuthority };
