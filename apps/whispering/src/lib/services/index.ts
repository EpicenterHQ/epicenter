import { AnalyticsServiceLive } from '#platform/analytics';
import { DownloadServiceLive } from '#platform/download';
import { TextServiceLive } from '#platform/text';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { PlaySoundServiceLive } from './sound';

/**
 * Cross-platform services.
 * These are available on both web and desktop.
 *
 * The library owns audio bytes and transfers. Recording consumers read locally
 * through the recordings domain, never through a module-level blob service.
 */
export const services = {
	analytics: AnalyticsServiceLive,
	text: TextServiceLive,
	download: DownloadServiceLive,
	localShortcutManager: LocalShortcutManagerLive,
	sound: PlaySoundServiceLive,
} as const;
