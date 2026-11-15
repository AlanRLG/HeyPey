# HeyPEY

**Di el importe. Revisa el cobro. Confirma el pago.**

HeyPEY ayuda a un comerciante a preparar cobros por voz o teclado. El cliente ve el monto y un QR. En el flujo conectado, una palabra de confirmación aparece en su pantalla **solo después de que el servidor verifica el pago**.

## Pruébalo en un minuto

Abre la **[demo pública](https://copiloto-zeroui.vercel.app/demo)**. No necesitas cuenta ni dinero.

1. Deja el importe en **$0.01** o escribe otro. Si usas Chrome, también puedes pulsar **Activar HeyPEY**, aceptar el permiso de micrófono y decir «HeyPEY, cóbrale un centavo».
2. Pulsa **Crear cobro de ejemplo**. El comerciante ve una palabra privada; el cliente ve el monto y un QR ilustrativo, pero aún no ve la palabra.
3. Pulsa **Simular pago**. Ahora el cliente ve la misma palabra.

Este recorrido sucede en tu navegador: **no crea una orden ni mueve dinero**. El QR no sirve para pagar. El dictado es opcional; puedes completar toda la prueba escribiendo el importe.

## Qué está verificado

- **Pey real:** una transferencia de **$0.01 MXN** quedó confirmada por webhook; la orden pasó a `PAID` y la palabra pública coincidió con la privada.
- **Backend conectado:** el flujo con MockProvider pasó **19 de 19 comprobaciones** en Supabase, sin mover dinero.
- **Demo pública:** reproduce los pasos para que el jurado pueda explorarlos sin credenciales. Está marcada como simulación y separada del cobro real.

La [vista pública del cliente](https://copiloto-zeroui.vercel.app/cliente?modo=pey) consulta el estado del backend Pey. Crear órdenes reales requiere la cuenta privada del comerciante y una confirmación adicional.

## Alcance actual

La web permite dictar o escribir el importe, revisarlo y crear órdenes. La activación por «HeyPEY» funciona en navegadores compatibles mientras la pestaña está visible; puede utilizar el servicio de reconocimiento del navegador. **Android, Bluetooth y el reconocimiento local propio** siguen pendientes.

## Código y documentación

- [`tools/frontend/`](tools/frontend/) — interfaz React y Vite.
- [`backend/supabase/`](backend/supabase/) — órdenes, proveedores de pago, webhooks y conciliación.
- [`docs/PLAN_DEMO.md`](docs/PLAN_DEMO.md) — recorrido y diferencias entre los modos de prueba.
- [`DEPLOY.md`](DEPLOY.md) — configuración, despliegue y pruebas técnicas.

Para abrir la interfaz localmente: `cd tools/frontend`, `npm ci`, `npm run dev`.
