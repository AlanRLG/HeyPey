# HeyPEY · Copiloto Acústico Zero-UI

Proyecto para el hack de Cursor. El producto permite a un comerciante preparar cobros y confirmar pagos con una **palabra secreta de un solo uso**. La prueba del pago viene de un evento verificado por el servidor. En la web, el comerciante puede dictar el importe o activar HeyPEY para empezar a dictarlo con una frase; Android y el reconocimiento local propio siguen pendientes.

## Estado

**Nivel 1 verificado en Supabase con MockProvider, y una orden pey de $0.01 ya cobrada.** Las migraciones `0006`–`0009` y las funciones `orders`, `webhooks`, `reconcile`, `mock-pay`, `public-orders`, `catalog` y `summary` están desplegadas. `tools/test/e2e_mock_remote.mjs` pasó **19/19** comprobaciones del flujo Mock. El cron `reconcile-orders` respondió HTTP 200. El puesto demo sigue en `mock`. El puesto pey `343eff54-061f-434c-b0fd-2611c058092d` deja `provider_account_ref` en null: al omitir `bankAccountId`, el cobro usa la cuenta CoDi ligada a la API key.

El código y `backend/.env.secrets.example` traen `PEY_LIVE_ENABLED=false`, `MIN_AMOUNT_CENTS=500` y `ORDER_TTL_SECONDS=180`. En Supabase, durante la preparación de la demo, esos tres valores están en `true`, `1` y `900`. El repositorio no los cambia.

La prueba que cuenta es una sola orden de $0.01: pasó a `PAID` porque el webhook de pey entró, la palabra pública coincidió con la privada y el banco mostró un solo cargo. Hubo un QR anterior que venció sin pago; ese intento no es la prueba exitosa.

| Funciona | Es simulado | Falta |
|---|---|---|
| Órdenes con número diario y palabra de un solo uso (24 h, o últimas 200); idempotencia; reintento si el QR falló; efectivo (`PAID_CASH`); corrección; lectura de una orden; catálogo y corte del día. En la web, «Dictar importe» y HeyPEY solo rellenan el monto del comerciante y no crean la orden | El banco (`MockProvider`, tabla `mock_charges`) y el QR (`MOCKCODI|SIMULADO|...`, no es CoDi válido). El reconocimiento web puede salir del dispositivo si el navegador no tiene modo local | App Android, Bluetooth y el reconocimiento local propio (VAD, whisper.cpp). El simulador web aún no llama a corregir, catálogo ni corte |
| Webhook firmado (HMAC en mock, Standard Webhooks en pey). El pago se marca solo si `GET /transaction/{id}` confirma id, `PAID`, `API_CODI_QR`, el QR, `CODI`, `MXN`, el monto y la orden. Una orden de $0.01 llegó a `PAID` por ese webhook | El botón del comerciante llama a `/mock-pay`, solo para puestos `provider = 'mock'` | No repetir el cobro. El QR que venció sin pago no cuenta como prueba |
| La vista pública consulta `/public-orders` para un puesto `mock` o `pey` con `public_announce`. La palabra aparece **solo** en un `PAID` que no sea tardío. En la orden de $0.01 esa palabra coincidió | Cuenta y puesto de demo con datos ficticios, proveedor `mock`. El puesto pey no guarda cuenta propia | El simulador público sigue sin `STALL_ID` |
| Pago tardío: la orden cancelada o expirada pasa a `PAID` con `late_payment`; el aviso es solo del comerciante | | |
| Conciliación: si el proveedor no contesta, `PENDING_UNKNOWN` hasta 30 min y luego alerta, sin darla por expirada. `purge_old_utterances` borra transcripciones a los 30 días | | |

El despliegue en la nube se describe en [DEPLOY.md](DEPLOY.md). La nueva interfaz React vive en `tools/frontend/`; su `public/config.js` contiene únicamente la URL de Supabase, la clave pública `anon` y los IDs públicos de los puestos Mock y Pey. El comerciante inicia sesión para crear órdenes; la vista del cliente consulta `public-orders` sin sesión. Para el Mock alojado, define `TEST_STALL_ID` con el UUID del puesto demo y ejecuta `node tools/test/e2e_mock_remote.mjs`. `node tools/test/e2e_pey_remote.mjs` solo lee; crear un QR pide la frase `CREAR QR DE UN CENTAVO` y reutiliza la clave de `tools/test/.pey-cent/`, carpeta ignorada por Git. Esa carpeta no se versiona. Ninguno de los dos scripts guarda ni imprime la contraseña ni el JWT.

Frontend: [copiloto-zeroui.vercel.app](https://copiloto-zeroui.vercel.app/) (al publicar este commit: `/demo` muestra ambas vistas lado a lado; `/comerciante` muestra solo la vista privada y ofrece Mock y Pey después de iniciar sesión; `/cliente` muestra solo la vista pública). En dos dispositivos, abre `/comerciante` en el del vendedor y `/cliente` en el que mira el comprador, con el mismo proveedor seleccionado. La demo predeterminada usa Mock y no mueve dinero; generar un QR real de Pey exige una segunda confirmación. Los cambios en `main` se despliegan automáticamente con Vercel.

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
backend/supabase/       Migraciones 0001–0009 y Edge Functions (orders, webhooks, reconcile, mock-pay, public-orders, catalog, summary)
android/                App Kotlin, modos Comerciante y Cliente (por construir)
tools/frontend/         Frontend React/Vite con shadcn/ui, React Bits y rutas de demo
tools/simulator/        Simulador estático anterior, conservado como referencia
tools/deploy/           Despliegue a la nube, cuenta demo y prueba de punta a punta
tools/test/             Pruebas del backend Mock contra Postgres embebido (`npm test`) y Supabase alojado
tools/words/            Genera la migración de palabras desde data/words/
tools/eval/             Evaluación de audio y parser (por construir)
data/golden/            Casos de referencia del parser (por construir)
data/words/             Banco de 311 palabras secretas ([VERIFICAR] con ASR/TTS)
docs/                   Alcance y plan de demo
```

## Enfoque para la demo

El flujo con `MockProvider` ya está construido: el comerciante escribe o dicta el importe, crea la orden, muestra un QR de prueba, simula el pago, el servidor verifica el evento y la vista pública anuncia el número con la palabra correcta. «Activar HeyPEY» en la vista privada enciende la escucha solo mientras la pestaña siga activa; después de «HeyPEY», acepta el importe en esa frase o en la siguiente. Se apaga cuando obtiene un monto, el comerciante lo apaga o cambia de pestaña. Dictar no crea la orden ni confirma el pago. Si el navegador no reconoce la voz en el dispositivo, pide aceptación porque puede enviarla a su servicio; esta app no guarda audio ni transcripciones. Pey ya está integrado y quedó verificado con una transferencia real de $0.01 por webhook. La interfaz React muestra ambos puestos; solo la vista autenticada del comerciante puede generar un QR real. Faltan Android, Bluetooth y el reconocimiento local propio. Ver [plan de demo](docs/PLAN_DEMO.md).

## Configuración de Vercel

El proyecto ya está enlazado a este repositorio. Usa la raíz `/` y `main` como rama de producción. `vercel.json` instala y compila `tools/frontend`, sirve `tools/frontend/dist` y reescribe las rutas de la app a `index.html`. La configuración pública vive en `tools/frontend/public/config.js`. Nunca expongas contraseñas, tokens de pago, claves `service_role` ni secretos del proveedor en archivos servidos por Vercel.

## Principios que debe conservar la implementación

- Solo el servidor decide el estado de una orden y valida el evento firmado del proveedor.
- La palabra secreta se genera en el servidor, se comunica al comerciante en privado y no aparece en la vista del cliente antes de un pago verificado.
- El monto final lo determina o confirma el comerciante; el cliente lo ve antes de pagar.
- La app no almacena audio ni transcripciones. Si el navegador no tiene reconocimiento local y el comerciante acepta, su servicio de reconocimiento puede recibir la voz.
- `MockProvider` permite desarrollar y demostrar sin credenciales ni dinero real.

Los detalles del proveedor, políticas de Realtime, licencias de modelos y requisitos legales siguen marcados **por verificar** en el documento original.

## Abrir en Cursor

Abre la carpeta raíz del repositorio. Cursor leerá `AGENTS.md` como contexto del proyecto. Para trabajar en el frontend, entra a `tools/frontend`, ejecuta `npm ci` y `npm run dev`. La activación HeyPEY de la web requiere permiso del micrófono y una pestaña visible; no funciona como escucha permanente del sistema. La app Android y el reconocimiento local propio siguen pendientes.
