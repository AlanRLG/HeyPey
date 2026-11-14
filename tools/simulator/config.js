// Configuración pública del simulador (generada por tools/deploy/deploy_cloud.sh).
// La anon key es pública por diseño (la protege RLS). NUNCA pongas aquí la service_role.
// Cuenta de demo ficticia: su único puesto usa provider = 'mock' (sin dinero real).
// Rota la contraseña o desactiva el usuario después de la entrega (DEPLOY.md §4.5).
window.COPILOTO_CONFIG = {
  SUPABASE_URL: "https://uiodieqwspxqtvmqtsog.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVpb2RpZXF3c3B4cXR2bXF0c29nIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ2NzQ2NTgsImV4cCI6MjExMDI1MDY1OH0.28CtA0qre7ZR-TCR-xKEZQdLeRDMp4PCQ-RSfknLzZI",
  STALL_ID: "bf048ef2-1705-4946-8863-936e0465b4fa",
  DEMO_EMAIL: "demo@copiloto-zeroui.invalid",
  DEMO_PASSWORD: "4b4aab71a20972949df29300",
  // Protección extra de /mock-pay en la demo; no es un secreto real (ver DEPLOY.md B4).
  MOCK_PAY_TOKEN: "0c14fb68f2cd408586f9d0925a623a8f542d98aa535baffa",
};
