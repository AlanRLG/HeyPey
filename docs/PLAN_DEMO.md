# Recorrido de HeyPEY para el jurado

La entrega se evalúa sin presentación en vivo. La entrada principal es la [demo pública](https://copiloto-zeroui.vercel.app/demo), que cualquier persona puede completar sin cuenta ni dinero.

## Prueba autoguiada

1. En la vista **Comerciante**, deja `0.01` o escribe otro importe con hasta dos decimales. En un navegador compatible, pulsa **Activar HeyPEY**, acepta el aviso y di «HeyPEY, cóbrale un centavo». El importe aparece en el campo, pero todavía no hay orden.
2. Pulsa **Crear cobro de ejemplo**. El comerciante ve la palabra privada. La vista **Cliente** muestra el importe y un QR ilustrativo, sin palabra.
3. Pulsa **Simular pago**. Ahora el cliente ve la misma palabra. **Reiniciar recorrido** permite repetir la prueba.

El QR de esta ruta no es válido para pagar. El recorrido ocurre solo en el navegador: no crea órdenes en Supabase y no llama a Pey. El botón de voz necesita permiso de micrófono y la pestaña debe permanecer visible. Escribir el importe siempre funciona como alternativa.

## Cómo se relaciona con el backend

| Modo | Acceso | Qué prueba |
|---|---|---|
| `/demo`, recorrido inicial | Público | Interacción de comerciante y cliente, importe por voz o teclado, palabra oculta y revelación tras el pago simulado. Es una simulación local. |
| `/demo` → **Abrir prueba conectada** | Cuenta privada del comerciante | MockProvider, órdenes reales en Supabase, evento de pago simulado y palabra liberada por el servidor. No mueve dinero. |
| `/cliente?modo=pey` | Público, solo lectura | Estado que devuelve el backend Pey. No inicia pagos. |
| `/comerciante?modo=pey` | Cuenta privada del comerciante | Puede generar un QR bancario real después de una segunda confirmación. No hace falta usarlo para evaluar la entrega. |

El backend Pey ya confirmó **una transferencia real de $0.01** por webhook, y la palabra pública coincidió con la privada. Un QR anterior venció sin pago; no cuenta como prueba exitosa. El flujo Mock alojado pasó 19 comprobaciones. Las devoluciones, un segundo cobro y una conciliación Pey sin webhook no se han probado.

## Principio que se evalúa

En el sistema conectado, el navegador no decide que un pago fue confirmado. El servidor verifica el evento y el pago con el proveedor; solo entonces permite publicar la palabra. La demo local ilustra ese orden visualmente y se identifica como simulación en la pantalla.
