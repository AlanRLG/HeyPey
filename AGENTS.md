# Instrucciones para agentes

Este repositorio es la base del **Copiloto Acústico Zero-UI**. Antes de implementar, lee `README.md` y `docs/PLAN_DEMO.md`. La especificación original v3 es la fuente de requisitos; si no está disponible en este checkout, solicita al propietario las páginas pertinentes antes de inventar contratos o reglas de negocio.

- Mantén el monorepo en `backend/supabase`, `android`, `tools`, `data` y `docs`.
- Prioriza el simulador con `MockProvider` y el flujo completo sin voz. No conectes dinero real para la demo.
- La UI del cliente no debe recibir ni mostrar la palabra secreta antes de un pago verificado.
- No anuncies `PAID` por una captura, audio del cliente, temporizador o acción local. El servidor debe verificar el evento del proveedor y ser la autoridad del estado.
- Usa centavos enteros para montos y claves de idempotencia estables para reintentos.
- Marca explícitamente cualquier simulación y los supuestos `[VERIFICAR]`.
- No publiques secretos, audio, transcripciones reales ni datos de clientes. Usa datos ficticios en pruebas y capturas.
- Antes de hacer push, comprueba que la página de Vercel carga y que README describe el estado real de lo implementado.
