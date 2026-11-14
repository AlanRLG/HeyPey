import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.45.4";

let client: SupabaseClient | null = null;

/** Cliente con service_role: solo para Edge Functions, nunca para el navegador. */
export function serviceClient(): SupabaseClient {
  if (!client) {
    client = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

export async function audit(orderId: string | null, kind: string, detail: Record<string, unknown> = {}) {
  await serviceClient().from("audit_log").insert({ order_id: orderId, kind, detail });
}
