import type { Device } from '@epicenter/device';
import type { AccountWorkflow } from './accounts.js';
import { DEFAULT_MAIL_CONFIG } from './config.js';

export function accountWorkflow({
	device,
	storage,
	identity,
	config = DEFAULT_MAIL_CONFIG,
	now = () => Date.now(),
}: {
	device: Pick<Device, 'secrets'>;
	storage: AccountWorkflow['storage'];
	identity: AccountWorkflow['identity'];
	config?: AccountWorkflow['config'];
	now?: () => number;
}): AccountWorkflow {
	return {
		secrets: device.secrets,
		storage,
		identity,
		config,
		now,
		activity: new Map(),
	};
}
