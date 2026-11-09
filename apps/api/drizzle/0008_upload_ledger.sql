CREATE TABLE "blob_upload" (
	"repository_id" text NOT NULL,
	"oid" text NOT NULL,
	"uploaded_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "blob_upload_repository_id_oid_pk" PRIMARY KEY("repository_id","oid"),
	CONSTRAINT "blob_upload_oid_format" CHECK ("blob_upload"."oid" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "blob_upload" ADD CONSTRAINT "blob_upload_repository_id_repository_id_fk" FOREIGN KEY ("repository_id") REFERENCES "public"."repository"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "blob_upload_uploaded_at_idx" ON "blob_upload" USING btree ("uploaded_at");