#!/usr/bin/env bash
# Introspect the SHAPE of your Infisical secrets across environments — NAMES ONLY,
# values are never printed. Walks each /apps/<name> path per env (export does NOT
# recurse and defaults to "/"), builds a name × env matrix per app path.
#
# Run from a GUI terminal where `infisical` can reach the macOS keychain, from
# inside the repo (so it can read apps/* names). Edit ENVS if your slugs differ.
set -uo pipefail
ENVS=("dev" "staging" "prod")   # <-- adjust to your Infisical env slugs
REPO_APPS_DIR="$(cd "$(dirname "$0")/../apps" 2>/dev/null && pwd || echo apps)"
OUT="$(mktemp -d)"

# Candidate secret paths: /apps root + one per apps/<name> directory.
PATHS=("/apps")
for d in "$REPO_APPS_DIR"/*/; do
  [ -d "$d" ] && PATHS+=("/apps/$(basename "$d")")
done
echo "Scanning ${#PATHS[@]} paths across envs: ${ENVS[*]}"

for E in "${ENVS[@]}"; do
  : > "$OUT/$E.tsv"
  for P in "${PATHS[@]}"; do
    infisical export --env="$E" --path="$P" --format=json 2>/dev/null \
      | python3 -c '
import sys, json
try: d = json.load(sys.stdin)
except Exception: d = []
items = d if isinstance(d, list) else d.get("secrets", [])
p = sys.argv[1]
for it in items:
    if not isinstance(it, dict): continue
    key = it.get("secretKey") or it.get("key") or it.get("name")
    path = it.get("secretPath") or p          # prefer real path, fall back to the queried one
    if key: print(f"{path}\t{key}")
' "$P" >> "$OUT/$E.tsv"
  done
  echo "  env=$E: $(wc -l < "$OUT/$E.tsv" | tr -d ' ') secret entries"
done

python3 - "$OUT" "${ENVS[@]}" <<'PY'
import sys, os
out_dir = sys.argv[1]; envs = sys.argv[2:]
matrix = {}   # matrix[path][key] = set(envs)
for e in envs:
    f = os.path.join(out_dir, f"{e}.tsv")
    if not os.path.exists(f): continue
    for line in open(f):
        line = line.rstrip("\n")
        if not line or "\t" not in line: continue
        path, key = line.split("\t", 1)
        matrix.setdefault(path, {}).setdefault(key, set()).add(e)

def tag(key):
    k = key.upper()
    for m in ("SANDBOX","PRODUCTION","PROD","DEVELOPMENT","DEV","STAGING","TEST"):
        if m in k: return f"  <- env-qualified ({m})"
    return ""

if not matrix:
    print("\n(no secrets found — check ENVS slugs and that you're logged in / have access)")
print("\n============ SECRET NAME × ENV MATRIX (values redacted) ============")
for path in sorted(matrix):
    print(f"\n{path}")
    keys = matrix[path]; w = max((len(k) for k in keys), default=8)
    for key in sorted(keys):
        present = matrix[path][key]
        cols = " ".join((f"{e}:{'Y' if e in present else '-'}") for e in envs)
        amb = "  !! same-name-across-envs" if len(present) > 1 and not tag(key) else ""
        print(f"  {key.ljust(w)}  {cols}{tag(key)}{amb}")
print("\nLegend: Y present, - absent | '!!' = same name in >1 env (the ambiguous pattern)")
print("Design goal: the APP's target-env flag picks the credential, not the human's --env choice.")
PY
rm -rf "$OUT"
