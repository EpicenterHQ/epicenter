/**
 * Disposable browser-test Worker. Production request handling and socket ownership
 * are inherited unchanged; only the test service binding can activate replacements.
 */
import { WorkerEntrypoint } from 'cloudflare:workers';
import { StoreAuthority as ProductionAuthority } from '../../../packages/server/src/store-sync/authority.js';

export {
	default,
	GenerationsLedger,
	SelfHostAuthOwner,
	SelfHostOperator,
} from '../../self-host/worker/index.js';

export class StoreAuthority extends ProductionAuthority {
	captureForTest() {
		// biome-ignore lint/complexity/useLiteralKeys: Access the actual private owner without adding a production test hook.
		return this['authority'].capture();
	}

	async activateForTest(
		request: Parameters<
			ProductionAuthority['authority']['prepareActivation']
		>[0],
	) {
		// biome-ignore lint/complexity/useLiteralKeys: Activate through the same owner that holds the production socket hub.
		const prepared = await this['authority'].prepareActivation(request);
		return prepared.activate();
	}
}

/** This entrypoint exists only in the temporary test configuration. */
export class AppTestOperator extends WorkerEntrypoint<{
	STORE_AUTHORITY: DurableObjectNamespace<StoreAuthority>;
}> {
	/** Service discovery can restart Wrangler after its HTTP port is ready. */
	ready() {
		return true;
	}

	private authority() {
		return this.env.STORE_AUTHORITY.get(
			this.env.STORE_AUTHORITY.idFromName(
				'libraries/apps/so.epicenter.honeycrisp/shared/data/so.epicenter.honeycrisp',
			),
		);
	}

	async capture() {
		return this.authority().captureForTest();
	}

	async activate(request: Parameters<StoreAuthority['activateForTest']>[0]) {
		return this.authority().activateForTest(request);
	}
}
