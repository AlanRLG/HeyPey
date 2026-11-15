-- 0009_pey_account_ref.sql — provider_account_ref es el ID de cuenta pey (ULID), nunca una CLABE.
-- Se aplica después de 0008. No reescribe migraciones anteriores.
-- Vacío significa “la cuenta CoDi ligada a la API key”.

alter table stalls drop constraint if exists stalls_provider_account_ref_ulid;
alter table stalls add constraint stalls_provider_account_ref_ulid
  check (
    provider_account_ref is null
    or provider_account_ref ~ '^[0-9A-HJKMNP-TV-Z]{26}$'
  );
