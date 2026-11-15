# Copiloto Acústico Zero-UI

Repositorio base para el hack de Cursor. El producto propuesto permite a un comerciante preparar cobros con la voz y confirmar pagos con una **palabra secreta de un solo uso**. La voz es la interfaz; la prueba del pago debe venir de un evento verificado por el servidor.

## Estado

**Nivel 1 construido y verificado en Supabase con MockProvider, sin dinero real.** Las migraciones `0006`–`0008` están aplicadas en el proyecto de demo; se desplegaron `orders`, `mock-pay`, `catalog`, `summary`, `webhooks`, `reconcile` y `public-orders`. La prueba alojada `tools/test/e2e_mock_remote.mjs` pasó 19 comprobaciones: login, orden, pago simulado, webhook duplicado, monto incorrecto, pago tardío, efectivo y corte. Las reglas de base también se comprueban con `npm test` en `tools/test` (Postgres embebido, sin red). El adaptador pey está escrito y cubierto con HTTP falso; `PEY_LIVE_ENABLED` permanece en `false`.

| Funciona | Es simulado | Falta |
|---|---|---|
| Órdenes con número diario y palabra de un solo uso (24 h, o últimas 200); idempotencia; reintento si el QR falló; efectivo (`PAID_CASH`); corrección; lectura de una orden; catálogo y corte del día | El banco (`MockProvider`, tabla `mock_charges`) y el QR (`MOCKCODI|SIMULADO|...`, no es CoDi válido) | Voz (VAD, whisper.cpp, parser), app Android. El simulador web aún no llama a corregir, catálogo ni corte |
| Webhook firmado (HMAC en mock, Standard Webhooks en pey). El pago se marca con el identificador y el monto que devuelve el proveedor | El botón del comerciante llama a `/mock-pay`, solo para puestos `provider = 'mock'` y usuarios dueños | Activar pey: hace falta una clave rotada, `PEY_LIVE_ENABLED=true` y un puesto `provider='pey'`. Hoy no hay cobros reales |
| La vista pública consulta `/public-orders`: la palabra aparece **solo** en un `PAID` que no sea tardío | Cuenta y puesto de demo con datos ficticios | |
| Pago tardío: la orden cancelada o expirada pasa a `PAID` con `late_payment`; el aviso es solo del comerciante | | |
| Conciliación: si el proveedor no contesta, `PENDING_UNKNOWN` hasta 30 min y luego alerta, sin darla por expirada. `purge_old_utterances` borra transcripciones a los 30 días | | |

El despliegue en la nube se describe en [DEPLOY.md](DEPLOY.md). El usuario y puesto de prueba están vinculados en Supabase; el `STALL_ID` público sigue vacío en `tools/simulator/config.js`, por lo que la página muestra “Simulador sin configurar”. Para probar el backend alojado desde una terminal, define `TEST_STALL_ID` con el UUID del puesto y ejecuta `node tools/test/e2e_mock_remote.mjs`; el script pide las credenciales de la cuenta demo sin guardarlas en el repo.

Simulador: [copiloto-zeroui.vercel.app](https://copiloto-zeroui.vercel.app/) (`demo.html` muestra comerciante y cliente lado a lado). Los cambios en `main` se despliegan automáticamente con Vercel.

### Pagos tardíos, fallas y devoluciones

- **Pago tardío** (llega después de cancelar o expirar): la orden pasa a `PAID` con `late_payment = true`, queda en `audit_log` y el aviso es solo para el comerciante. La vista pública no recibe la palabra. La devolución es manual.
- **Falla del proveedor al crear la carga**: la orden pasa a `FAILED` y no se muestra QR.
- **Webhook con firma inválida**: 401 y registro `invalid_signature`; no cambia nada.
- **Monto o referencia distintos**: se registra `amount_mismatch` / `ref_mismatch`; la orden sigue esperando pago.
- **Webhook dice pagado pero el proveedor no lo confirma**: `PENDING_UNKNOWN`. La conciliación reintenta con espera creciente hasta 30 min y, si el proveedor sigue sin contestar, deja una alerta. No marca `PAID`.
- **Devoluciones**: no automatizadas en el MVP. [VERIFICAR] política y API de devoluciones de pey®.

La especificación de referencia es `Modulo2_Copiloto_Acustico_ZeroUI_v3.pdf`, entregada por el autor del proyecto. No se incluye el PDF en el repositorio para evitar publicar un documento de trabajo sin necesidad.

## Estructura

```text
backend/supabase/       Migraciones 0001–0008 y Edge Functions (orders, webhooks, reconcile, mock-pay, public-orders, catalog, summary)
android/                App Kotlin, modos Comerciante y Cliente (por construir)
tools/simulator/        Simulador web estático (comerciante, cliente, demo lado a lado)
tools/deploy/           Despliegue a la nube, cuenta demo y prueba de punta a punta
tools/test/             Pruebas del backend Mock contra Postgres embebido (`npm test`) y Supabase alojado
tools/words/            Genera la migración de palabras desde data/words/
tools/eval/             Evaluación de audio y parser (por construir)
data/golden/            Casos de referencia del parser (por construir)
data/words/             Banco de 311 palabras secretas ([VERIFICAR] con ASR/TTS)
docs/                   Alcance y plan de demo
```

## Enfoque para la demo

Construir primero el flujo sin voz y con `MockProvider`: crear orden, mostrar QR de prueba, simular el pago, verificar el evento en el servidor y anunciar el número de orden con la palabra correcta. Después se integran Android, audio y proveedor real. Ver [plan de demo](docs/PLAN_DEMO.md).

## Configuración de Vercel

El proyecto ya está enlazado a este repositorio. Usa la raíz `/` y `main` como rama de producción. `vercel.json` fija el preset **Other** y el directorio de salida `tools/simulator`. El simulador es estático (sin compilación); su configuración pública vive en `tools/simulator/config.js`. Contiene solo URL, clave `anon` y `STALL_ID`. Nunca expongas contraseñas, tokens de pago, claves `service_role` ni secretos del proveedor en archivos servidos por Vercel.

## Principios que debe conservar la implementación

- Solo el servidor decide el estado de una orden y valida el evento firmado del proveedor.
- La palabra secreta se genera en el servidor, se comunica al comerciante en privado y no aparece en la vista del cliente antes de un pago verificado.
- El monto final lo determina o confirma el comerciante; el cliente lo ve antes de pagar.
- Los audios se procesan localmente y no se almacenan ni se suben.
- `MockProvider` permite desarrollar y demostrar sin credenciales ni dinero real.

Los detalles del proveedor, políticas de Realtime, licencias de modelos y requisitos legales siguen marcados **por verificar** en el documento original.

## Abrir en Cursor

Abre la carpeta raíz del repositorio. Cursor leerá `AGENTS.md` como contexto del proyecto. Siguiente tarea recomendada: app Android en modo manual (Nivel 2 de `DEPLOY.md`), reutilizando las mismas Edge Functions.
