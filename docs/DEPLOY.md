# Deploying QuantCore Terminal (24/7 cloud trading)

The bot runs entirely server-side — once deployed, it keeps trading
even when your browser is closed. Two things make a cloud instance safe:

1. **Password gate** — `DASHBOARD_PASSWORD` env var locks the whole
   dashboard (login screen, 30-day session cookie per browser).
2. **Cloud-persisted state** — bot config + "was the bot running" live in
   your Supabase database, so they survive every restart/redeploy.

## 1. Supabase — one-time table setup

Open your Supabase project → SQL Editor → run:

```sql
create table if not exists bot_store (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
```

If `SUPABASE_KEY` is the **anon** key (not service_role), also enable
access for it (skip this if you use the service_role key):

```sql
alter table bot_store enable row level security;
create policy "bot store full access" on bot_store for all
  using (true) with check (true);
```

## 2. Deploy on Render (blueprint)

1. render.com → **New → Blueprint** → pick the `over3` GitHub repo.
2. Render reads `render.yaml` and asks for the secret values:
   - `DERIV_APP_ID` — your Deriv app id
   - `DERIV_PAT` — your Deriv API token (trades on your behalf)
   - `SUPABASE_URL` — `https://xxxx.supabase.co`
   - `SUPABASE_KEY` — anon or service_role key
   - `DASHBOARD_PASSWORD` — the dashboard login password
3. Apply → the container builds from the `Dockerfile` and starts.
4. Health check hits `/health` (open by design — it exposes no data).

> Free plan note: Render sleeps idle instances; keep your existing
> keep-alive pinger pointed at the app URL. State is safe regardless —
> even a full redeploy restores config and auto-resumes the bot from
> Supabase (`☁️ Cloud store says the bot was ACTIVE` in the logs).

## 3. After deploy

- Open the URL → login screen → enter your password (once per browser,
  30 days).
- Settings → confirm TP/SL/stake etc. — they now persist in the cloud.
- Start the bot. If Render ever restarts the container, the bot
  auto-resumes trading on boot as long as `BOT_AUTO_RESUME` is set.

## Changing the password

Change the `DASHBOARD_PASSWORD` env var in the Render dashboard and
redeploy — all existing browser sessions are invalidated instantly.

## Troubleshooting

- `☁️ Cloud state sync skipped: relation "bot_store" does not exist`
  → run the SQL from step 1.
- Login loop / instantly logged out → cookies must be enabled; the
  cookie is `HttpOnly` + `SameSite=Lax`.
