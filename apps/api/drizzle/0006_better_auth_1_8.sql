ALTER TABLE "device_code" ADD COLUMN "reference_id" text;--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "auth_time" timestamp;--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "acr" text;--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "amr" text[];--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "sector_identifier" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "frontchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "frontchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "acr" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "amr" text[];--> statement-breakpoint
-- Every first-party audience allows every scope (ADR-0565), so a refresh never
-- narrows the grant. The first-party audiences are the ones so.epicenter.cli
-- links to, in every deployment: api and git, never mcp.
UPDATE "oauth_resource" SET "allowed_scopes" = ARRAY['openid', 'offline_access', 'profile', 'ai', 'folders:read', 'folders:write'], "updated_at" = now()
WHERE "identifier" IN (SELECT "resource_id" FROM "oauth_client_resource" WHERE "client_id" = 'so.epicenter.cli');
