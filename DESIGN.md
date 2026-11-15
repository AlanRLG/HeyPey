# Diseño web · Copiloto Acústico Zero-UI

## Dirección

Una mesa de cobro de mercado, precisa y contemporánea. El monto y la palabra son la pieza visual; el resto de la interfaz deja espacio para leerlos. La referencia de [Refero Styles: Ramp](https://styles.refero.design/style/b38702a0-75ab-474c-9106-00b624535825) inspira el uso de una superficie editorial sobria y un acento reservado a acciones de dinero. La identidad, los colores y las pantallas se adaptan al producto; no copian la referencia.

## Roles visuales

| Rol | Color | Uso |
|---|---|---|
| Tinta petróleo | `#163D43` | Titulares, navegación, acción principal |
| Papel | `#F5F6F1` | Fondo general |
| Blanco | `#FFFFFF` | Superficies de trabajo y QR |
| Línea | `#D8E0DC` | Separaciones y bordes |
| Miel | `#F2C66D` | Activación y monto pendiente |
| Verde | `#0F745F` | Confirmación del servidor |
| Rojo | `#A43E37` | Fallo o cancelación |

Tipografía: Bricolage Grotesque para titulares y números grandes; Geist para controles y texto. El importe usa cifras tabulares. Esquinas de 12 a 16 px en paneles; controles compactos. El foco del teclado es visible y los estados se distinguen por texto además del color.

## Composición

- Portada: una frase breve y la pantalla pública real de la demo. Debajo, una matriz de tres momentos y dos pantallas más el servidor: la celda del comerciante es tinta oscura (privado), la del cliente es blanca (público) y el servidor queda en medio como autoridad. El titular dice «Dos pantallas, un servidor». Después, dos tarjetas separan «Demo simulada» de «Pey real».
- Demo: comerciante y cliente lado a lado en escritorio, apilados en móvil. Cada lado lleva una barra de identidad (tinta sólida y candado para el privado; contorno y ojo para el público).
- Comerciante: entrada de importe, dictado web opcional y lista de órdenes. «Dictar importe» solo rellena el monto; el comerciante lo revisa antes de crear la orden. Si el navegador no reconoce la voz en el dispositivo, un aviso pide aceptación porque la voz puede salir del equipo. El flujo Pey requiere confirmación explícita antes de generar un QR real. Android, Bluetooth y el reconocimiento local propio siguen fuera de esta interfaz.
- Cliente: una orden por vez, con importe y QR grandes. La palabra ocupa el lugar del QR solo cuando el servidor entrega un `PAID` no tardío con palabra. Si el estado es `PAID` y no hay palabra, la pantalla dice pago confirmado, en verde, y no inventa una palabra ni vuelve a «Esperando pago». Un riel de 7 px cambia con el estado (miel en espera, verde con pago confirmado, rojo con error) y siempre va acompañado de texto. El importe llega a 7.4 rem en escritorio; el QR mide hasta 264 px y se encoge para caber desde 320 px.
- Accesibilidad: la región viva anuncia el estado, el importe y el número de orden; el contador del QR es un `role="timer"` fuera de esa región. «Anuncio por voz» conserva ese nombre y `aria-pressed`. El aviso del dictado se lee y se recorre con teclado. Controles y enlaces de navegación miden al menos 44 px de alto.

## Movimiento

Una sola entrada breve del titular con React Bits. Los cambios de estado del cobro se animan con discreción y se desactivan bajo `prefers-reduced-motion`. No se anima el QR ni la palabra durante la lectura.

## Lenguaje

Frases concretas: «Crear orden», «Esperando pago», «Pago confirmado», «Dile esta palabra al comerciante». El modo Mock siempre dice «Sin dinero real»; Pey se identifica como pago real y permanece detrás del acceso del comerciante.
