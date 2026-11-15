// Correo y contraseña se piden en el terminal. La contraseña no se muestra ni se guarda.
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";

export async function promptLine(label) {
  if (!process.stdin.isTTY) throw new Error("Hace falta un terminal interactivo.");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try { return (await rl.question(label)).trim(); } finally { rl.close(); }
}

export async function promptSecret(label) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error("Hace falta un terminal interactivo.");
  return new Promise((resolve, reject) => {
    let value = "";
    process.stdout.write(label);
    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const done = (error) => {
      process.stdin.off("keypress", onKey);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error); else resolve(value);
    };
    const onKey = (char, key) => {
      if (key?.ctrl && key.name === "c") return done(new Error("Cancelado"));
      if (key?.name === "return" || key?.name === "enter") return done();
      if (key?.name === "backspace") { value = value.slice(0, -1); return; }
      if (char && !key?.ctrl && !key?.meta) value += char;
    };
    process.stdin.on("keypress", onKey);
  });
}

/** Devuelve el access token. No lo imprime. */
export async function signIn(request, authBase, email, password) {
  const login = await request(`${authBase.replace(/\/$/, "")}/token?grant_type=password`, {
    method: "POST",
    body: { email, password },
  });
  if (login.status !== 200 || typeof login.data?.access_token !== "string" || !login.data.access_token) {
    throw new Error(`Inicio de sesión falló (${login.status}); comprueba la cuenta de prueba.`);
  }
  return login.data.access_token;
}
