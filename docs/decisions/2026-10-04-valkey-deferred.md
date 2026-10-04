# 2026-10-04: ElastiCache Serverless Valkey — deferred, not built (#238 / #256)

**Scope:** residual infra ticket `docs/handoff/tickets/RESIDUAL-2026-10-04.md`, Bundle C, row
"`#238 / #256` — Valkey (ElastiCache Serverless) + VPC for LOB config/schema-version cache —
only if client wiring lands with it."

**Decision: deferred. No ElastiCache Valkey cluster, no VPC, no client wiring is added in this
pass.** `DEPARTMENT_CONFIG` reads (platform-service) and `SCHEMA_VERSION` reads
(incident-service) continue to go straight to DynamoDB, exactly as they do today.

## Why this isn't a new question

The architecture document already flags this exact tradeoff as unresolved, on cost grounds, not
on a missing implementation:

> ElastiCache Serverless has a per-cache minimum footprint/charge that doesn't scale down to
> zero — at this department's read-mostly, near-static config-caching workload
> (`DEPARTMENT_CONFIG`, `SCHEMA_VERSION`), this floor cost is plausibly larger than everything
> else on this list *combined*. [...] Recorded here as a cost-driven follow-on question, not
> resolved.
> — `docs/architecture.md:1558`

This pass does not resolve that question. It confirms the decision is still "no" and records why,
so the next pass doesn't re-litigate it from scratch.

## What "added cleanly" would actually require

This residual ticket's own instruction was conditional: add Valkey "if ... [it] can be added
cleanly using Pulumi skills WITHOUT putting any alerting Lambda in a VPC." Checking that
condition against the current codebase:

- **There is no VPC anywhere in this infrastructure today** (`rg "aws.ec2.Vpc"` across
  `infrastructure/` returns nothing). Every Lambda in every service is VPC-less by design
  (`docs/architecture.md:2725`: "a deliberate serverless choice that avoids ENI cold-start
  latency"). Adding Valkey is not "attach an existing VPC" — it is standing up a VPC, subnets
  across at least two AZs (ElastiCache Serverless requires multi-AZ subnet placement), security
  groups, and DynamoDB/S3 gateway endpoints (so the now-VPC'd LOB Lambdas don't lose their
  existing public-endpoint DynamoDB/S3 access) from nothing.
- **Every LOB Lambda that would read the cache needs `VpcConfig` added**, which is itself the
  ENI cold-start cost the architecture's serverless posture was chosen to avoid everywhere else.
  Isolating that cost to "LOB-only, never alerting" is achievable (no alerting-service Lambda
  reads `DEPARTMENT_CONFIG`/`SCHEMA_VERSION` through this path), but it is still a new, permanent
  cold-start tax on every platform-service and incident-service request that touches config or
  schema-version lookups — the two hottest, most request-frequent LOB reads in the system.
- **The cached data is two read-mostly, near-static datasets** (`DEPARTMENT_CONFIG`,
  `SCHEMA_VERSION`) at single-tenant (`DEPT#NICHOLS`) scale. A managed, multi-AZ cache cluster is
  a lot of new infrastructure — and a new ongoing bill — to front two small, slow-changing
  reference tables for one department.

None of this is "clean." It is a multi-resource, net-new infrastructure subsystem (VPC + subnets
+ security groups + gateway endpoints + the cache cluster itself + a VpcConfig retrofit on every
affected Lambda) in service of a cache whose own architecture entry already calls its cost
"plausibly larger than everything else [in the AWS cost table] combined." That is the "cost/
complexity is high" condition this ticket said to defer on.

## What this department's workload actually needs

The architecture document names the alternative it already prefers for this case:

> ...versus, say, Lambda-execution-environment-local caching (free, and `DEPARTMENT_CONFIG`'s own
> "read-mostly, near-static" framing at `:1250` tolerates it).
> — `docs/architecture.md:1558`

A process-local (in-memory, per execution environment) cache inside the existing
`getRetentionConfig`-style repository functions — or a shared `@boxalarm` helper if more than one
service wants the pattern — gets most of the latency benefit Valkey would have provided for these
two datasets, at zero infrastructure cost and zero new failure mode, without touching the
"alerting Lambdas never in a VPC" invariant at all because there is no VPC to reason about. It was
out of scope to build in this pass (this ticket's instruction was to decide on Valkey, not design
its replacement), but it is the direction a future pass should take if `DEPARTMENT_CONFIG` or
`SCHEMA_VERSION` read latency or DynamoDB read-cost ever actually becomes a problem at this
department's volume.

## Revisit when

- A second department (multi-tenant) materially increases `DEPARTMENT_CONFIG`/`SCHEMA_VERSION`
  read volume such that DynamoDB read cost or latency is a measured problem, not a theoretical
  one — at which point the ElastiCache Serverless floor cost is spread across more tenants and
  the math in `docs/architecture.md:1558` may no longer hold.
- Some other LOB-plane feature already needs a VPC for an unrelated reason (e.g. a future
  third-party integration requiring a fixed egress IP via NAT Gateway) — at which point the VPC
  buildout cost is already paid and adding Valkey behind it is comparatively cheap.
- Someone actually measures `DEPARTMENT_CONFIG`/`SCHEMA_VERSION` GetItem latency or cost at
  production volume and it is a real, not hypothetical, problem.
