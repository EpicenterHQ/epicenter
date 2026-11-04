-- A repository is never renamed or moved (ADR-0771), so no old
-- <namespace>/<name> resolves to one through an alias.
DROP TABLE "repository_alias" CASCADE;
