-- Ejecutar en Supabase SQL Editor DESPUÉS de crear un usuario nuevo en Authentication → Users.
-- Sustituye el correo de abajo por el del usuario nuevo. No pongas aquí su contraseña.
do $$
declare
  v_email text := 'REEMPLAZAR_POR_CORREO_NUEVO';
  v_user uuid;
  v_merchant uuid;
  v_stall uuid;
begin
  select id into v_user from auth.users where email = v_email;
  if v_user is null then raise exception 'No existe el usuario %', v_email; end if;

  insert into public.merchants (user_id, display_name)
  values (v_user, 'Doña Carmen (demo)')
  on conflict (user_id) do update set display_name = excluded.display_name
  returning id into v_merchant;

  select id into v_stall from public.stalls where merchant_id = v_merchant limit 1;
  if v_stall is null then
    insert into public.stalls (merchant_id, name, market, provider, public_announce)
    values (v_merchant, 'Pollería Doña Carmen', 'Mercado de prueba', 'mock', true)
    returning id into v_stall;
  end if;

  insert into public.catalog_items (stall_id, name, aliases, unit, price_cents) values
    (v_stall, 'pechuga', array['pollo'], 'kg', 14000),
    (v_stall, 'diezmillo', array[]::text[], 'kg', 24000),
    (v_stall, 'chorizo', array[]::text[], 'kg', 16000),
    (v_stall, 'jitomate', array['tomate'], 'kg', 3500)
  on conflict (stall_id, name) do nothing;
end $$;

-- Copia este STALL_ID (es público) para actualizar tools/simulator/config.js.
select s.id as stall_id, s.name
from public.stalls s
join public.merchants m on m.id = s.merchant_id
join auth.users u on u.id = m.user_id
where u.email = 'REEMPLAZAR_POR_CORREO_NUEVO';
