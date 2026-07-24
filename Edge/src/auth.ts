/**
 * JWT auth — sign, verify, middleware. HS256, Web Crypto.
 *
 * Claims: { sub, tenant_id, iat, exp }
 * 24-hour expiry. Dev secret for skeleton.
 */

const DEV_SECRET = "funconnect-dev-secret-change-in-production";

function base64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function utf8Encode(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw", utf8Encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false, ["sign", "verify"]
  );
}

// ── Sign ──────────────────────────────────────────────────────────────────

export async function signToken(
  payload: Record<string, unknown>,
  secret: string = DEV_SECRET
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const claims = { ...payload, iat: now, exp: now + 86400 };

  const headerB64 = base64url(utf8Encode(JSON.stringify(header)));
  const payloadB64 = base64url(utf8Encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, utf8Encode(signingInput));
  const sigB64 = base64url(sig);

  return `${signingInput}.${sigB64}`;
}

// ── Verify ────────────────────────────────────────────────────────────────

export async function verifyToken(
  token: string,
  secret: string = DEV_SECRET
): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("invalid token format");

  const [headerB64, payloadB64, sigB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const sig = Uint8Array.from(atob(sigB64.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
  const valid = await crypto.subtle.verify("HMAC", key, sig, utf8Encode(signingInput));
  if (!valid) throw new Error("invalid signature");

  const payload = JSON.parse(atob(payloadB64.replace(/-/g, "+").replace(/_/g, "/")));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
    throw new Error("token expired");
  }

  return payload;
}

// ── Middleware ─────────────────────────────────────────────────────────────

export interface AuthClaims {
  sub: string;
  tenant_id: string;
  iat: number;
  exp: number;
}

export async function requireAuth(
  request: Request,
  secret: string = DEV_SECRET
): Promise<AuthClaims> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    throw new Error("missing token");
  }
  const token = auth.slice(7);
  const claims = await verifyToken(token, secret);
  return claims as unknown as AuthClaims;
}
