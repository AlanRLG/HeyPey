-- 0007_charge_claim.sql — un solo QR por orden y el identificador real del pago simulado.
-- Se aplica después de 0006. No reescribe migraciones anteriores.

alter table orders add column charge_claim text;
alter table orders add column charge_claimed_at timestamptz;

alter table mock_charges add column transaction_id text;
alter table mock_charges add column tracking_key text;

-- Gana una sola solicitud el derecho a crear el QR. La otra ve el claim y reutiliza el resultado.
-- El claim no caduca por tiempo: POST /codi/qr no documenta una clave de idempotencia, así que
-- soltarlo a los 30 s podría crear un segundo QR mientras la primera llamada sigue en curso.
-- Si el reintento llega con la orden FAILED (el proveedor rechazó la creación) y el QR ya venció,
-- renueva expires_at. Un resultado incierto no llama a fail y deja el claim puesto.
create or replace function claim_order_charge(
  p_order uuid,
  p_token text,
  p_ttl_seconds integer
) returns setof orders
language plpgsql
volatile
set search_path = public
as $$
begin
  if p_token is null or length(p_token) < 8 then
    raise exception 'invalid_claim' using errcode = 'P0001';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds < 1 then
    raise exception 'invalid_ttl' using errcode = 'P0001';
  end if;

  return query
  update orders set
    charge_claim = p_token,
    charge_claimed_at = clock_timestamp(),
    state = 'CREATING',
    expires_at = case
      when expires_at is null or expires_at <= clock_timestamp()
        then clock_timestamp() + make_interval(secs => p_ttl_seconds)
      else expires_at
    end
  where id = p_order
    and state in ('CREATING', 'FAILED')
    and provider_charge_id is null
    and charge_claim is null
  returning *;
end $$;

revoke all on function claim_order_charge(uuid, text, integer) from public, anon, authenticated;
