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

- Portada: una frase breve y una vista previa del flujo de dos pantallas. El producto aparece antes que la explicación.
- Demo: comerciante y cliente lado a lado en escritorio, apilados en móvil. Cada lado conserva su propio límite de privacidad.
- Comerciante: entrada de importe, creación de orden y lista de órdenes. El flujo Pey requiere confirmación explícita antes de generar un QR real.
- Cliente: una orden por vez, con importe y QR grandes. La palabra ocupa el lugar del QR solo tras `PAID` no tardío.

## Movimiento

Una sola entrada breve del titular con React Bits. Los cambios de estado del cobro se animan con discreción y se desactivan bajo `prefers-reduced-motion`. No se anima el QR ni la palabra durante la lectura.

## Lenguaje

Frases concretas: «Crear orden», «Esperando pago», «Pago confirmado», «Dile esta palabra al comerciante». El modo Mock siempre dice «Sin dinero real»; Pey se identifica como pago real y permanece detrás del acceso del comerciante.
