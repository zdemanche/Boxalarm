# PENDING LAND — full architecture.md not yet applied

**Do not merge.** Canonical file is ready but exceeds MCP upload size (~311KB).

- Expected size: **310943** bytes
- Expected sha256: `bf82b5634184aa43b430eb5b6923c87e7d667147875eaf51836b734b56e964fa`
- Expected: no `FanOut --> VoiceQ`; `Endpoint count: 83` / `89 across 10`
- Hosted: `zdemanche/boxalarm-backend` `tmp-host/architecture-merged.md` (main)
- Also: https://litter.catbox.moe/y77pe6.md
- In-repo: `docs/patches/n3-n5-n9-and-119.patch.gz.b64` + `docs/patches/APPLY.md`

**Unblock (any one):**
1. Set `BOXALARM_DOCS_TOKEN` on boxalarm-backend → re-run `land-docs-arch.yml`
2. Add `boxalarm-docs` to Cursor GitHub App installation
3. Authorize device flow / Composio GitHub when agent posts a fresh code
4. Locally: download from backend host path → `docs/architecture.md` && git add/commit/push
