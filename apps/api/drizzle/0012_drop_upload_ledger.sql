-- The upload ledger is the log's `blob` table now (ADR-0824): an upload no
-- change named yet is a `blob` row whose state is `pending`.
DROP TABLE "blob_upload" CASCADE;
