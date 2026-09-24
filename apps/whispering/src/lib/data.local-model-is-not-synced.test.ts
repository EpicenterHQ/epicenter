import { describe, expect, it } from 'bun:test';
import { whisperingDefinition } from './data';

/**
 * The active local transcription model must never synchronize (ADR-0180).
 *
 * It names model files and an accelerator that exist on one machine: a second
 * device may have neither the bytes nor compatible hardware, so a synced choice
 * would arrive as a model that cannot run. Whispering therefore owns the
 * transcription *route* here and nothing about which local model runs; the host
 * owns that, device-locally, and Epicenter Home administers it.
 *
 * This guards the direction the mistake would come from. The workspace's `kv` section
 * IS the synced settings surface, so a local-model key landing in it is exactly
 * how the invariant would silently break: the key would look like an ordinary
 * setting and start replicating.
 */
describe('the active local model is device-local', () => {
	const settingKeys = Object.keys(whisperingDefinition.kv);

	it('is absent from the synced settings contract', () => {
		const localModelKeys = settingKeys.filter(
			(key) =>
				/local/i.test(key) && (/model/i.test(key) || /unload/i.test(key)),
		);
		expect(localModelKeys).toEqual([]);
	});

	it('keeps only the selected model in the settings contract', () => {
		expect(settingKeys).toContain('transcriptionModel');
		expect(settingKeys).not.toContain('transcriptionService');
		expect(settingKeys).not.toContain('completionProvider');
		expect(settingKeys).not.toContain('transcriptionDeepgramModel');
	});
});
