#!/usr/bin/env bash
set -e
export PATH="/home/deuz/.bun/bin:$PATH"
export CODEX_WEB_GPT_BUN="/home/deuz/.bun/bin/bun"
export CODEX_CHATGPT_WEB_BUN="/home/deuz/.bun/bin/bun"
cd /home/deuz/projects/codex-chatgpt-web/launcher
exec bun run start -- --hidden
