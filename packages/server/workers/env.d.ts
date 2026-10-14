/** The bindings `vitest.workers.config.ts` gives a test. */
declare global {
	namespace Cloudflare {
		interface Env {
			/** Hosted deletion-route fixture imports the billing binding contract. */
			AUTUMN_SECRET_KEY: string;
		}
	}
}

export {};
