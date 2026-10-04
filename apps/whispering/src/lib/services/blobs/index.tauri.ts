import type { BlobReplica, BlobSources, Blobs } from '@epicenter/blobs';
import {
	createWebviewBlobSources,
	createWebviewBlobs,
} from '@epicenter/blobs/webview';

export const BlobsLive: Blobs = createWebviewBlobs();
export const BlobSourcesLive: BlobSources = createWebviewBlobSources(BlobsLive);

/**
 * Desktop recording rows are still device-local. Do not offer a cloud copy
 * whose only manifest would disappear with this device; a later Account
 * workspace cutover must land with the host-owned streaming adapter.
 */
export const BlobReplicaLive: BlobReplica | null = null;
