/**
 * Browser stand-in for `node:zlib`. `@epicenter/folder` loads its shell
 * (just-bash) lazily, and just-bash's browser bundle imports gzip helpers,
 * so the build must resolve them. Todos never opens that shell, and the
 * shell enables no gzip commands, so reaching this code is a defect.
 */
function unavailable(): never {
	throw new Error('Compression is unavailable in this build');
}

export const constants = {};
export const gzipSync = unavailable;
export const gunzipSync = unavailable;
