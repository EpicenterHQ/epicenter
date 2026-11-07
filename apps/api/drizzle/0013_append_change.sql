-- A folder's write appends a change (ADR-0828): the function keeps its body
-- and takes the name its route and callers use.
ALTER FUNCTION "epicenter_commit"(text, text, text, jsonb, jsonb) RENAME TO "epicenter_append_change";
