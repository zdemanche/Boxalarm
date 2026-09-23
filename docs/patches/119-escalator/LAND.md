## How to land #119 + #120 (N-3/N-5/N-9)

MCP Contents uploads from this cloud agent truncate around ~4KB per tool-call argument, so `docs/architecture.md` (~308KB) cannot be replaced in one shot without a write token.

### Authoritative fixed file (already hosted)

```bash
gh api -H "Accept: application/vnd.github.raw" \
  "repos/zdemanche/boxalarm-backend/contents/tmp-host/architecture-merged.md?ref=cursor/temp-arch-host-cec6" \
  > docs/architecture.md
git add docs/architecture.md
git commit -m "docs(#119,#120): Escalator voice-only; remove FanOut→VoiceQ; land N-3/N-5/N-9"
git push
```

Or apply the unified patch from the same host path: `tmp-host/n3-n5-n9-and-119.patch`.

### Invariants after land

- `FanOut --> PushQ` and `FanOut --> SmsQ` (parallel primary)
- **No** `FanOut --> VoiceQ` (voice is escalator-only)
- Escalator: single edge to `VoiceQ`, gated on no ack across push **AND** sms
- N-3/N-5/N-9 applied; endpoint count **83** / **89 across 10**
