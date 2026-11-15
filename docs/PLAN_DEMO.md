# Plan de demo

## Recorrido objetivo

1. Abre `/demo` en Vercel e inicia sesión como comerciante con las credenciales privadas del presentador.
2. Ingresa manualmente un monto y crea una orden de prueba Mock. La pantalla del cliente muestra número, monto y un QR **claramente simulado**, sin palabra secreta.
3. El comerciante recibe en su vista privada la palabra asignada a esa orden.
4. `MockProvider` emite un evento de pago de prueba; el servidor valida monto, referencia e idempotencia.
5. Solo entonces la orden pasa a `PAID` y la vista pública anuncia número más palabra.
6. Se repite con una segunda orden para demostrar palabras distintas y se prueba un evento duplicado para mostrar que no se anuncia dos veces.

## Alcance de la demo web

- Backend: esquema de órdenes, selección de palabras, `MockProvider`, endpoint para crear orden y endpoint de pago simulado.
- Web: `/demo` muestra comerciante y cliente lado a lado para el jurado. En dos dispositivos, `/comerciante` muestra solo la vista privada y `/cliente` solo la pública, sin credenciales. El modo Mock indica **sin dinero real**.
- Estados mínimos: `CREATING`, `AWAITING_PAYMENT`, `PAID`, `PAID_CASH`, `EXPIRED`, `CANCELLED` y `FAILED`.
- Pruebas: evento duplicado, monto distinto, cancelación, dos órdenes activas y palabra no expuesta antes de pagar.

Pey ya confirmó una transferencia real de $0.01 por webhook y la palabra pública coincidió. `/comerciante?modo=pey` permite preparar un QR real después de iniciar sesión y confirmar dos veces; no es necesario cobrar de nuevo para mostrar la demo Mock. La entrada de voz, el hardware Bluetooth y Android siguen pendientes.

## Criterios para decir “demo lista”

- El despliegue de Vercel abre sin errores desde una URL pública.
- El presentador inicia sesión como comerciante; el jurado puede abrir la vista del cliente sin credenciales.
- La vista del cliente nunca contiene la palabra antes de `PAID`.
- Ninguna acción del navegador puede marcar un pago real como confirmado.
- El README indica qué funciona, qué es simulado y qué falta.

## Pendientes por verificar antes de producción

Devoluciones, un segundo cobro y una conciliación Pey sin webhook; sintaxis vigente de Supabase Realtime Authorization; calidad y latencia de audio Bluetooth; licencia de componentes de voz; privacidad de voz en espacios públicos.
