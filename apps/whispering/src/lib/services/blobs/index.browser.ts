import type { BlobReplica, BlobSources, Blobs } from '@epicenter/blobs';
import {
	createBrowserBlobSources,
	createBrowserBlobs,
} from '@epicenter/blobs/browser';
import {
	createBrowserBlobReplica,
	createEpicenterClient,
} from '@epicenter/client';
import { auth } from '#platform/auth';

export const BlobsLive: Blobs = createBrowserBlobs();
export const BlobSourcesLive: BlobSources = createBrowserBlobSources(BlobsLive);
const epicenterClient = createEpicenterClient({
	baseURL: auth.deployment.baseURL,
	fetch: auth.fetch,
});

/**
 * Browser-only remote copy adapter. Auth state remains live inside `auth.fetch`;
 * application operations still refuse calls while signed out so a missing
 * credential is a product state rather than an HTTP surprise.
 */
export const BlobReplicaLive: BlobReplica | null = createBrowserBlobReplica({
	blobs: BlobsLive,
	client: epicenterClient,
});
