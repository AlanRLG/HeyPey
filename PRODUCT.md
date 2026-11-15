# Copiloto Acústico Zero-UI

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Comerciante que cobra en un puesto, frente a una persona que espera su pedido.
- Cliente que consulta el importe y recibe una palabra de entrega solo después de un pago confirmado.
- Jurado que necesita entender el flujo en pocos minutos sin credenciales propias.

## Product Purpose

Un cobro asigna un número y una palabra privada al comerciante. El servidor verifica el pago y, solo entonces, la pantalla pública anuncia la palabra. El modo Mock demuestra el flujo sin dinero; Pey ya confirmó una transferencia real de $0.01 mediante webhook.

## Operating Context

El comerciante y el cliente miran pantallas distintas a ambos lados de un mostrador. La demostración web debe funcionar en un portátil y en un teléfono. La voz y Android siguen pendientes.

## Capabilities and Constraints

- Supabase Auth protege las acciones del comerciante. `public-orders` expone solo datos aptos para el cliente.
- MockProvider y Pey usan puestos distintos. El pago real nunca se confirma desde el navegador.
- Importes en centavos enteros; la orden se crea con una clave de idempotencia estable.
- La UI no puede mostrar la palabra pública antes de `PAID` ni anunciar un pago tardío.
- El simulador Mock debe estar identificado como prueba sin dinero real.

## Evidence on Hand

- Un pago real de $0.01 llegó a `PAID` por webhook y mostró la palabra correcta. El banco registró un cargo.
- El backend Mock alojado pasó 19 comprobaciones de punta a punta.
- No hay interfaz de voz ni app Android terminadas.

## Product Principles

1. Mostrar el estado que devuelve el servidor, nunca inferir pago desde el QR o una acción local.
2. Separar con claridad la vista privada del comerciante y la vista pública del cliente.
3. Hacer que el monto, el QR y la confirmación sean legibles a la distancia de un mostrador.
4. Permitir una demostración segura con Mock y una consulta visible del flujo Pey verificado.
