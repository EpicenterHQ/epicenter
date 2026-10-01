/**
 * Browser stand-in for `node:zlib`. just-bash's browser bundle imports gzip
 * helpers for its gzip, gunzip, and zcat commands; the folder terminal does
 * not enable those commands, so reaching this code is a defect.
 */
function unavailable(): never {
	throw new Error('Compression is unavailable in the browser terminal');
}

export const constants = {};
export const gzipSync = unavailable;
export const gunzipSync = unavailable;
