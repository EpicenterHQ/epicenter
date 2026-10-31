/**
 * `#platform/offline` in Capture's desktop window: nothing to do. The window
 * loads the app from its own bundle, so it opens offline without a service
 * worker, which a Tauri WebView may not register anyway.
 */
export function openOffline(): void {}
