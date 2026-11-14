# Copiloto Acústico Zero-UI

Repositorio base para el hack de Cursor. El producto propuesto permite a un comerciante preparar cobros con la voz y confirmar pagos con una **palabra secreta de un solo uso**. La voz es la interfaz; la prueba del pago debe venir de un evento verificado por el servidor.

## Estado

**Solo estructura inicial.** Todavía no hay cobros, reconocimiento de voz, backend ni aplicación Android. La página de Vercel es una pantalla de arranque para comprobar que el despliegue funciona; no representa una demo funcional.

La especificación de referencia es `Modulo2_Copiloto_Acustico_ZeroUI_v3.pdf`, entregada por el autor del proyecto. No se incluye el PDF en el repositorio para evitar publicar un documento de trabajo sin necesidad.

## Estructura

```text
backend/supabase/       Migraciones y Edge Functions (por construir)
android/                App Kotlin, modos Comerciante y Cliente (por construir)
tools/simulator/        Entrada estática para Vercel; futuro simulador web
tools/eval/             Evaluación de audio y parser (por construir)
data/golden/            Casos de referencia del parser (por construir)
data/words/             Banco de palabras secretas (por construir)
docs/                   Alcance y plan de demo
```

## Enfoque para la demo

Construir primero el flujo sin voz y con `MockProvider`: crear orden, mostrar QR de prueba, simular el pago, verificar el evento en el servidor y anunciar el número de orden con la palabra correcta. Después se integran Android, audio y proveedor real. Ver [plan de demo](docs/PLAN_DEMO.md).

## Publicar la base en Vercel

1. Importa este repositorio en Vercel.
2. Deja la raíz del proyecto en `/` y la rama de producción en `main`.
3. `vercel.json` fija el preset **Other** y el directorio de salida `tools/simulator`. No se necesita instalar dependencias ni configurar variables de entorno para la página inicial.
4. Despliega. La URL debe mostrar **“Base lista para construir”**.

Cuando exista el simulador, reemplaza `tools/simulator/index.html` o cambia `outputDirectory` a la carpeta de compilación correspondiente. Nunca expongas claves `service_role` ni secretos del proveedor en archivos servidos por Vercel.

## Principios que debe conservar la implementación

- Solo el servidor decide el estado de una orden y valida el evento firmado del proveedor.
- La palabra secreta se genera en el servidor, se comunica al comerciante en privado y no aparece en la vista del cliente antes de un pago verificado.
- El monto final lo determina o confirma el comerciante; el cliente lo ve antes de pagar.
- Los audios se procesan localmente y no se almacenan ni se suben.
- `MockProvider` permite desarrollar y demostrar sin credenciales ni dinero real.

Los detalles del proveedor, políticas de Realtime, licencias de modelos y requisitos legales siguen marcados **por verificar** en el documento original.

## Abrir en Cursor

Abre la carpeta raíz del repositorio. Cursor leerá `AGENTS.md` como contexto del proyecto. Primera tarea recomendada: implementar el simulador web y el contrato de `MockProvider` siguiendo `docs/PLAN_DEMO.md`, sin afirmar que hay pagos reales.
