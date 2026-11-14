import { serviceClient } from "./db.ts";

export interface Caller {
  userId: string;
}

/** Valida el JWT del usuario (Authorization: Bearer ...). */
export async function requireUser(req: Request): Promise<Caller | null> {
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data, error } = await serviceClient().auth.getUser(token);
  if (error || !data.user) return null;
  return { userId: data.user.id };
}

export interface StallRow {
  id: string;
  provider: "mock" | "pey";
  provider_account_ref: string | null;
}

/** Devuelve el puesto solo si pertenece al usuario. */
export async function ownedStall(userId: string, stallId: string): Promise<StallRow | null> {
  const { data } = await serviceClient()
    .from("stalls")
    .select("id, provider, provider_account_ref, merchants!inner(user_id)")
    .eq("id", stallId)
    .eq("merchants.user_id", userId)
    .maybeSingle();
  return data ? { id: data.id, provider: data.provider, provider_account_ref: data.provider_account_ref } : null;
}
