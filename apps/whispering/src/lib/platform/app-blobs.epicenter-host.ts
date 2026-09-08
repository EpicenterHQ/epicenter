import type { AppBlobFactory } from '@epicenter/app';
import { createWebviewBlobs } from '@epicenter/blobs/webview';

/** The desktop host composes one app-scoped capability for capture, playback, and transfer. */
export const appBlobs: AppBlobFactory = createWebviewBlobs;
