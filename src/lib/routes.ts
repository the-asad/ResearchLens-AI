/** Route classification shared by the proxy and tests. */
export const PROTECTED_PREFIXES = ["/dashboard", "/documents", "/projects", "/chat", "/settings"] as const;
export const AUTH_PATHS = ["/login", "/signup"] as const;

export function isProtectedPath(pathname: string) {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function isAuthPath(pathname: string) {
  return (AUTH_PATHS as readonly string[]).includes(pathname);
}

/**
 * Only allow same-origin relative redirects after login (prevents open redirects such as
 * `//evil.com` or `https://evil.com`).
 */
export function safeNextPath(next: unknown, fallback = "/dashboard") {
  if (typeof next !== "string" || next.length > 512) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  if (/[\u0000-\u001f]/.test(next)) return fallback;
  return next;
}
