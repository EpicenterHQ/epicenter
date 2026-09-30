/**
 * isomorphic-git reads a global `Buffer` at call time. Browsers have none, so
 * the browser entry installs the `buffer` package's implementation before
 * isomorphic-git is used. Bun and Node already provide one.
 */
import { Buffer } from 'buffer/';

const scope = globalThis as { Buffer?: unknown };
if (scope.Buffer === undefined) scope.Buffer = Buffer;
