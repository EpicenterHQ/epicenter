/** Private library-owned transfer control; file payloads use one-shot storage tickets. */
export const ATTACHMENT_ROUTE = {
	pattern: '/api/libraries/:appId/:library/data/:dataId/attachments/:tableName/:rowId',
	url(baseURL: string, appId: string, library: string, dataId: string, tableName: string, rowId: string) {
		return `${baseURL.replace(/\/+$/, '')}/api/libraries/${encodeURIComponent(appId)}/${encodeURIComponent(library)}/data/${encodeURIComponent(dataId)}/attachments/${encodeURIComponent(tableName)}/${encodeURIComponent(rowId)}`;
	},
};
