-- The hosted cloud's resources and first-party clients (ADR-0549), as
-- apps/api/worker/oauth-registrations.ts declares them for https://api.epicenter.so.
-- oauth-registrations.postgres.test.ts fails when the two drift. Resources are
-- insert-only, like the provider's resourceSeedMode; another origin (the Bun
-- entry) writes its own registrations at boot.
INSERT INTO "oauth_resource" ("id", "identifier", "name", "access_token_ttl", "allowed_scopes", "created_at", "updated_at") VALUES
	('https://api.epicenter.so', 'https://api.epicenter.so', 'https://api.epicenter.so', 28800, ARRAY['openid', 'offline_access', 'ai', 'profile', 'folders:read'], now(), now()),
	('https://git.epicenter.so', 'https://git.epicenter.so', 'https://git.epicenter.so', 28800, ARRAY['openid', 'offline_access', 'folders:read', 'folders:write'], now(), now()),
	('https://mcp.epicenter.so/mcp', 'https://mcp.epicenter.so/mcp', 'https://mcp.epicenter.so/mcp', 28800, ARRAY['openid', 'offline_access', 'folders:read', 'folders:write'], now(), now())
ON CONFLICT ("identifier") DO NOTHING;
--> statement-breakpoint
INSERT INTO "oauth_client" ("id", "client_id", "name", "redirect_uris", "grant_types", "response_types", "scopes", "skip_consent", "application_type", "token_endpoint_auth_method", "require_pkce", "disabled", "created_at", "updated_at") VALUES
	('so.epicenter.todos', 'so.epicenter.todos', 'Todos', ARRAY['https://todos.epicenter.so/auth/callback'], ARRAY['authorization_code'], ARRAY['code'], ARRAY['openid', 'profile', 'ai', 'folders:read', 'folders:write'], true, 'web', 'none', true, false, now(), now()),
	('so.epicenter.whispering', 'so.epicenter.whispering', 'Whispering', ARRAY['https://whispering.epicenter.so/auth/callback'], ARRAY['authorization_code'], ARRAY['code'], ARRAY['openid', 'profile', 'ai', 'folders:read', 'folders:write'], true, 'web', 'none', true, false, now(), now()),
	('so.epicenter.honeycrisp', 'so.epicenter.honeycrisp', 'Honeycrisp', ARRAY['https://honeycrisp.epicenter.so/auth/callback'], ARRAY['authorization_code'], ARRAY['code'], ARRAY['openid', 'profile', 'ai', 'folders:read', 'folders:write'], true, 'web', 'none', true, false, now(), now()),
	('so.epicenter.capture', 'so.epicenter.capture', 'Capture', ARRAY['https://capture.epicenter.so/auth/callback'], ARRAY['authorization_code'], ARRAY['code'], ARRAY['openid', 'profile', 'ai', 'folders:read', 'folders:write'], true, 'web', 'none', true, false, now(), now()),
	('so.epicenter.vocab', 'so.epicenter.vocab', 'Vocab', ARRAY['https://vocab.epicenter.so/auth/callback'], ARRAY['authorization_code'], ARRAY['code'], ARRAY['openid', 'profile', 'ai', 'folders:read', 'folders:write'], true, 'web', 'none', true, false, now(), now()),
	('com.bradenwong.zhongwen', 'com.bradenwong.zhongwen', 'Zhongwen', ARRAY['https://zhongwen.bradenwong.com/auth/callback'], ARRAY['authorization_code'], ARRAY['code'], ARRAY['openid', 'profile', 'ai', 'folders:read', 'folders:write'], true, 'web', 'none', true, false, now(), now()),
	('so.epicenter', 'so.epicenter', 'Epicenter', ARRAY['http://127.0.0.1/callback'], ARRAY['authorization_code', 'refresh_token'], ARRAY['code'], ARRAY['openid', 'offline_access', 'profile', 'ai', 'folders:read', 'folders:write'], true, 'native', 'none', true, false, now(), now()),
	('so.epicenter.cli', 'so.epicenter.cli', 'Epicenter CLI', '{}'::text[], ARRAY['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'], '{}'::text[], ARRAY['openid', 'offline_access', 'profile', 'ai', 'folders:read', 'folders:write'], false, 'native', 'none', true, false, now(), now())
ON CONFLICT ("client_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "oauth_client_resource" ("id", "client_id", "resource_id", "created_at") VALUES
	('so.epicenter.todos https://api.epicenter.so', 'so.epicenter.todos', 'https://api.epicenter.so', now()),
	('so.epicenter.todos https://git.epicenter.so', 'so.epicenter.todos', 'https://git.epicenter.so', now()),
	('so.epicenter.whispering https://api.epicenter.so', 'so.epicenter.whispering', 'https://api.epicenter.so', now()),
	('so.epicenter.whispering https://git.epicenter.so', 'so.epicenter.whispering', 'https://git.epicenter.so', now()),
	('so.epicenter.honeycrisp https://api.epicenter.so', 'so.epicenter.honeycrisp', 'https://api.epicenter.so', now()),
	('so.epicenter.honeycrisp https://git.epicenter.so', 'so.epicenter.honeycrisp', 'https://git.epicenter.so', now()),
	('so.epicenter.capture https://api.epicenter.so', 'so.epicenter.capture', 'https://api.epicenter.so', now()),
	('so.epicenter.capture https://git.epicenter.so', 'so.epicenter.capture', 'https://git.epicenter.so', now()),
	('so.epicenter.vocab https://api.epicenter.so', 'so.epicenter.vocab', 'https://api.epicenter.so', now()),
	('so.epicenter.vocab https://git.epicenter.so', 'so.epicenter.vocab', 'https://git.epicenter.so', now()),
	('com.bradenwong.zhongwen https://api.epicenter.so', 'com.bradenwong.zhongwen', 'https://api.epicenter.so', now()),
	('com.bradenwong.zhongwen https://git.epicenter.so', 'com.bradenwong.zhongwen', 'https://git.epicenter.so', now()),
	('so.epicenter https://api.epicenter.so', 'so.epicenter', 'https://api.epicenter.so', now()),
	('so.epicenter https://git.epicenter.so', 'so.epicenter', 'https://git.epicenter.so', now()),
	('so.epicenter.cli https://api.epicenter.so', 'so.epicenter.cli', 'https://api.epicenter.so', now()),
	('so.epicenter.cli https://git.epicenter.so', 'so.epicenter.cli', 'https://git.epicenter.so', now())
ON CONFLICT DO NOTHING;
