# DEPLOY.md — Copiloto Acústico Zero-UI (Módulo 2)

Guía para desplegar el sistema completo desde el repositorio `copiloto-zeroui/`.
Basada en la **Especificación técnica v3**. Lo marcado **[VERIFICAR]** es un supuesto que hay que confirmar
con la fuente primaria o con una prueba técnica antes de depender de él.

> **Estado del repo:** el **Nivel 1 está construido**. La versión original se verificó contra
> Supabase local: migraciones `0001`–`0005` (incluye 311 palabras), Edge Functions `orders`, `webhooks`, `reconcile`
> y `mock-pay`, `MockProvider` con `mock_charges`, y el simulador web en `tools/simulator/`. La nueva función `public-orders`
> da acceso saneado a la pantalla del cliente sin compartir la sesión del comerciante; hay que repetir las pruebas con la cuenta nueva. Las brechas B1–B6 están
> resueltas en el código; B7 (pey) sigue abierta a propósito. La app Android y la voz (Niveles 2 y 3) aún no existen.
> **Atajo:** `PROJECT_REF=<ref> DB_PASSWORD='<...>' STALL_ID=<uuid> tools/deploy/deploy_cloud.sh` despliega backend y
> genera `tools/simulator/config.js` con datos públicos. La cuenta y el puesto se crean por separado; ver 4.5.
>
> Esta guía respeta las reglas de `AGENTS.md`: el servidor es la autoridad del estado, la palabra secreta nunca
> llega a la vista del cliente antes de un pago verificado, los montos van en centavos enteros y la demo no usa
> dinero real.

---

## 0. Niveles de despliegue (elige hasta dónde llegar)

El sistema se despliega por capas. Cada nivel es demostrable por sí solo.

| Nivel | Qué queda funcionando | Qué necesita | Para hackatón |
|---|---|---|---|
| **1** | Backend + proveedor simulado (Mock) + simulador web con link público | Supabase, hosting estático | **Imprescindible** |
| **2** | Nivel 1 + APK Android en modo manual (teclado, efectivo, QR, anuncio con palabra) | Android Studio, un teléfono | Recomendado |
| **3** | Nivel 2 + voz (VAD, whisper.cpp, parser, diadema Bluetooth) | NDK, modelos, diadema | Solo si sobra tiempo |
| **4** | Nivel 3 + pagos de prueba con pey® (CoDi) | Cuenta y CLABEs en pey | **Fuera de la demo**, salvo decisión explícita del dueño (`AGENTS.md`: no conectar dinero real) |

Orden de despliegue y dependencias:

```
Supabase (DB + funciones + Realtime + cron)
   ├── Proveedor de pagos (Mock → pey)
   ├── Simulador web  (link público)
   └── App Android    (modo Comerciante / modo Cliente)
```

La spec define que **sin voz el sistema ya es demostrable** (Sprint 2). `AGENTS.md` y `docs/PLAN_DEMO.md`
fijan la prioridad del repo: simulador + `MockProvider` + flujo completo sin voz, **sin dinero real** en la demo.
Para la entrega, el Nivel 1 (simulador publicado en Vercel) cumple "link de la app en vivo"; el APK, si se llega
al Nivel 2, va como descarga adjunta.

---

## 1. Requisitos

### Cuentas
- **Supabase** (plan gratuito alcanza para el MVP).
- **Hosting estático** para el simulador: Vercel, Netlify o Cloudflare Pages.
- **GitHub** con el repositorio **público** (lo exige la entrega del evento).
- **pey®**: acceso en `portal.pey.mx` y documentación en `docs.pey.mx` (solo Nivel 4).

### Herramientas locales

| Herramienta | Versión | Para qué |
|---|---|---|
| Git | reciente | Repo y submódulos |
| Supabase CLI | reciente (`supabase --version`) | Migraciones, funciones, secretos |
| Docker | reciente | Solo desarrollo local de Supabase |
| `psql` | 14+ | Cargar palabras y seeds |
| Node.js | 20 LTS | Simulador web y herramientas |
| JDK | 17 | Compilar Android |
| Android Studio + SDK | Android 12+ (API 31+) recomendado **[VERIFICAR minSdk]** | App Android |
| Android NDK + CMake | desde SDK Manager | Solo Nivel 3 (JNI de whisper.cpp) |
| `adb` | incluido en platform-tools | Instalar el APK |
| `openssl`, `curl`, `jq` | cualquiera | Generar secretos y probar |

Instalación del CLI: <https://supabase.com/docs/guides/local-development/cli/getting-started>

---

## 2. Variables y secretos

**Regla:** nada de secretos en el repo. Se versiona solo `.env.example`; los `.env*` reales van en `.gitignore`.

### 2.1 Secretos del backend (Edge Functions)

Se cargan con `supabase secrets set`. Los nombres son los usados en la spec o **sugeridos** (marcados con *).

| Variable | Uso | Cómo obtenerla |
|---|---|---|
| `MOCK_WEBHOOK_SECRET` | Firma HMAC del proveedor simulado | `openssl rand -hex 32` |
| `ENABLE_MOCK_PAY` * | `true` solo en dev y demo con Mock; `false` con pagos reales | Manual |
| `CRON_SECRET` * | Autentica la llamada de `pg_cron` a `reconcile` | `openssl rand -hex 32` |
| `MIN_AMOUNT_CENTS` * | Monto mínimo por orden (ver brecha B1) | `500` en producción, `1` en pruebas con pey |
| `PEY_API_KEY` *, `PEY_WEBHOOK_SECRET` *, `PEY_BASE_URL` * | Adaptador `providers/pey.ts` | `portal.pey.mx` / `docs.pey.mx` **[VERIFICAR nombres y esquema de firma]** |

Supabase inyecta solas `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` en las Edge Functions;
no las pongas en `secrets set` (los nombres que empiezan con `SUPABASE_` están reservados).

### 2.2 Variables de los clientes

Solo la **anon key** va en los clientes. La `service_role` nunca sale del backend.

| Cliente | Archivo | Variables |
|---|---|---|
| Android | `android/local.properties` (no versionado) → `BuildConfig` | `SUPABASE_URL`, `SUPABASE_ANON_KEY` |
| Simulador web (Vercel) | Opción A: `tools/simulator/config.js` (versionable: solo URL, anon key y puesto de demo). Opción B (Vite): variables del proyecto en Vercel | A: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `STALL_ID` · B: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` |

Archivos `.env.example` a incluir en el repo:

```bash
# backend/.env.secrets.example
MOCK_WEBHOOK_SECRET=
ENABLE_MOCK_PAY=true
CRON_SECRET=
MIN_AMOUNT_CENTS=500
# Nivel 4
PEY_API_KEY=
PEY_WEBHOOK_SECRET=
PEY_BASE_URL=
```

```bash
# tools/simulator/.env.example   (solo opción B: Vite)
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=
```

---

## 3. Preflight: lo que debe existir y brechas de la spec

### 3.1 Estado inicial del repo antes de construir Nivel 1 (de C1)

Checkout revisado: commit `11c47be` ("docs: link live Vercel base"). Según su propio `README.md`, es solo
estructura inicial.

| Ruta | Estado |
|---|---|
| `README.md`, `AGENTS.md`, `docs/PLAN_DEMO.md`, `vercel.json`, `.gitignore`, `.editorconfig`, `.gitattributes` | Existen |
| `tools/simulator/index.html` | Existe: pantalla de arranque estática, sin lógica |
| `backend/supabase/migrations/` (`0001` a `0004`) | Falta (solo `.gitkeep`) |
| `backend/supabase/functions/{orders,webhooks,reconcile,mock-pay}/index.ts` | Falta |
| `backend/supabase/functions/_shared/{db.ts,auth.ts,providers/{types.ts,mock.ts,pey.ts}}` | Falta |
| `backend/supabase/seed/secret_words.csv` y `data/words/` | Falta (≥ 300 palabras; columnas `word,spoken`) |
| `backend/supabase/config.toml` | Falta (lo crea `supabase init`) |
| `android/` (proyecto Gradle) | Falta (solo la carpeta `mx/copiloto/`) |
| `data/golden/utterances.json`, `tools/eval/` | Falta |

El primer trabajo es construir lo que falta siguiendo el alcance inicial de `docs/PLAN_DEMO.md`: esquema de órdenes,
selección de palabras, `MockProvider`, endpoint para crear orden y endpoint de pago simulado, más las vistas web de
comerciante y cliente.

### 3.2 Brechas detectadas en la spec (resolver ANTES de desplegar)

Estas son inconsistencias o piezas omitidas en la v3 que rompen el flujo si no se corrigen.

**B1. El monto mínimo bloquea las pruebas con pey ($0.01). Aplica solo al Nivel 4.**
La spec exige `amount_cents between 100 and 5000000` en la tabla `orders` y en `createOrder`, y el
`AmountResolver` de Android usa un mínimo de `$5.00`. El evento indica que las pruebas con pey son de
**$0.01** (1 centavo). Con la spec tal cual, esas órdenes se rechazan.
Corrección: migración `0004` (abajo) + que `createOrder` lea `MIN_AMOUNT_CENTS` de la variable de entorno en
lugar de `100` fijo + que Android lea el mínimo de configuración (`BuildConfig`) en lugar de la constante `MIN`.

**B2. Falta la tabla `mock_charges`.**
`mock.ts` devuelve siempre `"pending"` en `getStatus` ("la tabla `mock_charges` se omitió por brevedad").
Pero `handleWebhook` hace doble verificación con `getStatus`: con esa implementación, **todo pago simulado
termina en `PENDING_UNKNOWN`** y nunca en `PAID`. Hay que crear la tabla, que `createCharge` inserte la
carga, que `getStatus` la lea y que `mock-pay` la marque como `settled` **antes** de enviar el webhook firmado.

**B3. `reconcile` y `webhooks` no llevan JWT de usuario.**
Hay que desactivar `verify_jwt` en ambas (config abajo). `webhooks` se protege con la firma del proveedor;
`reconcile` debe verificar el header `x-cron-secret` contra `CRON_SECRET` (agregar al inicio de la función).

**B4. `mock-pay` debe poder apagarse.**
La spec dice "solo en desarrollo". La función responde 404 si `ENABLE_MOCK_PAY !== "true"` y exige un JWT válido
del dueño del puesto. Acepta un `eventId` opcional para probar duplicados (sección 9). Debe rechazar cualquier `chargeId` cuyo puesto no tenga `provider = 'mock'`, para que
ninguna acción del navegador pueda confirmar un pago real.

**B5. Canales privados de Realtime.**
Los clientes deben suscribirse con canal **privado** (`private: true` en la configuración del canal) y el topic
exacto `stall:<uuid>:merchant` o `stall:<uuid>:customer`. La sintaxis de la política `realtime.messages` y la
firma de `realtime.send` están marcadas **[VERIFICAR]** en la spec: es el spike S3. Si fallan, revisa la
documentación vigente de *Realtime Authorization* antes de seguir.

**B6. CORS.**
Si el simulador web llama a las Edge Functions desde el navegador, cada función debe responder el
preflight `OPTIONS` y devolver `Access-Control-Allow-Origin` (y `Allow-Headers` con `authorization, apikey, content-type`).

**B7. El adaptador `pey.ts` no está especificado.**
La spec solo define la interfaz `PaymentProvider`. Los endpoints, el campo de referencia (en el borrador original
aparecía `numRef`), el formato del webhook y el esquema de firma de pey hay que tomarlos de `docs.pey.mx`.
No los asumas.

### 3.3 Migración correctiva `0004_mock_and_limits.sql`

```sql
-- B1: el mínimo por orden pasa a configuración de la aplicación (la tabla solo evita basura)
alter table orders drop constraint if exists orders_amount_cents_check;
alter table orders add constraint orders_amount_cents_check
  check (amount_cents between 1 and 5000000);

-- B2: estado de las cargas del proveedor simulado
create table if not exists mock_charges (
  charge_id    text primary key,
  status       text not null default 'pending'
               check (status in ('pending','settled','expired','failed','cancelled')),
  amount_cents bigint not null,
  reference    text not null,            -- order.id
  created_at   timestamptz not null default now()
);
alter table mock_charges enable row level security;   -- sin políticas: solo service_role
```

> Si el nombre real del constraint de `0001_core.sql` es distinto, ajusta el `drop constraint`
> (`\d orders` en `psql` lo muestra).

---

## 4. Backend en Supabase

Todos los comandos se ejecutan desde `backend/` (el CLI busca la carpeta `supabase/`).

### 4.1 Crear y enlazar el proyecto

1. Crea el proyecto en <https://supabase.com/dashboard> (región más cercana, por ejemplo `us-east-1` o `us-west-1`) y guarda la contraseña de la base de datos.
2. Copia el **Project Ref** (Settings → General) y la cadena de conexión (Settings → Database).

```bash
cd backend
supabase login
supabase link --project-ref <PROJECT_REF>
```

Si `backend/supabase/config.toml` no existe: `supabase init` (acepta no generar archivos de IDE).

### 4.2 Configuración de funciones (`backend/supabase/config.toml`)

```toml
[functions.webhooks]
verify_jwt = false      # la autenticación es la firma del proveedor

[functions.reconcile]
verify_jwt = false      # la autenticación es x-cron-secret

# orders y mock-pay conservan verify_jwt = true (por defecto)
# public-orders usa verify_jwt = false y solo devuelve customerView para puestos mock públicos
```

### 4.3 Aplicar migraciones

```bash
supabase db push        # aplica 0001 → 0004 en el proyecto enlazado
```

Si falla en `0003` por la política de `realtime.messages`, es el punto **[VERIFICAR]** de la spec (B5): corrige
la sintaxis y vuelve a ejecutar `supabase db push`.

### 4.4 Cargar las palabras secretas

Meta: **300 palabras como mínimo** (la lista semilla de la spec trae 100). Cada palabra se valida con el ASR y el
TTS y no debe tener pares que suenen parecido. El archivo `seed/secret_words.csv` lleva encabezado `word,spoken`
(sin acentos en `word`, con acentos en `spoken`):

```csv
word,spoken
tortuga,tortuga
delfin,delfín
tiburon,tiburón
```

```bash
# DATABASE_URL = cadena de conexión de Settings → Database
psql "$DATABASE_URL" -c "\copy secret_words(word,spoken) from 'supabase/seed/secret_words.csv' csv header"
psql "$DATABASE_URL" -c "select count(*) from secret_words where active;"
```

El conteo debe ser ≥ 300. Si `pick_secret_word` devuelve `null`, la tabla está vacía.

### 4.5 Autenticación y datos iniciales

**Autenticación.** La spec usa OTP por SMS, que requiere un proveedor SMS configurado (por ejemplo Twilio).
Para el hackatón es más rápido:

- Dashboard → Authentication → Providers → **Email** (con contraseña), o
- Phone con **números de prueba** y OTP fijo (Authentication → Providers → Phone → Test numbers).

Crea el usuario en Authentication → Users y copia su `id` (UUID).

**Demo pública:** crea un usuario dedicado en Authentication → Users con contraseña privada. El presentador inicia
sesión en `merchant.html`; el jurado puede abrir `customer.html` sin credenciales. Nunca pongas la contraseña en
`config.js`. Después de crear el usuario, ejecuta `tools/deploy/link_demo_user.sql` en SQL Editor, sustituyendo el
correo en sus dos lugares, y copia el `STALL_ID` devuelto a `tools/simulator/config.js`. El puesto usa `provider = 'mock'`.

**Comerciante y puesto de prueba** (SQL Editor o `psql`):

```sql
insert into merchants (user_id, display_name)
values ('<USER_UUID>', 'Doña Carmen')
returning id;

insert into stalls (merchant_id, name, market, provider, public_announce)
values ('<MERCHANT_ID>', 'Pollería Doña Carmen', 'Mercado de prueba', 'mock', true)
returning id;      -- este es el STALL_ID que usan los clientes

insert into catalog_items (stall_id, name, aliases, unit, price_cents) values
  ('<STALL_ID>', 'pechuga',  '{pollo}',      'kg', 14000),
  ('<STALL_ID>', 'diezmillo','{}',           'kg', 24000),
  ('<STALL_ID>', 'chorizo',  '{}',           'kg', 16000),
  ('<STALL_ID>', 'jitomate', '{tomate}',     'kg',  3500);
```

Para cambiar al proveedor real después: `update stalls set provider='pey', provider_account_ref='<cuenta/CLABE en pey>' where id='<STALL_ID>';`

### 4.6 Realtime

- Dashboard → Realtime → Settings: **desactiva** el acceso público a canales (queremos solo canales privados con las políticas de `0003`).
- Comprueba que `realtime.messages` tiene la política `realtime_own_stall`.

### 4.7 Secretos y despliegue de funciones

```bash
cp .env.secrets.example .env.secrets      # rellena cada valor; NO lo subas a git
supabase secrets set --env-file .env.secrets
supabase secrets list                      # verifica los nombres

supabase functions deploy orders
supabase functions deploy webhooks
supabase functions deploy reconcile
supabase functions deploy mock-pay
supabase functions deploy public-orders --no-verify-jwt
```

URLs resultantes (las usará la app y el proveedor):

```
https://<PROJECT_REF>.supabase.co/functions/v1/orders
https://<PROJECT_REF>.supabase.co/functions/v1/webhooks/<provider>     # mock | pey
https://<PROJECT_REF>.supabase.co/functions/v1/reconcile
https://<PROJECT_REF>.supabase.co/functions/v1/mock-pay
```

### 4.8 Conciliación cada minuto (`pg_cron`)

Activa las extensiones `pg_cron`, `pg_net` y el Vault (Dashboard → Database → Extensions) y programa la llamada.
Reemplaza `<PROJECT_REF>` y `<CRON_SECRET>` (el mismo valor que pusiste en los secretos de las funciones).

```sql
select vault.create_secret('<CRON_SECRET>', 'cron_secret');

select cron.schedule(
  'reconcile-orders',
  '* * * * *',
  $$
  select net.http_post(
    url     := 'https://<PROJECT_REF>.supabase.co/functions/v1/reconcile',
    headers := jsonb_build_object(
                 'Content-Type', 'application/json',
                 'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')),
    body    := '{}'::jsonb
  );
  $$
);
```

Verificación: `select * from cron.job;` y, tras un par de minutos, `select * from cron.job_run_details order by start_time desc limit 5;`.
Para desactivar: `select cron.unschedule('reconcile-orders');`

---

## 5. Proveedor de pagos

### 5.1 Mock (Niveles 1 a 3)

Con `stalls.provider = 'mock'` todo el flujo corre sin banco:

1. La app crea una orden → el backend crea la carga en `mock_charges` y devuelve el QR simulado (`MOCKCODI|...`).
2. Se llama a `mock-pay` con el `chargeId` → marca la carga `settled` y envía el webhook firmado a `/webhooks/mock`.
3. El backend verifica firma, idempotencia, monto y `getStatus` → `PAID` → emite `order.paid`.

### 5.2 pey® (Nivel 4)

> `AGENTS.md` pide **no conectar dinero real para la demo**. Los pagos de prueba de pey son de $0.01 y no se
> devuelven, así que usarlos es una decisión del dueño del proyecto. Esta sección queda como referencia para después
> de la demo o para una prueba aislada, nunca como parte del recorrido público del simulador.

Lo que dice la hoja del evento y lo que sigue pendiente:

- Las **CLABEs pre-autorizadas** del evento se dan de alta en `portal.pey.mx` para empezar a usar el API el mismo día.
  El alta real ante Banxico tarda unos cinco días.
- Los pagos de prueba son de **$0.01** y **no se devuelven**.
- Cada equipo registra sus **propias cuentas CLABE** para publicar el proyecto cuando estén activas.
- La documentación del API y los webhooks está en `docs.pey.mx`; la hoja menciona `/codi/pn` para notificaciones
  **[VERIFICAR el path exacto y su formato en la documentación]**.

Checklist de integración:

- [ ] Implementar `providers/pey.ts` siguiendo la interfaz `PaymentProvider` con los endpoints reales de `docs.pey.mx`.
- [ ] Confirmar qué campo de referencia devuelve pey en el webhook (debe regresar `order.id` o algo que permita mapearlo).
- [ ] Implementar `verifyWebhook` con **el esquema de firma real** de pey (encabezado, algoritmo y tolerancia de tiempo).
- [ ] Confirmar si el evento trae la **clave de rastreo** (`tracking_key`).
- [ ] Registrar en pey la URL de webhook: `https://<PROJECT_REF>.supabase.co/functions/v1/webhooks/pey`.
- [ ] Cargar `PEY_*` con `supabase secrets set`, y `MIN_AMOUNT_CENTS=1` mientras pruebes con $0.01.
- [ ] `update stalls set provider='pey', provider_account_ref=... where id='<STALL_ID>';`
- [ ] Poner `ENABLE_MOCK_PAY=false` (o quitar la función) en cuanto el flujo real funcione.
- [ ] Probar la notificación **en el banco elegido**: la hoja pide validarlas antes de prometer.
- [ ] Documentar en el README qué pasa con pagos tardíos, fallas y devoluciones (la spec ya define `PAID_LATE` como bandera `late_payment`).

> Un pago confirmado **no prueba identidad ni entrega**. La entrega la valida el comerciante con su Palabra Secreta.

---

## 6. Simulador web y Vercel (link público)

**Estado actual:** el proyecto de Vercel ya está enlazado al repositorio
([copiloto-zeroui.vercel.app](https://copiloto-zeroui.vercel.app/)). `main` es la rama de producción y cada push a
`main` se despliega automáticamente. `vercel.json` fija `framework: null` y `outputDirectory: "tools/simulator"`, sin paso
de compilación. Hoy `tools/simulator/index.html` es solo una pantalla de arranque.

**Qué debe cumplir el simulador** (`docs/PLAN_DEMO.md`):

- Vistas separadas de **Comerciante** y **Cliente**, con la indicación visible **"Modo demo / sin dinero real"**.
- El cliente ve número de orden, monto y un QR **claramente simulado**, y nunca la palabra antes de `PAID`.
- El botón del comerciante llama a `mock-pay` en el servidor. **Ninguna acción del navegador puede marcar un pago como confirmado.**
- El presentador usa sus credenciales privadas; el jurado abre la vista del cliente sin iniciar sesión.

### Opción A (recomendada): estático, sin compilación

No requiere cambiar `vercel.json`. Estructura sugerida dentro de `tools/simulator/`:

```
index.html        # elige vista (o redirige)
merchant.html     # tarjetas de órdenes con palabra privada, teclado manual, efectivo, cancelar
customer.html     # QR simulado + monto + número; anuncio con palabra solo al pagar
config.js         # solo SUPABASE_URL, SUPABASE_ANON_KEY y STALL_ID público
```

- Carga `supabase-js` como módulo ESM desde un CDN, por ejemplo
  `import { createClient } from "https://esm.sh/@supabase/supabase-js@2"` **[VERIFICAR versión y URL]**.
- `config.js` puede versionarse: la **anon key es pública por diseño** y la protege RLS. La `service_role`
  **nunca** va aquí ni en ningún archivo servido por Vercel.
- El comerciante usa Realtime privado. El cliente consulta `public-orders` cada 3 segundos sin sesión.

Prueba local sin instalar nada del proyecto:

```bash
npx serve tools/simulator      # abre http://localhost:3000
```

### Opción B: con compilación (Vite)

Solo si prefieres un framework. Cambia `vercel.json` para compilar y servir la carpeta de salida:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "framework": null,
  "installCommand": "npm --prefix tools/simulator install",
  "buildCommand": "npm --prefix tools/simulator run build",
  "outputDirectory": "tools/simulator/dist"
}
```

Define `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` en Vercel (Settings → Environment Variables) y haz una
prueba local con `npm run dev` dentro de `tools/simulator`. Las variables `VITE_*` terminan dentro del paquete
publicado, así que tampoco aquí puede haber secretos.

### Despliegue y verificación

1. Trabaja en una rama y abre un PR: Vercel genera una URL de vista previa para probar antes de tocar producción.
2. Al fusionar en `main`, Vercel publica en `copiloto-zeroui.vercel.app`.
3. Agrega esa URL (y la de vista previa si la usas) a los orígenes permitidos de las Edge Functions (B6).
4. Abre el sitio en una ventana privada y ejecuta el recorrido de `docs/PLAN_DEMO.md` completo.

---

## 7. App Android

### 7.1 Configuración

```properties
# android/local.properties   (no versionar)
sdk.dir=/ruta/al/Android/Sdk
SUPABASE_URL=https://<PROJECT_REF>.supabase.co
SUPABASE_ANON_KEY=<anon key>
```

El `build.gradle.kts` del módulo `app` debe exponerlas como `BuildConfig.SUPABASE_URL` y `BuildConfig.SUPABASE_ANON_KEY`.
Configura también el mínimo de monto (`MIN_AMOUNT_CENTS`) como `BuildConfig` (brecha B1).

### 7.2 Nivel 2: compilar e instalar (modo manual)

```bash
cd android
./gradlew assembleDebug
adb devices
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

La app es un solo APK con dos modos:

| Dispositivo | Modo | Qué muestra |
|---|---|---|
| **M** (comerciante) | Comerciante | Tarjetas de órdenes con número, **palabra**, monto y estado; teclado manual; efectivo; corte |
| **C** (cliente) | Cliente | QR + monto + número de orden. **Nunca** muestra la palabra antes del pago |

Ambos inician sesión con la cuenta del comerciante en el MVP (decisión aceptada en la spec). En el dispositivo C
elige el modo Cliente y el mismo puesto.

Permisos a conceder en el primer arranque: micrófono, Bluetooth (`BLUETOOTH_CONNECT`), notificaciones y servicio en
primer plano de micrófono **[VERIFICAR contra el AndroidManifest del proyecto]**.

### 7.3 Nivel 3: voz

1. **whisper.cpp** como submódulo del proyecto (el repositorio pasó de `ggerganov/` a `ggml-org/`; GitHub redirige):
   ```bash
   git submodule add https://github.com/ggml-org/whisper.cpp android/app/src/main/cpp/whisper.cpp
   git submodule update --init --recursive
   ```
2. **Modelo de ASR** (≈ 60 MB; no se versiona en git):
   ```bash
   mkdir -p android/app/src/main/assets/models
   curl -L -o android/app/src/main/assets/models/ggml-base-q5_1.bin \
     https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin
   ```
   Compara con `ggml-small-q5_1.bin` en el spike S2 y elige según latencia (< 1.5 s para un comando de 4 s).
3. **Silero VAD** (`silero_vad.onnx`) en `android/app/src/main/assets/models/`, descargado del repositorio
   `snakers4/silero-vad` **[VERIFICAR la ruta vigente del archivo]**.
4. **Tonos** `earcon_paid.ogg`, `earcon_error.ogg`, `earcon_listening.ogg` en `res/raw/`.
5. Comprueba que NDK y CMake están instalados (SDK Manager) y recompila con `./gradlew assembleDebug`.
6. **Diadema Bluetooth:** empareja en Ajustes de Android antes de abrir la app. Si el audio se oye a 8 kHz (voz "de lata"),
   la diadema no usa mSBC: cambia de diadema o usa un micrófono USB-C (plan B del spike S1).

Palabras de activación del comerciante: `Cóbrale`, `Corrige`, `Cancela`, `Precio`, `Corte`, `Modo`, `Palabra/Repite`.
Todo lo que no empieza con una de ellas se ignora.

### 7.4 Distribución del APK

- Para el hackatón basta el **APK debug** adjunto a un *Release* de GitHub:
  ```bash
  gh release create v0.1.0 android/app/build/outputs/apk/debug/app-debug.apk \
    --title "Copiloto v0.1.0" --notes "APK debug. Modo Comerciante y Cliente."
  ```
- Para una versión firmada: genera un keystore, configura `signingConfigs` con variables de entorno y ejecuta
  `./gradlew assembleRelease`. **No subas el keystore ni sus contraseñas al repo.**

---

## 8. Desarrollo local (opcional, sin nube)

```bash
cd backend
supabase start                                   # Postgres + Auth + Realtime + Studio en Docker
supabase db reset                                # aplica las migraciones
psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" \
  -c "\copy secret_words(word,spoken) from 'supabase/seed/secret_words.csv' csv header"
supabase functions serve --env-file .env.secrets --no-verify-jwt
```

El Studio local queda en `http://127.0.0.1:54323` y la API en `http://127.0.0.1:54321`. Usa esas URLs y la anon key
que imprime `supabase start` en `.env.local` del simulador y en `local.properties`.
Para el emulador de Android, apunta a `http://10.0.2.2:54321`.

---

## 9. Verificación de punta a punta (con Mock)

Variables de apoyo:

```bash
export SUPABASE_URL=https://<PROJECT_REF>.supabase.co
export ANON=<anon key>
export STALL_ID=<STALL_ID>
export JWT=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" \
  -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"email":"<correo>","password":"<contraseña>"}' | jq -r .access_token)
```

**1. Crear una orden CoDi**

```bash
curl -s -X POST "$SUPABASE_URL/functions/v1/orders" \
  -H "Authorization: Bearer $JWT" -H "apikey: $ANON" -H "Content-Type: application/json" \
  -d '{"stallId":"'$STALL_ID'","amountCents":24000,"amountSource":"spoken","method":"codi",
       "items":[{"product":"diezmillo","qty":1,"unit":"kg"}],
       "utterance":"cobrale doscientos cuarenta","idempotencyKey":"'$(uuidgen)'"}' | tee /tmp/order.json | jq
```

Esperado: `state = AWAITING_PAYMENT`, `number`, `secretWord`, `expiresAt` a 180 s. La pantalla del cliente muestra el QR **sin** palabra.

**2. Simular el pago**

```bash
CHARGE_ID=$(psql "$DATABASE_URL" -Atc \
  "select provider_charge_id from orders where id='$(jq -r .orderId /tmp/order.json)'")
curl -s -X POST "$SUPABASE_URL/functions/v1/mock-pay" \
  -H "Authorization: Bearer $JWT" -H "apikey: $ANON" \
  -H "Content-Type: application/json" \
  -d '{"chargeId":"'$CHARGE_ID'"}'
```

Esperado: la orden pasa a `PAID`; el comerciante ve la tarjeta en verde; el cliente oye el tono y
"Orden N, *palabra*, pagada".

### Lista de pruebas (C5.3 de la spec)

- [ ] Cobro → pago simulado → verde + anuncio con la palabra correcta.
- [ ] **Webhook duplicado:** `mock-pay` dos veces con el mismo `eventId` → un solo anuncio (`payment_events` tiene una fila).
- [ ] **Firma inválida o monto distinto:** responde 401 o queda registrado en `audit_log` (`amount_mismatch`, `ref_mismatch`).
- [ ] **Pago después de cancelar o expirar:** `late_payment = true` y aviso privado.
- [ ] **Caída del WebSocket** durante la espera: el polling cada 5 s recupera el estado.
- [ ] **Dos órdenes simultáneas:** palabras distintas y anuncio de la correcta.
- [ ] **Palabra nunca en `/public-orders` antes del pago** (revisar la respuesta HTTP sin iniciar sesión).
- [ ] **Efectivo** (`method:"cash"`): queda `PAID_CASH` sin QR ni palabra.
- [ ] **Sin conexión:** el audífono dice "Sin conexión. Cobra en efectivo." y la venta en efectivo se sincroniza después (outbox).
- [ ] **Idempotencia:** repetir la misma `idempotencyKey` devuelve la misma orden, no una nueva.
- [ ] Golden set del parser al 100 % (`tools/eval`, Nivel 3).

---

## 10. Entrega del hackatón

Checklist del formulario de entrega (domingo 15 de noviembre, 1:00 PM hora CDMX; un proyecto por equipo):

- [ ] **Repositorio público** (obligatorio) con este `DEPLOY.md`, un `README.md` y `.env.example` (sin secretos).
- [ ] **Link de la app en vivo** (preferido): `https://copiloto-zeroui.vercel.app/` (el simulador del punto 6), con el letrero **Modo demo / sin dinero real** visible.
- [ ] **Video demo** (opcional): orden manual o por voz → QR simulado → pago simulado → anuncio con número y palabra → intento con captura/audio falso que no cambia el estado → evento duplicado que no se anuncia dos veces.
- [ ] Nombre del equipo, descripción y correos de los integrantes.
- [ ] El README explica qué ocurre con **pagos tardíos, fallas y devoluciones** (pide la hoja de pey).
- [ ] Antes de cada push a `main` (regla de `AGENTS.md`): la página de Vercel carga y el `README.md` describe el estado real (qué funciona, qué es simulado y qué falta).
- [ ] Criterios de "demo lista" de `docs/PLAN_DEMO.md`: URL pública sin errores, recorrido ejecutable desde cero sin credenciales del jurado, vista del cliente sin palabra antes de `PAID`.
- [ ] Revisión final: `git grep -nE "service_role|PEY_API_KEY|sk_|secret" -- ':!*.md'` no devuelve claves reales.

---

## 11. Operación

| Tarea | Cómo |
|---|---|
| Ver logs de una función | Dashboard → Edge Functions → *Logs*, o `supabase functions logs <nombre>` según la versión del CLI |
| Ver transiciones y discrepancias | `select * from audit_log order by at desc limit 50;` |
| Órdenes atascadas | `select number,state,expires_at from orders where state in ('AWAITING_PAYMENT','PENDING_UNKNOWN');` |
| Rotar un secreto | `supabase secrets set NOMBRE=nuevo` y redeploy de las funciones que lo usan; en cron, `vault.update_secret` |
| Apagar el simulador de pagos | `supabase secrets set ENABLE_MOCK_PAY=false` |
| Revertir funciones | `git checkout <tag>` y `supabase functions deploy <nombre>` |
| Revertir esquema | No hay migraciones *down*: en local `supabase db reset`; en la nube, una migración correctiva nueva |
| Retención de transcripciones | La spec fija 30 días: programa un `delete` periódico sobre `orders.utterance_text` **[pendiente de implementar]** |
| Robo de un dispositivo | Revocar sesiones del usuario en Authentication → Users |

---

## 12. Solución de problemas

| Síntoma | Causa probable | Solución |
|---|---|---|
| La orden queda en `PENDING_UNKNOWN` tras pagar | `getStatus` del Mock devuelve `pending` (brecha B2) | Crear `mock_charges` y que `mock-pay` la marque `settled` antes del webhook |
| `/webhooks/...` responde 401 | Firma o timestamp inválidos, o JWT exigido | Mismo `MOCK_WEBHOOK_SECRET` en ambos lados; reloj correcto (±5 min); `verify_jwt = false` |
| `422 monto` al crear la orden | Monto bajo el mínimo | Ajusta `MIN_AMOUNT_CENTS` (brecha B1) |
| El cliente no actualiza la orden | `public-orders` sin desplegar, puesto sin `public_announce`, o polling sin conexión | Despliega `public-orders`, comprueba el `STALL_ID` y revisa la respuesta de la función |
| `permission denied` / RLS al escribir órdenes | La app intenta escribir directo | Las órdenes solo se escriben desde Edge Functions (`service_role`) |
| `pick_secret_word` devuelve `null` | Tabla `secret_words` vacía | Cargar el CSV (sección 4.4) |
| `duplicate key ... orders_active_word` | Pocas palabras para las órdenes activas | Ampliar la lista a ≥ 300 |
| `reconcile` nunca corre | Extensiones o cron sin configurar | Revisar `cron.job` y `cron.job_run_details`; header `x-cron-secret` |
| Error CORS en el simulador | Faltan encabezados en la función | Implementar `OPTIONS` y `Access-Control-*` (B6) |
| Whisper "alucina" frases | Ruido o silencio | Descartar si `no_speech_prob > 0.6` o si no empieza con palabra de activación |
| La voz de la diadema suena a 8 kHz | HFP sin mSBC | Otra diadema o micrófono USB-C (plan B de S1) |
| El botón de la diadema no responde | SCO activo bloquea `MediaSession` | Spike S4; plan B: botón Bluetooth independiente |
| El APK no instala | Firma o versión distinta ya instalada | `adb uninstall mx.copiloto` y reinstalar **[VERIFICAR applicationId]** |

---

## 13. Pendientes por verificar (heredados de la spec)

- Proveedor **pey®**: API real, firma de webhooks, comisiones, SLA y estado ante Banxico/CNBV.
- Estado vigente de CoDi / DiMo y cifras del documento original.
- Sintaxis vigente de *Supabase Realtime Authorization* y de `realtime.send`.
- Viabilidad y términos de la consulta automatizada del CEP de Banxico (Fase 3).
- Calidad de audio HFP/mSBC de las diademas elegidas.
- Licencias: whisper.cpp (MIT), modelos Whisper (MIT), Silero VAD (MIT), voces TTS del sistema.
- Requisitos de la LFPDPPP vigente para captura de voz en un espacio público (cartel con aviso de privacidad en el puesto).
- Equivalencia regional de "cuarto y medio / cuarto y mitad".
