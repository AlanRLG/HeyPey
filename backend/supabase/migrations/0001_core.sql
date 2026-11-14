-- 0001_core.sql — esquema base del Copiloto Acústico Zero-UI (Nivel 1, MockProvider)
-- Los montos van en centavos enteros. El servidor (Edge Functions con service_role) es
-- el único que escribe órdenes; los clientes solo leen lo que RLS permite.

create extension if not exists pgcrypto;

create table merchants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null unique references auth.users (id) on delete cascade,
  display_name  text not null,
  created_at    timestamptz not null default now()
);

create table stalls (
  id                   uuid primary key default gen_random_uuid(),
  merchant_id          uuid not null references merchants (id) on delete cascade,
  name                 text not null,
  market               text,
  provider             text not null default 'mock' check (provider in ('mock', 'pey')),
  provider_account_ref text,
  public_announce      boolean not null default true,
  created_at           timestamptz not null default now()
);
create index stalls_merchant_idx on stalls (merchant_id);

create table catalog_items (
  id           uuid primary key default gen_random_uuid(),
  stall_id     uuid not null references stalls (id) on delete cascade,
  name         text not null,
  aliases      text[] not null default '{}',
  unit         text not null default 'pza',
  price_cents  bigint not null check (price_cents >= 0),
  active       boolean not null default true,
  created_at   timestamptz not null default now(),
  unique (stall_id, name)
);

create table secret_words (
  id      serial primary key,
  word    text not null unique,     -- sin acentos, minúsculas
  spoken  text not null,            -- con acentos, como se anuncia
  active  boolean not null default true
);

create table orders (
  id                  uuid primary key default gen_random_uuid(),
  stall_id            uuid not null references stalls (id) on delete cascade,
  number              integer not null,                 -- consecutivo diario por puesto
  business_day        date not null default (now() at time zone 'America/Mexico_City')::date,
  amount_cents        bigint not null,
  amount_source       text not null default 'manual'
                      check (amount_source in ('manual', 'spoken', 'catalog')),
  method              text not null check (method in ('codi', 'cash')),
  state               text not null default 'CREATING'
                      check (state in ('CREATING', 'AWAITING_PAYMENT', 'PENDING_UNKNOWN',
                                       'PAID', 'PAID_CASH', 'EXPIRED', 'CANCELLED', 'FAILED')),
  secret_word_id      integer references secret_words (id),
  secret_word         text,                             -- forma hablada; privada hasta PAID
  items               jsonb not null default '[]'::jsonb,
  utterance_text      text,                             -- retención: 30 días (spec)
  idempotency_key     text not null,
  provider            text,
  provider_charge_id  text unique,
  qr_payload          text,
  expires_at          timestamptz,
  paid_at             timestamptz,
  late_payment        boolean not null default false,
  created_by          uuid references auth.users (id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint orders_amount_cents_check check (amount_cents between 100 and 5000000),
  unique (stall_id, idempotency_key),
  unique (stall_id, business_day, number)
);
create index orders_stall_state_idx on orders (stall_id, state);
create index orders_stall_created_idx on orders (stall_id, created_at desc);

-- Una palabra no puede repetirse entre órdenes que siguen esperando pago en el mismo puesto.
create unique index orders_active_word on orders (stall_id, secret_word_id)
  where state in ('CREATING', 'AWAITING_PAYMENT', 'PENDING_UNKNOWN');

create table payment_events (
  id           bigserial primary key,
  provider     text not null,
  event_id     text not null,
  order_id     uuid references orders (id) on delete set null,
  charge_id    text,
  payload      jsonb not null,
  received_at  timestamptz not null default now(),
  unique (provider, event_id)
);

create table audit_log (
  id        bigserial primary key,
  order_id  uuid references orders (id) on delete set null,
  kind      text not null,     -- state_change, amount_mismatch, ref_mismatch, late_payment, ...
  detail    jsonb not null default '{}'::jsonb,
  at        timestamptz not null default now()
);
create index audit_log_order_idx on audit_log (order_id, at desc);

create or replace function touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger orders_touch before update on orders
  for each row execute function touch_updated_at();
