// Configuración pública del simulador. Versionable: la anon key es pública por diseño (la protege RLS).
// NUNCA pongas aquí la service_role ni secretos del proveedor.
// La cuenta de demo es ficticia y su único puesto usa provider = 'mock' (sin dinero real).
window.COPILOTO_CONFIG = {
  SUPABASE_URL: "",
  SUPABASE_ANON_KEY: "",
  STALL_ID: "",
  DEMO_EMAIL: "",
  DEMO_PASSWORD: "",
  // Protección extra de /mock-pay en la demo; no es un secreto real (ver DEPLOY.md B4).
  MOCK_PAY_TOKEN: "",
};
