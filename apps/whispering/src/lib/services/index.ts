import { AnalyticsServiceLive } from '#platform/analytics';
import { BlobReplicaLive, BlobSourcesLive, BlobsLive } from '#platform/blobs';
import { DownloadServiceLive } from '#platform/download';
import { TextServiceLive } from '#platform/text';
import { LocalShortcutManagerLive } from './local-shortcut-manager';
import { PlaySoundServiceLive } from './sound';

/**
 * Cross-platform services.
 * These are available on both web and desktop.
 */
export const services = {
	analytics: AnalyticsServiceLive,
	text: TextServiceLive,
	blobs: BlobsLive,
	blobReplica: BlobReplicaLive,
	blobSources: BlobSourcesLive,
	download: DownloadServiceLive,
	localShortcutManager: LocalShortcutManagerLive,
	sound: PlaySoundServiceLive,
} as const;
