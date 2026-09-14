/* Cuántos proxies hay delante del servidor, para que req.ip sea la IP real del cliente
   en el límite de intentos del login admin.

   En Render la petición llega por un proxy (Cloudflare → Render). Confiar en N saltos
   hace que req.ip sea la dirección que añadió el último de ellos a X-Forwarded-For: lo
   que un cliente escriba a mano en esa cabecera queda más a la izquierda y se ignora,
   así que no puede esquivar el límite inventándose IPs.

   - TRUST_PROXY_SALTOS vacía o sin definir → 1 si RENDER está definida (Render la pone
     sola), 0 en local.
   - Un entero de 0 a MAX_SALTOS → ese valor.
   - Cualquier otra cosa ("abc", "-1", "1.5", "99") NO se interpreta a medias: se usa el
     valor por defecto y se devuelve un aviso para registrarlo como error. Confiar en
     más saltos de los que hay dejaría falsear la IP. */

export const MAX_SALTOS = 5;

export function saltosDeProxy(env: Record<string, string | undefined>): { saltos: number; aviso?: string } {
  const porDefecto = env.RENDER ? 1 : 0;
  const valor = env.TRUST_PROXY_SALTOS?.trim();
  if (!valor) return { saltos: porDefecto };
  if (/^\d{1,2}$/.test(valor) && Number(valor) <= MAX_SALTOS) return { saltos: Number(valor) };
  return {
    saltos: porDefecto,
    aviso: `TRUST_PROXY_SALTOS inválida (se esperaba un entero de 0 a ${MAX_SALTOS}); se usa ${porDefecto}`,
  };
}
