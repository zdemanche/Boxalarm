# Land N-3 / N-5 / N-9 (+ #119 FanOut fix) into `docs/architecture.md`

Decisions are already on `main` (`docs/decisions/N-3-N-5-N-9.md`). This branch carries the unified patch; **architecture.md still matches main until the land step below runs**.

## One-shot (preferred)

```bash
gh api -H "Accept: application/vnd.github.raw" \
  "repos/zdemanche/boxalarm-backend/contents/tmp-host/architecture-merged.md?ref=cursor/temp-arch-host-cec6" \
  > docs/architecture.md
sha256sum docs/architecture.md
# expect bf82b5634184aa43b430eb5b6923c87e7d667147875eaf51836b734b56e964fa (310943 bytes)
git add docs/architecture.md
git commit -m "docs: rebase N-3/N-5/N-9 decisions onto main"
git push
```

## From in-repo patch artifact

```bash
base64 -d docs/patches/n3-n5-n9-and-119.patch.gz.b64 | gunzip > /tmp/n3.patch
git show origin/main:docs/architecture.md > docs/architecture.md   # if needed
patch -p1 < /tmp/n3.patch
```

## Verify

- `Endpoint count: 83` / `89 across 10`
- no `FanOut --> VoiceQ`
- `training.expiry.due`, `inventory.expiry.due`, `alerting.dispatch.received`
- no personnel `losap/year-end` row; reporting owns year-end
