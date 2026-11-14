# Copiloto Acústico Zero-UI

Repositorio base para el hack de Cursor. El producto propuesto permite a un comerciante preparar cobros con la voz y confirmar pagos con una **palabra secreta de un solo uso**. La voz es la interfaz; la prueba del pago debe venir de un evento verificado por el servidor.

## Estado

**Nivel 1 construido (backend + MockProvider + simulador web), sin dinero real.** La versión original pasó 22 comprobaciones contra Supabase local. Tras separar los accesos, hay que volver a ejecutar `tools/deploy/e2e_mock.sh` con la cuenta nueva.

| Funciona | Es simulado | Falta |
|---|---|---|
| Órdenes con número diario y palabra secreta de un solo uso; idempotencia; efectivo (`PAID_CASH`); cancelación y vencimiento (cron + polling) | El banco (`MockProvider`, tabla `mock_charges`) y el QR (`MOCKCODI|SIMULADO|...`, no es CoDi válido) | Voz (VAD, whisper.cpp, parser), app Android |
| Webhook firmado (HMAC) con idempotencia, validación de referencia, monto y doble verificación con `getStatus` | El botón del comerciante llama a `/mock-pay`, solo para puestos `provider = 'mock'` y usuarios dueños | Adaptador pey® (`providers/pey.ts` es un stub a propósito) |
| La vista pública del cliente consulta `/public-orders`: la palabra aparece **solo** al pasar a `PAID`; el comerciante inicia sesión manualmente | Cuenta y puesto de demo con datos ficticios | Retención de 30 días de transcripciones |
| Pago tardío (después de cancelar/expirar) marcado como `late_payment` y aviso privado al comerciante | | |

El despliegue en la nube se hace con `tools/deploy/deploy_cloud.sh` (ver [DEPLOY.md](DEPLOY.md)). Tras reemplazar al usuario de demo, hay que crear y vincular un puesto nuevo con `tools/deploy/link_demo_user.sql`, poner su `STALL_ID` público en `tools/simulator/config.js` y desplegar `public-orders` y `mock-pay` en Supabase. Mientras `STALL_ID` esté vacío, la página muestra “Simulador sin configurar”.

Simulador: [copiloto-zeroui.vercel.app](https://copiloto-zeroui.vercel.app/) (`demo.html` muestra comerciante y cliente lado a lado). Los cambios en `main` se despliegan automáticamente con Vercel.

### Pagos tardíos, fallas y devoluciones

- **Pago tardío** (llega después de cancelar o expirar): la orden no cambia de estado, se marca `late_payment = true`, se registra en `audit_log` y el comerciante recibe un aviso privado. La devolución es manual con el proveedor.
- **Falla del proveedor al crear la carga**: la orden pasa a `FAILED` y no se muestra QR.
- **Webhook con firma inválida**: 401 y registro `invalid_signature`; no cambia nada.
- **Monto o referencia distintos**: se registra `amount_mismatch` / `ref_mismatch`; la orden sigue esperando pago.
- **Webhook dice pagado pero el proveedor no lo confirma**: `PENDING_UNKNOWN`; la conciliación vuelve a consultar cada minuto.
- **Devoluciones**: no automatizadas en el MVP. [VERIFICAR] política y API de devoluciones de pey®.

La especificación de referencia es `Modulo2_Copiloto_Acustico_ZeroUI_v3.pdf`, entregada por el autor del proyecto. No se incluye el PDF en el repositorio para evitar publicar un documento de trabajo sin necesidad.

## Estructura

```text
backend/supabase/       Migraciones 0001–0005 y Edge Functions (orders, webhooks, reconcile, mock-pay, public-orders)
android/                App Kotlin, modos Comerciante y Cliente (por construir)
tools/simulator/        Simulador web estático (comerciante, cliente, demo lado a lado)
tools/deploy/           Despliegue a la nube, cuenta demo y prueba de punta a punta
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
