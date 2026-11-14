-- 0002_functions.sql — selección de palabra, número de orden y creación atómica.
-- Solo service_role ejecuta estas funciones (se revoca a anon/authenticated).

-- Palabra aleatoria activa que no esté en uso por otra orden pendiente del puesto
-- y que no se haya usado en las últimas 50 órdenes (evita confusiones al anunciar).
create or replace function pick_secret_word(p_stall uuid)
returns secret_words
language sql volatile as $$
  select w.*
  from secret_words w
  where w.active
    and not exists (
      select 1 from orders o
      where o.stall_id = p_stall
        and o.secret_word_id = w.id
        and o.state in ('CREATING', 'AWAITING_PAYMENT', 'PENDING_UNKNOWN'))
    and w.id not in (
      select o.secret_word_id from orders o
      where o.stall_id = p_stall and o.secret_word_id is not null
      order by o.created_at desc limit 50)
  order by random()
  limit 1
$$;

-- Crea la orden en estado CREATING (codi) o PAID_CASH (efectivo).
-- Idempotente por (stall_id, idempotency_key): repetir la clave devuelve la misma orden.
create or replace function create_order(
  p_stall        uuid,
  p_amount_cents bigint,
  p_source       text,
  p_method       text,
  p_items        jsonb,
  p_utterance    text,
  p_idem         text,
  p_user         uuid,
  p_provider     text,
  p_ttl_seconds  integer default 180
) returns orders
language plpgsql volatile as $$
declare
  v_order  orders;
  v_word   secret_words;
  v_day    date := (now() at time zone 'America/Mexico_City')::date;
  v_number integer;
  v_try    integer := 0;
begin
  select * into v_order from orders where stall_id = p_stall and idempotency_key = p_idem;
  if found then
    return v_order;
  end if;

  -- Serializa la numeración por puesto.
  perform pg_advisory_xact_lock(hashtext('order_number:' || p_stall::text));
  select coalesce(max(number), 0) + 1 into v_number
    from orders where stall_id = p_stall and business_day = v_day;

  loop
    v_try := v_try + 1;
    v_word := null;
    if p_method = 'codi' then
      v_word := pick_secret_word(p_stall);
      if v_word.id is null then
        raise exception 'no_secret_word_available' using errcode = 'P0001';
      end if;
    end if;

    begin
      insert into orders (stall_id, number, business_day, amount_cents, amount_source, method, state,
                          secret_word_id, secret_word, items, utterance_text, idempotency_key,
                          provider, expires_at, paid_at, created_by)
      values (p_stall, v_number, v_day, p_amount_cents, coalesce(p_source, 'manual'), p_method,
              case when p_method = 'cash' then 'PAID_CASH' else 'CREATING' end,
              v_word.id, v_word.spoken, coalesce(p_items, '[]'::jsonb), p_utterance, p_idem,
              case when p_method = 'cash' then null else p_provider end,
              case when p_method = 'cash' then null else now() + make_interval(secs => p_ttl_seconds) end,
              case when p_method = 'cash' then now() else null end,
              p_user)
      returning * into v_order;
      exit;
    exception when unique_violation then
      -- Carrera con la misma idempotencyKey: devuelve la orden ganadora.
      select * into v_order from orders where stall_id = p_stall and idempotency_key = p_idem;
      if found then
        return v_order;
      end if;
      -- Carrera por la misma palabra: reintenta con otra.
      if v_try >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into audit_log (order_id, kind, detail)
  values (v_order.id, 'state_change', jsonb_build_object('to', v_order.state, 'method', p_method));
  return v_order;
end $$;

revoke all on function pick_secret_word(uuid) from public, anon, authenticated;
revoke all on function create_order(uuid, bigint, text, text, jsonb, text, text, uuid, text, integer)
  from public, anon, authenticated;
