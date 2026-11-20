-- Run in Supabase SQL editor. Server uses service role; never give browsers direct access.
create extension if not exists pgcrypto;
create table if not exists public.payment_requests (
  id uuid primary key default gen_random_uuid(),
  customer_email text not null,
  customer_name text not null default '',
  description text not null,
  amount_cents integer not null check (amount_cents between 100 and 100000000),
  currency text not null default 'USD' check (currency = 'USD'),
  status text not null default 'unpaid' check (status in ('unpaid','awaiting_payment','awaiting_bank_transfer','paid')),
  method text check (method in ('card','crypto','bank')),
  provider_reference text unique,
  checkout_url text,
  bank_reference text,
  created_at timestamptz not null default now(),
  verified_at timestamptz
);
create index if not exists payment_requests_created_at_idx on public.payment_requests(created_at desc);
alter table public.payment_requests enable row level security;
-- Intentionally no anon/authenticated policies. Only the server service role can query rows.
