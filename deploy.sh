#!/usr/bin/env bash
# Deploy the Vercel function, passing secrets from the local .env as per-deploy
# runtime env vars. Pass --prod to promote to production.
#   bash deploy.sh           # preview
#   bash deploy.sh --prod    # production
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then set -a; source "$ENV_FILE"; set +a; fi

ENV_ARGS=()
for k in ARCHIL_API_KEY ARCHIL_REGION ARCHIL_DISK ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CC_WORKSPACE; do
  v="${!k:-}"
  [ -n "$v" ] && ENV_ARGS+=(--env "$k=$v")
done

exec vc deploy --yes "$@" "${ENV_ARGS[@]}"
