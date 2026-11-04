/**
 * What Capture's `#platform/variant` seam (`package.json` "imports")
 * promises every build. The build picks the leaf: the online web app's by
 * default, the desktop window's under the `tauri` condition
 * (`bun run build:native`). Each leaf annotates against this type, so both
 * stay one shape.
 */

/** Which Capture this build is, for the few sentences that name the store: the online web app, or the desktop app over its folder. */
export type Variant = 'online' | 'desktop';
