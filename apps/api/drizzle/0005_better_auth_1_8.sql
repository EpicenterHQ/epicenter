ALTER TABLE "device_code" ADD COLUMN "reference_id" text;--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "auth_time" timestamp;--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "acr" text;--> statement-breakpoint
ALTER TABLE "device_code" ADD COLUMN "amr" text[];--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "sector_identifier" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "frontchannel_logout_uri" text;--> statement-breakpoint
ALTER TABLE "oauth_client" ADD COLUMN "frontchannel_logout_session_required" boolean;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "acr" text;--> statement-breakpoint
ALTER TABLE "oauth_refresh_token" ADD COLUMN "amr" text[];
