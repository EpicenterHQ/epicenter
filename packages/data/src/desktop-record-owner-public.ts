export {
	DESKTOP_RECORD_ATTACHMENT_ROUTE,
	DESKTOP_RECORD_ROUTE,
	DesktopRecordProtocolError,
	type DesktopRecordRequest,
	type DesktopRecordResponse,
	EPICENTER_DESKTOP_RECORD_ATTACHMENT_REQUIRED_ERROR_NAME,
	EPICENTER_DESKTOP_RECORD_MOVED_ERROR_NAME,
	EPICENTER_DESKTOP_RECORD_OPERATION_ERROR_NAME,
	EPICENTER_DESKTOP_RECORD_REQUEST_ERROR_NAME,
	isDesktopRecordMutationRequest,
	MAX_RECORD_BLOB_BYTES,
} from './desktop-record/protocol.js';
export {
	type CreateDesktopRecordEpicenterOwnerOptions,
	createDesktopRecordEpicenterOwner,
	type DesktopRecordEpicenterOwner,
	type DesktopRecordNativeCaptureResolution,
	type DesktopRecordNativeCaptureResolver,
} from './desktop-record-owner.js';
