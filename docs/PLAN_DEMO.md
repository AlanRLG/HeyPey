# Plan de demo

## Recorrido objetivo

1. Un comerciante ingresa manualmente un monto y crea una orden de prueba.
2. El simulador muestra al cliente número de orden, monto y un QR **claramente simulado**, sin palabra secreta.
3. El comerciante recibe en su vista privada la palabra asignada a esa orden.
4. `MockProvider` emite un evento de pago de prueba; el servidor valida monto, referencia e idempotencia.
5. Solo entonces la orden pasa a `PAID` y la vista pública anuncia número más palabra.
6. Se repite con una segunda orden para demostrar palabras distintas y se prueba un evento duplicado para mostrar que no se anuncia dos veces.

## Alcance inicial recomendado

- Backend: esquema de órdenes, selección de palabras, `MockProvider`, endpoint para crear orden y endpoint de pago simulado.
- Web: vistas separadas de comerciante y cliente, con indicación visible **Modo demo / sin dinero real**.
- Estados mínimos: `CREATING`, `AWAITING_PAYMENT`, `PAID`, `PAID_CASH`, `EXPIRED`, `CANCELLED` y `FAILED`.
- Pruebas: evento duplicado, monto distinto, cancelación, dos órdenes activas y palabra no expuesta antes de pagar.

La voz, el hardware Bluetooth, el proveedor real y los pagos CoDi quedan para etapas posteriores de la especificación. La entrega del hack puede mostrar el concepto mediante el simulador, siempre que su carácter simulado sea claro.

## Criterios para decir “demo lista”

- El despliegue de Vercel abre sin errores desde una URL pública.
- El recorrido anterior puede ejecutarse desde cero sin credenciales especiales del jurado.
- La vista del cliente nunca contiene la palabra antes de `PAID`.
- Ninguna acción del navegador puede marcar un pago real como confirmado.
- El README indica qué funciona, qué es simulado y qué falta.

## Pendientes por verificar antes de producción

Proveedor de pagos y firma de webhooks; sintaxis vigente de Supabase Realtime Authorization; calidad y latencia de audio Bluetooth; licencia de componentes de voz; privacidad de voz en espacios públicos.
