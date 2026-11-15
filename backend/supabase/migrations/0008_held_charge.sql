-- 0008_held_charge.sql — el QR ya creado se guarda sin soltar el claim.
-- Se aplica después de 0007. No crea otro QR y no llama al proveedor.
-- Recuperación manual, solo service_role:
--   1. Si el QR no quedó en la orden, record_held_charge copia el id y el payload
--      de los logs. No borra el claim y no sustituye un QR ya anotado.
--   2. recover_stuck_charge publica ese QR (AWAITING_PAYMENT) y entonces sí suelta el claim.
--      Si no hay QR anotado, lanza held_charge_missing y el claim sigue.

alter table orders add column held_charge_id text;
alter table orders add column held_qr_payload text;
alter table orders add column held_expires_at timestamptz;

create or replace function record_held_charge(
  p_order uuid,
  p_charge_id text,
  p_qr_payload text,
  p_expires_at timestamptz
) returns setof orders
language plpgsql
volatile
set search_path = public
as $$
declare
  v orders%rowtype;
begin
  if p_charge_id is null or length(btrim(p_charge_id)) = 0
     or p_qr_payload is null or length(btrim(p_qr_payload)) = 0 then
    raise exception 'invalid_charge' using errcode = 'P0001';
  end if;

  select * into v from orders where id = p_order for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if v.held_charge_id is not null then
    if v.held_charge_id is distinct from p_charge_id or v.held_qr_payload is distinct from p_qr_payload then
      raise exception 'held_charge_conflict' using errcode = 'P0001';
    end if;
    return next v;
    return;
  end if;

  if v.state <> 'CREATING' or v.charge_claim is null or v.provider_charge_id is not null then
    raise exception 'stuck_not_recoverable' using errcode = 'P0001';
  end if;

  update orders set
    held_charge_id = p_charge_id,
    held_qr_payload = p_qr_payload,
    held_expires_at = p_expires_at
  where id = p_order
    and state = 'CREATING'
    and charge_claim is not null
    and provider_charge_id is null
    and held_charge_id is null
  returning * into v;
  if not found then
    raise exception 'stuck_not_recoverable' using errcode = 'P0001';
  end if;
  return next v;
end $$;

create or replace function recover_stuck_charge(p_order uuid)
returns setof orders
language plpgsql
volatile
set search_path = public
as $$
declare
  v orders%rowtype;
begin
  select * into v from orders where id = p_order for update;
  if not found then
    raise exception 'order_not_found' using errcode = 'P0001';
  end if;

  if v.state = 'AWAITING_PAYMENT' and v.provider_charge_id is not null and v.qr_payload is not null then
    return next v;
    return;
  end if;

  if v.state <> 'CREATING' or v.charge_claim is null or v.provider_charge_id is not null then
    raise exception 'stuck_not_recoverable' using errcode = 'P0001';
  end if;
  if v.held_charge_id is null or v.held_qr_payload is null then
    raise exception 'held_charge_missing' using errcode = 'P0001';
  end if;

  update orders set
    state = 'AWAITING_PAYMENT',
    provider_charge_id = held_charge_id,
    qr_payload = held_qr_payload,
    expires_at = coalesce(held_expires_at, expires_at),
    charge_claim = null
  where id = p_order
    and state = 'CREATING'
    and charge_claim is not null
    and provider_charge_id is null
    and held_charge_id is not null
    and held_qr_payload is not null
  returning * into v;
  if not found then
    raise exception 'stuck_not_recoverable' using errcode = 'P0001';
  end if;
  return next v;
end $$;

revoke all on function record_held_charge(uuid, text, text, timestamptz) from public, anon, authenticated;
revoke all on function recover_stuck_charge(uuid) from public, anon, authenticated;
