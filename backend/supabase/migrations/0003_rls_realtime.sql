-- 0003_rls_realtime.sql — RLS de lectura para el comerciante y difusión por Realtime privado.
-- [VERIFICAR] sintaxis de Realtime Authorization (realtime.messages / realtime.topic / realtime.send)
-- contra la documentación vigente de Supabase (spike S3).

alter table merchants      enable row level security;
alter table stalls         enable row level security;
alter table catalog_items  enable row level security;
alter table secret_words   enable row level security;   -- sin políticas: solo service_role
alter table orders         enable row level security;
alter table payment_events enable row level security;   -- sin políticas: solo service_role
alter table audit_log      enable row level security;   -- sin políticas: solo service_role

create or replace function owns_stall(p_stall uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from stalls s join merchants m on m.id = s.merchant_id
    where s.id = p_stall and m.user_id = auth.uid())
$$;

create policy merchants_self on merchants for select to authenticated
  using (user_id = auth.uid());

create policy stalls_own on stalls for select to authenticated
  using (owns_stall(id));

create policy catalog_own on catalog_items for select to authenticated
  using (owns_stall(stall_id));

-- Lectura directa de órdenes solo para el comerciante. Ninguna política de escritura:
-- las órdenes se crean y cambian exclusivamente desde Edge Functions (service_role).
create policy orders_own on orders for select to authenticated
  using (owns_stall(stall_id));

-- Realtime: solo canales privados de puestos propios.
create policy realtime_own_stall on realtime.messages for select to authenticated
  using (
    realtime.messages.extension = 'broadcast'
    and exists (
      select 1 from stalls s join merchants m on m.id = s.merchant_id
      where m.user_id = auth.uid()
        and realtime.topic() in ('stall:' || s.id::text || ':merchant',
                                 'stall:' || s.id::text || ':customer'))
  );

-- Difusión en cada alta o cambio de estado. El canal del cliente NUNCA lleva la palabra
-- salvo cuando la orden ya está en PAID (pago verificado por el servidor).
create or replace function broadcast_order() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_event    text;
  v_customer jsonb;
  v_merchant jsonb;
begin
  if tg_op = 'UPDATE' and new.state = old.state and new.late_payment = old.late_payment then
    return new;
  end if;
  if new.state = 'CREATING' then
    return new;   -- aún sin QR: se anuncia al pasar a AWAITING_PAYMENT
  end if;

  v_event := case
    when tg_op = 'UPDATE' and new.late_payment and not old.late_payment then 'order.late_payment'
    when new.state = 'AWAITING_PAYMENT' then 'order.created'
    when new.state = 'PAID' then 'order.paid'
    when new.state = 'PAID_CASH' then 'order.paid_cash'
    else 'order.' || lower(new.state)
  end;

  v_merchant := jsonb_build_object(
    'orderId', new.id, 'number', new.number, 'amountCents', new.amount_cents,
    'method', new.method, 'state', new.state, 'secretWord', new.secret_word,
    'qrPayload', new.qr_payload, 'expiresAt', new.expires_at, 'paidAt', new.paid_at,
    'latePayment', new.late_payment, 'items', new.items, 'createdAt', new.created_at);

  perform realtime.send(v_merchant, v_event, 'stall:' || new.stall_id::text || ':merchant', true);

  -- El pago tardío es un aviso privado para el comerciante.
  if v_event = 'order.late_payment' then
    return new;
  end if;

  v_customer := jsonb_build_object(
    'orderId', new.id, 'number', new.number, 'amountCents', new.amount_cents,
    'method', new.method, 'state', new.state,
    'qrPayload', case when new.state = 'AWAITING_PAYMENT' then new.qr_payload end,
    'expiresAt', new.expires_at,
    'secretWord', case when new.state = 'PAID' then new.secret_word end);

  perform realtime.send(v_customer, v_event, 'stall:' || new.stall_id::text || ':customer', true);
  return new;
end $$;

create trigger orders_broadcast after insert or update on orders
  for each row execute function broadcast_order();
