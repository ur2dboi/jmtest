# MJPremium Ultimate MLM System (Next.js + PostgreSQL)

A full port of the **MJPremium Ultimate MLM System** WordPress plugin (v9.6.130) to a modern
**Next.js 15 + PostgreSQL** stack that deploys natively on **Vercel**:

- Strict Manual Placement (MA → CA → MA) with spillover enforcement (3+9 gate, Right→Right→Right)
- Hybrid point/node pairing: A+B point matching (₱200/pt), Tri-Leg releases (₱300/unit, 2× for StarPremium×StarPremium)
- GC every 5th A+B pair and every 5th Tri-Leg unit (counts inside daily limits)
- Direct Referral to the direct sponsor only (₱50 / ₱300 / ₱1,000)
- Child Account separation (CA1/CA2/CA3 are separate restricted users with their own wallets)
- Dynamic-compression Unilevel (10 tiers, ≥5 LP eligibility, optional monthly cutoff hold)
- Member portal (dashboard, genealogy tree, reports, vaults, encashment) + Admin Command Center
  (orders, encashments, pins, members, settings, batch earnings rebuild, alerts, audit logs, backup/restore, CSV/Excel exports)

All money, pairing and placement rules live in the database and are computed by the engine in
`src/lib/engine/*` — the UI never invents numbers.

---

## 1. Quick start (local)

Requirements: Node 18.18+ (20 recommended) and a PostgreSQL database (14+).

```bash
npm install
cp .env.example .env.local      # edit DATABASE_URL + AUTH_SECRET
npm run db:push                 # create tables (idempotent)
npm run db:seed                 # packages + admin + demo network (real engine run)
npm run dev                     # http://localhost:3000
```

Local Postgres in one line (Docker):

```bash
docker run --name mjpremium-db -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=mjpremium -p 5432:5432 -d postgres:16
```

### Demo accounts (seed)

| Role | Username | Password |
| --- | --- | --- |
| Admin gateway | `MJPREMIUM` | `adminMJ2026` (set via `ADMIN_PASSWORD`) |
| Members | `ana`, `ben`, `carl`, `dana`, … | `demo1234` |
| Child Account | `ana_c1` (or log in as `C1ana`) | `demo1234` |

> Change `ADMIN_PASSWORD` **before** seeding a production database, and change it again in
> **Member Directory → Edit** afterwards.

Seed options:

```bash
npm run db:seed -- --fresh     # truncate everything and re-seed
npm run db:seed -- --no-demo   # packages + admin only (clean production install)
SEED_DEMO_NETWORK=0 npm run db:seed
```

## 2. Environment variables

| Variable | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | ✅ | Postgres connection string (Supabase/Neon/Vercel Postgres/local). |
| `AUTH_SECRET` | ✅ (prod) | Signs the session JWT cookie. `openssl rand -base64 32` |
| `PGSSL` | – | `true` forces TLS (auto-detected for Supabase/Neon URLs). |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | – | Initial admin created by `db:seed`. |
| `SEED_DEMO_NETWORK` | – | `0` skips the demo members when seeding. |
| `PG_POOL_MAX`, `PG_STATEMENT_TIMEOUT` | – | Pool tuning for serverless. |

A ready-to-copy list is in [`.env.example`](./.env.example).

## 3. Deploy to Vercel (with Supabase or Neon Postgres)

Vercel cannot run PHP/MySQL — that's why this port stores everything in Postgres.

1. **Create the database**
   - **Supabase**: New project → *Settings → Database → Connection string* → use the
     **Session pooler** URL (port `5432`, host `*.pooler.supabase.com`). It supports the
     per-connection `Asia/Manila` session timezone this app sets.
   - **Neon**: New project → connection string with `-pooler` host and `?sslmode=require`.
2. **Push schema + seed** (from your machine, pointing at the cloud DB):
   ```bash
   DATABASE_URL="postgres://…cloud…" npm run db:push
   DATABASE_URL="postgres://…cloud…" ADMIN_PASSWORD="<strong-password>" npm run db:seed -- --no-demo
   ```
3. **Create the Vercel project**: `vercel link` (or import the GitHub repo in the dashboard),
   then set Environment Variables: `DATABASE_URL`, `AUTH_SECRET`, `PGSSL=true`, `ADMIN_USERNAME`.
4. **Deploy**: push to GitHub (auto-deploy) or `vercel --prod`.

No build settings to change: framework = Next.js, build = `next build`.

## 4. Push to GitHub

```bash
git init
git add .
git commit -m "MJPremium Ultimate MLM System — Next.js + Postgres port"
git branch -M main
git remote add origin https://YOUR_GITHUB_USERNAME:<YOUR_PAT>@github.com/YOUR_GITHUB_USERNAME/mjpremium-mlm.git
git push -u origin main
```

Create a token at **GitHub → Settings → Developer settings → Personal access tokens**
(classic: scope `repo`; or fine-grained: Contents read/write on the repo).

Deploy from the CLI instead (Vercel token from **vercel.com → Settings → Tokens**):

```bash
npm i -g vercel
vercel link --token <YOUR_VERCEL_TOKEN>
vercel env add DATABASE_URL production --token <YOUR_VERCEL_TOKEN>
vercel --prod --token <YOUR_VERCEL_TOKEN>
```

## 5. Project map

```
src/app/
  page.tsx                    Landing page
  member-login/               Member + Admin gateway login (C1/C2/C3 alias supported)
  member-registration/        2-step public registration wizard
  member-portal/              Member dashboard (tabs: overview, reports, genealogy,
                              encashment, package/product orders, vaults, associates, profile)
  admin-dashboard/            Admin Command Center (overview, alerts, members, orders,
                              encashments, pins, reports, genealogy, logs, comp-plan settings)
  api/auth, api/register      Login/logout, public registration
  api/member, api/admin       All portal POST actions (action-dispatched JSON APIs)
  api/admin/export|backup     CSV/Excel reports + JSON backup download
src/lib/
  engine/placement.ts         Strict placement + spillover (3+9 gate, R→R→R, validators)
  engine/pairing.ts           Point upflow, A+B matching, Tri-Leg releases, GC, flush-outs
  engine/unilevel.ts          Dynamic compression, LP, cutoff hold/release
  engine/registration.ts      Register member, CA activation, upgrades, pins, orders
  engine/encash.ts            Encashment request/approve/reject (tax + fees)
  engine/rebuild.ts           Batched earnings rebuild (5 steps, resumable)
  engine/tree.ts              Genealogy read model + admin node move
  queries.ts                  Portal/admin read models, reports, system alerts
  backup.ts                   Full JSON backup/restore (admin ID 1 preserved)
sql/schema.sql                PostgreSQL schema (idempotent)
scripts/db-push.mjs           Apply schema
scripts/db-seed.mts           Seed packages/admin/demo network
```

## 6. Compensation rules implemented

- **Ranks**: Starter (DR only, no points) · Premium (1 A/B point) · StarPremium (3 A/B points).
- **DR**: direct sponsor only; sponsor-rank capped; Starter sponsors earn 0.
- **A+B**: min(L,C) matched points × ₱200; every 5th = 1 GC instead of cash; unmatched points wait.
- **Tri-Leg**: completed A+B triggers × right-leg points (Premium member = 1 pt, StarPremium member
  = 2 pts on the C/right leg); 1 ₱300 unit, or 2 units when receiver
  **and** right-source are StarPremium; every 5th unit = 1 GC.
- **Daily caps** (GC included, reset 12:01 AM Asia/Manila): MA 15/30, CA 10/20; matched excess is
  flushed, unmatched excess stays waiting.
- **Unilevel**: sponsor-chain, CA connectors skipped, <5 LP / Starter / held uplines compressed
  out (no tier consumed); matrix L1 ₱5, L2 ₱4, L3 ₱3, L4 ₱2, L5–L10 ₱1 per activated product.
- **Encashment**: min ₱1,000, requires valid member ID (auto `MJP-YYYY-######` + expiry);
  net = gross − 10% tax − ₱20 system fee − ₱25 (Fund Transfer only).
- **Free accounts**: identical genealogy/spillover; admin flags only gate earning
  (receive pairing / count for uplines / pay DR).

Admin amounts, limits, matrix, tax/fees, cutoff & auto-approve switches are all editable in
**Admin → Comp. Plan**. After manual tree surgery, run **Start Batch Recalculate** — it replays
DR → pairing → unilevel → wallets from the persisted tree and used pins (the source of truth).

## 7. Notes

- Timezone is pinned to **Asia/Manila** at the app layer and DB session (mirrors the plugin's
  `SET time_zone = '+08:00'`); daily-cap windows therefore reset at 12:01 AM PH time anywhere.
- Sessions are signed JWTs in httpOnly cookies (12h). Passwords are bcrypt hashes — change the
  demo passwords before going live.
- `/api/health` returns DB + app status for uptime checks.
