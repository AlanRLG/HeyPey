-- 0006_payment_integrity.sql — reglas del PDF que el esquema 0001–0004 no cubría.
-- No reescribe migraciones ya aplicadas.
--
-- orders.items se conserva como JSONB (no se crea order_items). El corte suma órdenes,
-- no renglones, y el simulador ya lee ese JSON. Forma válida de cada elemento:
--   { "name" | "product": texto, "qty"?: número, "unit"?: texto, "amountCents"?: entero >= 0 }
-- Máximo 50 elementos. order_items_valid la rechaza en el servidor y en el CHECK.

alter table orders add column tracking_key text;
alter table orders add column replaced_by uuid references orders (id) on delete set null;
alter table orders add column reconcile_attempts integer not null default 0;
alter table orders add column reconcile_unknown_since timestamptz;
alter table orders add column next_reconcile_at timestamptz;
alter table orders add column reconcile_alerted_at timestamptz;

create index orders_reconcile_due_idx on orders (next_reconcile_at)
  where state = 'PENDING_UNKNOWN';

alter table payment_events add column transaction_id text;
alter table payment_events add column processed_at timestamptz;
alter table payment_events add column outcome text;
alter table payment_events add column result jsonb;

-- Un mismo pago (transactionId) no puede liquidar dos veces.
create unique index payment_events_transaction_uidx
  on payment_events (provider, transaction_id)
  where transaction_id is not null and outcome in ('paid', 'late_paid');

create or replace function order_items_valid(p_items jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  el jsonb;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then
    return false;
  end if;
  if jsonb_array_length(p_items) > 50 then
    return false;
  end if;
  for el in select value from jsonb_array_elements(p_items)
  loop
    if jsonb_typeof(el) <> 'object' then
      return false;
    end if;
    if not coalesce(
      (jsonb_typeof(el -> 'name') = 'string' and char_length(el ->> 'name') between 1 and 80)
      or (jsonb_typeof(el -> 'product') = 'string' and char_length(el ->> 'product') between 1 and 80),
      false
    ) then
      return false;
    end if;
    if el ? 'qty' and jsonb_typeof(el -> 'qty') is distinct from 'number' then
      return false;
    end if;
    if el ? 'unit' and (
      jsonb_typeof(el -> 'unit') is distinct from 'string'
      or char_length(el ->> 'unit') not between 1 and 20
    ) then
      return false;
    end if;
    if el ? 'amountCents' and (
      jsonb_typeof(el -> 'amountCents') is distinct from 'number'
      or (el ->> 'amountCents') !~ '^[0-9]+$'
    ) then
      return false;
    end if;
  end loop;
  return true;
end $$;

alter table orders add constraint orders_items_shape check (order_items_valid(items));

-- PDF: no usada en 24 h, ni por una orden activa; si la lista se agota, últimas 200
-- y las activas siguen excluidas. gen_random_uuid() es la fuente aleatoria.
-- El tipo de retorno sigue siendo secret_words para no romper create_order.
create or replace function pick_secret_word(p_stall uuid)
returns secret_words
language plpgsql
volatile
set search_path = public
as $$
declare
  v secret_words;
begin
  select w.* into v
  from secret_words w
  where w.active
    and not exists (
      select 1 from orders o
      where o.stall_id = p_stall
        and o.secret_word_id = w.id
        and (
          o.created_at > now() - interval '24 hours'
          or o.state in ('CREATING', 'AWAITING_PAYMENT', 'PENDING_UNKNOWN')
        ))
  order by gen_random_uuid()
  limit 1;

  if not found then
    select w.* into v
    from secret_words w
    where w.active
      and not exists (
        select 1 from orders o
        where o.stall_id = p_stall
          and o.secret_word_id = w.id
          and o.state in ('CREATING', 'AWAITING_PAYMENT', 'PENDING_UNKNOWN'))
      and w.id not in (
        select o.secret_word_id
        from orders o
        where o.stall_id = p_stall
          and o.secret_word_id is not null
        order by o.created_at desc
        limit 200)
    order by gen_random_uuid()
    limit 1;
  end if;
  return v;
end $$;

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
language plpgsql
volatile
set search_path = public
as $$
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

  if not order_items_valid(coalesce(p_items, '[]'::jsonb)) then
    raise exception 'invalid_items' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('order_number:' || p_stall::text));
  select coalesce(max(number), 0) + 1 into v_number
    from orders where stall_id = p_stall and business_day = v_day;

  loop
    v_try := v_try + 1;
    v_word := null;
    if p_method = 'codi' then
      v_word := pick_secret_word(p_stall);
      if v_word is null or v_word.id is null then
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
      select * into v_order from orders where stall_id = p_stall and idempotency_key = p_idem;
      if found then
        return v_order;
      end if;
      if v_try >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into audit_log (order_id, kind, detail)
  values (v_order.id, 'state_change', jsonb_build_object('to', v_order.state, 'method', p_method));
  return v_order;
end $$;

-- Registra el evento y cambia el estado en la misma transacción.
-- Solo debe llamarse después de verificar la firma y confirmar el pago con el proveedor.
-- Un reintento devuelve el resultado guardado y no vuelve a anunciar.
create or replace function mark_order_paid(
  p_provider        text,
  p_event_id        text,
  p_charge_id       text,
  p_order_id        uuid,
  p_amount_cents    bigint,
  p_transaction_id  text,
  p_tracking_key    text,
  p_payload         jsonb
) returns jsonb
language plpgsql
volatile
set search_path = public
as $$
declare
  v_event      payment_events;
  v_order      orders;
  v_outcome    text;
  v_result     jsonb;
  v_from       text;
  v_tx         text;
  v_order_id   uuid;
  v_have_event boolean := false;
begin
  if p_provider is null or p_event_id is null or length(p_event_id) = 0 then
    raise exception 'invalid_event' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('evt:' || p_provider || ':' || p_event_id));
  if p_transaction_id is not null and length(p_transaction_id) > 0 then
    perform pg_advisory_xact_lock(hashtext('tx:' || p_provider || ':' || p_transaction_id));
  end if;

  select * into v_event
  from payment_events
  where provider = p_provider and event_id = p_event_id
  for update;
  v_have_event := found;
  if v_have_event and v_event.processed_at is not null then
    return coalesce(v_event.result, '{}'::jsonb)
      || jsonb_build_object('duplicate', true, 'announced', false);
  end if;

  select * into v_order from orders where id = p_order_id for update;
  if not found then
    v_outcome := 'ref_mismatch';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', false, 'announced', false, 'orderId', null);
  else
    v_order_id := v_order.id;
    v_from := v_order.state;
  end if;

  if v_outcome is not null then
    null;
  elsif v_order.provider_charge_id is distinct from p_charge_id
     or v_order.provider is distinct from p_provider then
    v_outcome := 'ref_mismatch';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', false, 'announced', false,
      'orderId', v_order_id);
  elsif v_order.amount_cents <> p_amount_cents then
    v_outcome := 'amount_mismatch';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', false, 'announced', false,
      'state', v_order.state, 'orderId', v_order.id,
      'expected', v_order.amount_cents, 'received', p_amount_cents);
  elsif exists (
    select 1 from payment_events e
    where e.provider = p_provider
      and e.transaction_id = p_transaction_id
      and e.outcome in ('paid', 'late_paid')
      and e.event_id <> p_event_id
  ) then
    v_outcome := 'duplicate_transaction';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', true, 'announced', false,
      'state', v_order.state, 'orderId', v_order.id);
  elsif v_order.state = 'PAID' then
    if p_tracking_key is not null and v_order.tracking_key is null then
      update orders set tracking_key = p_tracking_key where id = v_order.id;
    end if;
    v_outcome := 'duplicate';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', true, 'announced', false,
      'state', 'PAID', 'latePayment', v_order.late_payment, 'orderId', v_order.id);
  elsif v_order.state in ('AWAITING_PAYMENT', 'PENDING_UNKNOWN') then
    update orders set
      state = 'PAID',
      paid_at = now(),
      tracking_key = coalesce(p_tracking_key, tracking_key),
      late_payment = false,
      reconcile_attempts = 0,
      reconcile_unknown_since = null,
      next_reconcile_at = null,
      reconcile_alerted_at = null
    where id = v_order.id and state = v_from
    returning * into v_order;
    v_outcome := 'paid';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', false, 'announced', true,
      'state', 'PAID', 'latePayment', false, 'orderId', v_order.id);
  elsif v_order.state in ('CANCELLED', 'EXPIRED') then
    update orders set
      state = 'PAID',
      paid_at = now(),
      tracking_key = coalesce(p_tracking_key, tracking_key),
      late_payment = true,
      reconcile_attempts = 0,
      reconcile_unknown_since = null,
      next_reconcile_at = null,
      reconcile_alerted_at = null
    where id = v_order.id and state = v_from
    returning * into v_order;
    v_outcome := 'late_paid';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', false, 'announced', false,
      'state', 'PAID', 'latePayment', true, 'orderId', v_order.id);
  else
    v_outcome := 'state_mismatch';
    v_result := jsonb_build_object(
      'outcome', v_outcome, 'duplicate', false, 'announced', false,
      'state', v_order.state, 'orderId', v_order.id);
  end if;

  if v_outcome = 'paid' then
    insert into audit_log (order_id, kind, detail)
    values (v_order.id, 'state_change', jsonb_build_object(
      'from', v_from, 'to', 'PAID', 'eventId', p_event_id, 'trackingKey', p_tracking_key));
  elsif v_outcome = 'late_paid' then
    insert into audit_log (order_id, kind, detail)
    values (v_order.id, 'late_payment', jsonb_build_object(
      'from', v_from, 'to', 'PAID', 'eventId', p_event_id, 'trackingKey', p_tracking_key));
  elsif v_outcome = 'amount_mismatch' then
    insert into audit_log (order_id, kind, detail)
    values (v_order.id, 'amount_mismatch', jsonb_build_object(
      'expected', v_order.amount_cents, 'received', p_amount_cents, 'eventId', p_event_id));
  elsif v_outcome = 'ref_mismatch' then
    insert into audit_log (order_id, kind, detail)
    values (v_order_id, 'ref_mismatch', jsonb_build_object(
      'chargeId', p_charge_id, 'reference', p_order_id, 'eventId', p_event_id));
  elsif v_outcome = 'duplicate_transaction' then
    insert into audit_log (order_id, kind, detail)
    values (v_order.id, 'duplicate_transaction', jsonb_build_object(
      'transactionId', p_transaction_id, 'eventId', p_event_id));
  elsif v_outcome = 'state_mismatch' then
    insert into audit_log (order_id, kind, detail)
    values (v_order.id, 'state_mismatch', jsonb_build_object(
      'state', v_order.state, 'eventId', p_event_id));
  end if;

  -- La unicidad del pago solo se ocupa cuando el dinero se aceptó.
  v_tx := case when v_outcome in ('paid', 'late_paid') then p_transaction_id else null end;

  if not v_have_event then
    insert into payment_events (
      provider, event_id, order_id, charge_id, payload,
      transaction_id, processed_at, outcome, result)
    values (
      p_provider, p_event_id, v_order_id,
      p_charge_id, coalesce(p_payload, '{}'::jsonb),
      v_tx, now(), v_outcome, v_result);
  else
    update payment_events set
      order_id = coalesce(v_order_id, order_id),
      charge_id = p_charge_id,
      payload = coalesce(p_payload, payload),
      transaction_id = v_tx,
      processed_at = now(),
      outcome = v_outcome,
      result = v_result
    where id = v_event.id;
  end if;

  return v_result;
end $$;

-- Cancela la orden anterior y crea otra con otra palabra, en una transacción.
-- El QR anterior sigue pudiendo liquidarse después como pago tardío.
create or replace function correct_order(
  p_order        uuid,
  p_amount_cents bigint,
  p_source       text,
  p_items        jsonb,
  p_utterance    text,
  p_idem         text,
  p_user         uuid,
  p_provider     text,
  p_ttl_seconds  integer default 180
) returns orders
language plpgsql
volatile
set search_path = public
as $$
declare
  v_old orders;
  v_new orders;
begin
  select * into v_old from orders where id = p_order for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;

  if v_old.replaced_by is not null then
    select * into v_new from orders where id = v_old.replaced_by;
    if v_new.idempotency_key = p_idem then
      return v_new;
    end if;
    raise exception 'already_replaced' using errcode = 'P0001';
  end if;

  if v_old.state not in ('CREATING', 'AWAITING_PAYMENT', 'PENDING_UNKNOWN') then
    raise exception 'not_correctable' using errcode = 'P0001';
  end if;
  if p_idem is null or p_idem = v_old.idempotency_key then
    raise exception 'idempotency_reused' using errcode = 'P0001';
  end if;

  update orders set state = 'CANCELLED' where id = v_old.id;

  v_new := create_order(
    v_old.stall_id, p_amount_cents, p_source, 'codi', p_items, p_utterance,
    p_idem, p_user, p_provider, p_ttl_seconds);

  update orders set replaced_by = v_new.id where id = v_old.id;
  insert into audit_log (order_id, kind, detail)
  values (v_old.id, 'state_change', jsonb_build_object(
    'from', v_old.state, 'to', 'CANCELLED', 'replacedBy', v_new.id));
  return v_new;
end $$;

-- Borra el texto de la transcripción a los 30 días. No hay audio que borrar.
create or replace function purge_old_utterances(p_days integer default 30)
returns integer
language plpgsql
volatile
set search_path = public
as $$
declare
  n integer;
begin
  if p_days is null or p_days < 1 then
    raise exception 'invalid_retention' using errcode = 'P0001';
  end if;
  with upd as (
    update orders
    set utterance_text = null
    where utterance_text is not null
      and created_at < now() - make_interval(days => p_days)
    returning 1
  )
  select count(*) into n from upd;
  return n;
end $$;

-- El pago tardío solo avisa por el canal privado del comerciante.
create or replace function broadcast_order() returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_event    text;
  v_customer jsonb;
  v_merchant jsonb;
begin
  if tg_op = 'UPDATE' and new.state = old.state and new.late_payment = old.late_payment then
    return new;
  end if;
  if new.state = 'CREATING' then
    return new;
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

  if v_event = 'order.late_payment' or new.late_payment then
    return new;
  end if;

  v_customer := jsonb_build_object(
    'orderId', new.id, 'number', new.number, 'amountCents', new.amount_cents,
    'method', new.method, 'state', new.state,
    'qrPayload', case when new.state = 'AWAITING_PAYMENT' then new.qr_payload end,
    'expiresAt', new.expires_at,
    'secretWord', case when new.state = 'PAID' and not new.late_payment then new.secret_word end);

  perform realtime.send(v_customer, v_event, 'stall:' || new.stall_id::text || ':customer', true);
  return new;
end $$;

revoke all on function order_items_valid(jsonb) from public, anon, authenticated;
revoke all on function pick_secret_word(uuid) from public, anon, authenticated;
revoke all on function create_order(uuid, bigint, text, text, jsonb, text, text, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function mark_order_paid(text, text, text, uuid, bigint, text, text, jsonb)
  from public, anon, authenticated;
revoke all on function correct_order(uuid, bigint, text, jsonb, text, text, uuid, text, integer)
  from public, anon, authenticated;
revoke all on function purge_old_utterances(integer) from public, anon, authenticated;
