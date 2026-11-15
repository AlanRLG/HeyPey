# Frontend · Copiloto Acústico Zero-UI

App React/Vite del hack. Usa shadcn/ui para controles y React Bits para la entrada del titular. El diseño se documenta en `../../DESIGN.md`.

## Iniciar

```powershell
npm ci
npm run dev
```

Abre `http://127.0.0.1:5173/`. Vite envía las Edge Functions por un proxy local para evitar el bloqueo CORS de `localhost`. Las llamadas de autenticación usan Supabase directamente. `public/config.js` contiene únicamente la URL, la clave pública `anon` y los IDs públicos de los puestos.

## Rutas

- `/`: presentación y estado público Mock.
- `/demo`: comerciante + cliente lado a lado con MockProvider, sin dinero real.
- `/comerciante`: solo la vista privada; acceso con sesión, puestos Mock y Pey. Crear un QR Pey requiere una segunda confirmación.
- `/cliente`: solo la vista pública, sin sesión. `?modo=pey` muestra el puesto Pey. Ábrela en el dispositivo que mira el comprador.

El cliente consulta `public-orders` cada tres segundos. El navegador no marca pagos Pey: el webhook y el backend deciden cuándo una orden pasa a `PAID`. En el modo Mock, el comerciante puede enviar un pago simulado al backend.

## Comprobación

Con `npm run dev` activo en otra terminal:

```powershell
npm run check:visual
npm run test:browser
npm run build
npm run lint
```

`check:visual` toma capturas en `artifacts/` e inspecciona ocho combinaciones de ruta y pantalla con axe. `test:browser` intercepta respuestas de red ficticias: comprueba palabra oculta antes del pago Mock, palabra visible después, rutas separadas y confirmación doble antes de un POST Pey. Ninguna de esas pruebas crea un cobro real. Requieren Chrome instalado.

La prueba real de $0.01 con Pey pertenece al backend y está registrada en el README principal. Para comprobar el frontend con la cuenta real, el presentador debe iniciar sesión manualmente; no guardes credenciales en el repo.
