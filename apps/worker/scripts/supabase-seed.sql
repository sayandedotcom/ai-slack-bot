-- Stand-in product data for the firefighter's `supabase.*` capability.
--
-- WHY THIS EXISTS: the Supabase project Zellify handed over (2026-08-12) has no
-- tables in `public`, so the reader answers nothing. Until we are pointed at the
-- real prod project, this seeds a small web2app-shaped schema in a project WE
-- own so the read path can be demonstrated end to end. It is a stand-in; say so
-- in any demo. It must mirror `apps/worker/src/supabase/allowlist.ts` exactly —
-- the allowlist is what the agent can see, this is what exists.
--
-- HOW TO RUN: Supabase dashboard → SQL Editor → paste → Run. Then copy the
-- project URL and the PUBLISHABLE (anon) key into `.dev.vars` as SUPABASE_URL /
-- SUPABASE_KEY. Never the secret key: RLS below is what makes the read
-- read-only, and the secret key bypasses RLS.
--
-- Tenant column is `customer_slug` on every table. The reader injects
-- `customer_slug=eq.<channel's customer_slug>` server-side on every select, so
-- the values here must match the slugs in the D1 `channels` table
-- (`sidehop`, `firedrill` in prod as of 2026-08-16).

create extension if not exists pgcrypto;

drop table if exists public.builds;
drop table if exists public.apps;
drop table if exists public.accounts;

create table public.accounts (
  id            uuid primary key default gen_random_uuid(),
  customer_slug text not null,
  company       text not null,
  plan          text not null,          -- starter | growth | scale
  status        text not null,          -- active | past_due | cancelled
  created_at    timestamptz not null default now()
);

create table public.apps (
  id            uuid primary key default gen_random_uuid(),
  customer_slug text not null,
  name          text not null,
  platform      text not null,          -- ios | android
  bundle_id     text not null,
  status        text not null,          -- draft | building | ready | broken
  store_status  text not null,          -- not_submitted | in_review | live | rejected
  updated_at    timestamptz not null default now()
);

create table public.builds (
  id            uuid primary key default gen_random_uuid(),
  customer_slug text not null,
  app_id        uuid not null references public.apps(id),
  version       text not null,
  platform      text not null,
  status        text not null,          -- queued | running | succeeded | failed
  error         text,
  started_at    timestamptz not null,
  finished_at   timestamptz
);

-- Read-only for the publishable key: SELECT policies only, writes have no
-- policy and are therefore denied. The explicit revoke is belt-and-braces.
alter table public.accounts enable row level security;
alter table public.apps     enable row level security;
alter table public.builds   enable row level security;
create policy "agent read" on public.accounts for select to anon using (true);
create policy "agent read" on public.apps     for select to anon using (true);
create policy "agent read" on public.builds   for select to anon using (true);
revoke insert, update, delete on all tables in schema public from anon, authenticated;

-- sidehop: a healthy growth customer with one flaky Android build.
insert into public.accounts (customer_slug, company, plan, status, created_at) values
  ('sidehop',   'Sidehop',        'growth',  'active',   now() - interval '140 days'),
  ('firedrill', 'Firedrill Test', 'starter', 'past_due', now() - interval '12 days');

insert into public.apps (id, customer_slug, name, platform, bundle_id, status, store_status, updated_at) values
  ('11111111-1111-4111-8111-111111111111', 'sidehop',   'Sidehop',        'ios',     'app.sidehop.ios',     'ready',  'live',          now() - interval '3 days'),
  ('22222222-2222-4222-8222-222222222222', 'sidehop',   'Sidehop',        'android', 'app.sidehop.android', 'broken', 'in_review',     now() - interval '6 hours'),
  ('33333333-3333-4333-8333-333333333333', 'firedrill', 'Firedrill Demo', 'ios',     'com.firedrill.demo',  'broken', 'not_submitted', now() - interval '40 minutes');

insert into public.builds (customer_slug, app_id, version, platform, status, error, started_at, finished_at) values
  ('sidehop',   '11111111-1111-4111-8111-111111111111', '2.4.0', 'ios',     'succeeded', null, now() - interval '3 days',      now() - interval '3 days' + interval '11 minutes'),
  ('sidehop',   '22222222-2222-4222-8222-222222222222', '2.4.0', 'android', 'succeeded', null, now() - interval '3 days',      now() - interval '3 days' + interval '9 minutes'),
  ('sidehop',   '22222222-2222-4222-8222-222222222222', '2.4.1', 'android', 'failed',
     'Gradle: Execution failed for task '':app:processReleaseResources'' — resource mipmap/ic_launcher (1024x1024) missing from uploaded assets',
     now() - interval '6 hours', now() - interval '6 hours' + interval '4 minutes'),
  ('firedrill', '33333333-3333-4333-8333-333333333333', '0.1.0', 'ios',     'failed',
     'xcodebuild: Provisioning profile "Firedrill Demo Distribution" expired on 2026-08-01; no valid profile for com.firedrill.demo',
     now() - interval '40 minutes', now() - interval '38 minutes'),
  ('firedrill', '33333333-3333-4333-8333-333333333333', '0.1.0', 'ios',     'queued',    null, now() - interval '2 minutes', null);
