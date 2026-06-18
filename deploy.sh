#!/usr/bin/env bash
# Deploy the Vercel function, passing secrets from the local .env as per-deploy
# runtime env vars. Pass --prod to promote to production.
#   bash deploy.sh           # preview
#   bash deploy.sh --prod    # production
set -euo pipefail
cd "$(dirname "$0")"

ENV_FILE="${ENV_FILE:-.env}"
if [ -f "$ENV_FILE" ]; then set -a; source "$ENV_FILE"; set +a; fi

# Refuse to promote a localhost (or unset) auth URL to production — GitHub OAuth
# would reject the redirect_uri against the prod callback registered on GitHub.
case " $* " in
  *" --prod "*)
    case "${BETTER_AUTH_URL:-}" in
      "" | *localhost* | *127.0.0.1*)
        echo "deploy: refusing --prod — BETTER_AUTH_URL is '${BETTER_AUTH_URL:-<unset>}'; set it to the production origin in $ENV_FILE" >&2
        exit 1 ;;
    esac ;;
esac

ENV_ARGS=()
for k in ARCHIL_API_KEY ARCHIL_REGION ARCHIL_DISK ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN CC_WORKSPACE \
         BETTER_AUTH_SECRET BETTER_AUTH_URL GITHUB_CLIENT_ID GITHUB_CLIENT_SECRET DATABASE_URL; do
  v="${!k:-}"
  [ -n "$v" ] && ENV_ARGS+=(--env "$k=$v")
done

exec vc deploy --yes "$@" "${ENV_ARGS[@]}"
