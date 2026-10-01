import { WorkerEntrypoint } from 'cloudflare:workers';
import type { SelfHostAuthOwner } from '@epicenter/server/self-host-auth/worker';

/** Only infrastructure service bindings can reach this named entrypoint. */
export class SelfHostOperator extends WorkerEntrypoint<{
	SELF_HOST_AUTH: DurableObjectNamespace<SelfHostAuthOwner>;
	API_PUBLIC_ORIGIN: string;
}> {
	#owner() {
		return this.env.SELF_HOST_AUTH.get(
			this.env.SELF_HOST_AUTH.idFromName('deployment'),
		);
	}

	#enrollmentLink(grant: { token: string; expiresAt: number }) {
		const link = new URL('/sign-in', this.env.API_PUBLIC_ORIGIN);
		link.hash = new URLSearchParams({ enroll: grant.token }).toString();
		return { url: link.href, expiresAt: grant.expiresAt };
	}

	async admit(input: { id: string; name: string }) {
		return this.#enrollmentLink(await this.#owner().admit(input));
	}

	async recover(id: string) {
		return this.#enrollmentLink(await this.#owner().recover(id));
	}

	async remove(id: string) {
		await this.#owner().remove(id);
	}
}
