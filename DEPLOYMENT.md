# Deployment — Cloud, Self-Hosted, Desktop

One codebase, three editions. The differences are configuration, not forks — which is only true because storage sits behind one interface and the server has no cloud-specific dependencies.

| Edition | Storage | Tenancy | Entry point |
| --- | --- | --- | --- |
| **Cloud** | Postgres | `MULTI_TENANT=true` | `docker compose` / your orchestrator |
| **Self-hosted (Enterprise)** | Postgres or SQLite | single by default | `docker compose up -d` |
| **Desktop** | SQLite in app-data | single | Tauri shell + Node sidecar (`desktop/`) |

---

## Self-hosted

```bash
cp .env.example .env
# Required: JWT_SECRET (>=32 random chars) and POSTGRES_PASSWORD
#   openssl rand -hex 32

docker compose up -d
docker compose logs -f app
```

The image is multi-stage: the build toolchain and dev dependencies do not reach the runtime layer, it runs as the unprivileged `node` user, and `tini` forwards SIGTERM so the graceful shutdown path actually runs.

**The healthcheck is not just a port check.** It hits `/api/health`, which verifies every tenant's audit chain and reports `degraded` when a chain is broken or settlement is halted. An orchestrator watching it will notice database tampering, not merely a dead process.

### Single tenant is the default

Self-hosted deployments are one organisation. `MULTI_TENANT` stays `false`, everyone joins the default tenant, and tenancy costs you one column. Set it to `true` only if you are reselling to separate customers out of one deployment.

### What I verified, and what I did not

I could not run a container build here — there is a Docker CLI but no daemon. So rather than shipping an unexercised Dockerfile, I validated the substance underneath it: a clean tree, `npm ci`, `npm run build`, then booting against Postgres in production mode. That worked, and the tenancy probe passed 15/15 against it.

**The Dockerfile itself has not been built.** The commands inside it have.

That exercise found something worth knowing:

> `better-sqlite3` compiles a native addon. In an environment that cannot reach the Node headers host, `npm ci` failed and took the whole install with it — which in a container build means an image that cannot be produced at all, from a transient network fault.

It is now an **optional dependency**, loaded lazily and only when SQLite is actually selected. If the compile fails, npm carries on and the image ships without the SQLite driver — a supported configuration, because it runs on Postgres. I confirmed this by building and booting a tree where `better-sqlite3` genuinely failed to install; the app started on Postgres and passed the full isolation probe.

One trap worth recording: `--omit=optional` looks like the tidy fix and is wrong. It also drops Rollup's native binary and breaks the client build.

---

## Cloud

Same image. Differences:

```bash
MULTI_TENANT=true
DATABASE_URL=postgres://…        # managed Postgres, not a container
JWT_SECRET=…                     # from your secret manager, not .env
```

Before running more than one instance:

- **Rate limits and the kill switch are per-process and in-memory.** Two instances means two independent limiters and a halt that only stops one of them. Move both to Redis before scaling out. This is the sharpest edge in the current build.
- **Asset runtimes are per-tenant and per-process.** Two instances means two reconciliation loops over the same book. Either pin settlement to one instance or take a distributed lock before scaling that path.
- Postgres already handles concurrent audit appends correctly (exclusive table lock), so the chain is safe across instances.

Read-only web traffic scales horizontally today. The settlement path does not, yet, and it is better to know that than to find out.

---

## Desktop

See `desktop/README.md`. It is a scaffold with an honest checklist, not a shipped binary — no GUI toolchain or signing certificates existed here. The architecture needs no changes to `server/` or `src/`; the remaining work is Node sidecar bundling, code signing, and auto-update, and I would start signing first because it has the longest lead time.

---

## Upgrading an existing installation

The schema is created with `CREATE TABLE IF NOT EXISTS`, which does nothing to a table that already exists. A pre-tenancy database would therefore boot "successfully" and fail on the first query with `column "tenant_id" does not exist`.

`server/store/migrate.ts` handles this: it detects the old layout, renames the legacy tables aside, builds the current schema, and copies the data in stamped with the default tenant. It is idempotent, and the `_pre_tenancy` tables are **kept**, not dropped — deleting a customer's only copy of their data to reclaim a few megabytes is a bad trade. Drop them yourself once you are satisfied.

`tests/migration.test.ts` builds a genuine pre-tenancy database and upgrades it, asserting every row survives including the marketplace fill cursor.

I found this the way you would rather not: a leftover Postgres test database failed while a fresh SQLite one passed. Same code, different history — the exact shape of a bad deploy.

---

## The app is not a website

`robots.txt` disallows everything and the SPA carries `noindex, nofollow`. That is deliberate.

Marketing pages belong on a **separate host** with their own robots policy. Indexing an application host is how staging environments, customer subdomains and password-reset URLs end up in search results — and for a multi-tenant product, tenant names in a search index are a disclosure problem, not just untidy.

---

## Pre-flight checklist

- [ ] `JWT_SECRET` set, ≥32 random characters, from a secret manager
- [ ] `ENABLE_DEMO_USERS` **unset** — seeded credentials in production are how demo logins become breaches
- [ ] `DATABASE_URL` pointing at managed Postgres with backups you have restored at least once
- [ ] TLS terminated upstream; `secure` cookies require HTTPS
- [ ] `npm run preflight` clean — in particular the marketplace blocker, which fires if anything other than the internal marketplace is active
- [ ] Health endpoint wired to alerting, including the `degraded` state
- [ ] `npm run verify:tenancy` run against the deployment if `MULTI_TENANT=true`

---

## Render (the closed-beta target)

Orion Prime already runs on Render, so Apex Atlas goes beside it. `render.yaml`
is the whole deployment — connect the repo, Render reads the blueprint, you
approve what it proposes.

```
Blueprint      render.yaml
Runtime        docker (the same multi-stage image as self-hosted)
Database       managed Postgres, private (ipAllowList: [])
Health check   /api/health
```

**Postgres is not optional here.** Render's filesystem is ephemeral, so an
Apex on SQLite silently discards its database on every deploy — the accounts,
the ledger and the audit chain all vanish and the app comes back looking fine.
The blueprint wires `DATABASE_URL` from the managed instance for exactly this
reason.

**Neither plan is the free one, deliberately.** Free Postgres is deleted after
30 days, which on a closed beta is a scheduled data loss with real users
attached. Free web services sleep after 15 minutes idle, and an invited tester
who meets a 50-second cold start concludes the product is broken.

### Secrets

Nothing sensitive is in the blueprint. `JWT_SECRET` is generated by Render;
everything else is `sync: false`, which means Render prompts you once in the
dashboard and never writes it to the repo.

Two are deliberately absent rather than empty:

- **`ADMIN_API_TOKEN`** — unset means `/api/admin/invites` is not mounted at
  all. It prints invite codes, which makes it the highest-value target on a free
  beta. Mint from a shell: `npm run invite -- mint --label "someone@example.com"`
- **`ENABLE_DEMO_USERS`** — preflight blocks if it is set. Seeded credentials in
  a live deployment are how demo logins become breaches.

### Before you send anyone the URL

```bash
npm run preflight -- https://<your-render-url>
```

It answers a different question from the health check: not "is it up" but "is it
safe to put people on". Verified on the production bundle of this build —
**14 passed, 3 warnings, 0 blockers**. The warnings are business readiness
(no billing, single instance, SQLite locally), not safety; the SQLite one
disappears on Render because the blueprint uses Postgres.
