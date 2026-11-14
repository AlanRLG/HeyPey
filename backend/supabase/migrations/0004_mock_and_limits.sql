-- 0004_mock_and_limits.sql — brechas B1 y B2 de DEPLOY.md

-- B1: el mínimo por orden pasa a configuración de la aplicación (MIN_AMOUNT_CENTS);
-- la tabla solo evita basura.
alter table orders drop constraint if exists orders_amount_cents_check;
alter table orders add constraint orders_amount_cents_check
  check (amount_cents between 1 and 5000000);

-- B2: estado de las cargas del proveedor simulado
create table if not exists mock_charges (
  charge_id    text primary key,
  status       text not null default 'pending'
               check (status in ('pending', 'settled', 'expired', 'failed', 'cancelled')),
  amount_cents bigint not null,
  reference    text not null,            -- order.id
  created_at   timestamptz not null default now()
);
alter table mock_charges enable row level security;   -- sin políticas: solo service_role
