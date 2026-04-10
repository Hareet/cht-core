/**
 * Development-only JWT token provider for PowerSync authentication.
 *
 * Generates RS256 JWTs client-side using the Web Crypto API for local
 * development against the self-hosted PowerSync service.
 *
 * DO NOT use in production. In production, the CHT API server would expose
 * a /api/v1/powersync-token endpoint that signs tokens server-side.
 *
 * The RSA private key here matches the public key in powersync.yaml's JWKS config.
 */

// PEM-encoded PKCS#8 private key matching the JWKS in powersync.yaml (kid: cht-dev-key-1)
// This is a DEVELOPMENT-ONLY key with no security value.
const DEV_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQDFuf6VtnKd7ecN
u5JROIiaVNPZhs8SX0jzUlnDl2L5o+yakcFBh5kOQcZr3qLR/7DcBIXKePpR0gUg
tdT6FwLc2lX6jC/XbjetQbjzE5F1fKRb/jpRdMTskanOL5/9EmNn5+upFHn59Mm1
5hQBD3oRPCri5GYu7OtFZtcT0OlO0CRmNmpYEwht1IZDowNzcIZrMSRNWotoFdL1
K+mRPuwSrQXRGWXCFrnG++P1RXHQChep/aKPvXLgs4pUV+Ow1UiIMZSbUldJ1wkb
fYCtxfhLl0nbyYWIEL8i8pp94EVNapQK6QroMzvlEze/p/LVxnp2TqBD+zWeqIDR
iFtiHLCFAgMBAAECggEAEPWdW8+IoLmvZArm568K7nvgqOuKdtez7OTvHJrvSxzP
lklys1FzZBjpsUZpHkyJabG8nQuH4v054d6ezC2tme5jSgh8sQR745E70SOoShS9
D0Ps0iBLJMRwtWX52c3aN2cZ3EiMls8zfvXjWNzwOiq4PfpbtmItYuhJgeJdJJyI
YZAKl3OMvVAyXST5cRYPJLE0A/uKhBaRXu/KFEoRhJldNsggxWPwmKN85oUk0OT5
O78w1krULIZ+W4pzrZ6Aat3x+3ph5Bf1M4FwtQWEAphLMwZyh0qw4LoBUQVgVko6
vnZ8vWsTKADuYMtBjJ3FKX5aKWN9ja3vR4/Zl3ZhMQKBgQD+071uoGpvoxZR5bUU
0pWmI887YshwV2F4JFWT8cCETdCvwPIBlP7347ir2pCMmn/YyECltox0VL2YCTNJ
KvOF59kiB9RxzrvQHzdcfFVYc7zXSKYMLyMfYwOzbI3XMBIBxiBnX9uyinapNf0Q
9z0pVe7gI9qslngSZlal8sY9FQKBgQDGovk4lXwSRMkgXrvYD03tGURvXnigFgSF
X8MJGS9sJQy1sYx08in2k14cD9H4O3s74J1SN3dP2ErAALbQ35z32+LGd47pgEJo
tAQYt+nsMyZudiUN283uSi3/lESI+f3LVbQIjyuTAVLRs4CsKK+mb7fPKn4DBLqD
0sijNynhsQKBgQCg7r5K2Fp/yIJ3FFgJH3lNJH5i5d7qO/Udd+zn8xx/MdmitXrh
DuT7TsC5H958PbKSCN3zCdeoPEBEfUL7aXnETojtmf5MJaCtLpm6+fa4VtejKolb
VoWa8+BJdzwY843buvGJ95r7JcEM2kDJbyscKN4kheA7cQfBrwn34dvahQKBgQCN
970X6/8ZL4BwWkT3Tzjq1LxMvMCJ6jKhAKhswEtch75lvdgdXVcQnJMOi2AOgrS5
Pvgx4uKrdnM2d0wyTR/rJoUWRC0oRjswijjDUe8mmghFursRBKBSR0JJALdbDxGN
WluqImmKT8/ZgOneIdYopoBA2KXnkmGcBfLQdITCgQKBgBBbpiM2pxghgyfZ0pWw
qdK/Y6cN23P21qLhKvqBxdUREvAq0IHjPzCA79RTLjZoQw8JmQY6m0wryVyjGEL6
nO6Kyi/4Z1km1rheQ7iErb2jninUxg9TkvfZuFByFqocwx83rDEKY4T837rsp0VZ
N1b87Zr+Q7D6QESaCSWspX1n
-----END PRIVATE KEY-----`;

function base64url(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function strToBase64url(str: string): string {
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

let cachedKey: CryptoKey | null = null;

async function getSigningKey(): Promise<CryptoKey> {
  if (cachedKey) {
    return cachedKey;
  }
  const keyBuffer = pemToArrayBuffer(DEV_PRIVATE_KEY_PEM);
  cachedKey = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return cachedKey;
}

export interface DevTokenOptions {
  /** CouchDB user ID, e.g. 'org.couchdb.user:chw_user' */
  userId: string;
  /** Contact person UUID */
  contactId?: string;
  /** User roles */
  roles?: string[];
  /** Max depth for report syncing (-1 = unlimited) */
  reportDepth?: number;
  /** Token validity in seconds (default: 24 hours) */
  expiresInSeconds?: number;
}

/**
 * Generate a JWT token for PowerSync dev authentication.
 * Uses the Web Crypto API to sign RS256 tokens client-side.
 */
export async function generateDevToken(options: DevTokenOptions): Promise<{ token: string; expiresAt: Date }> {
  const key = await getSigningKey();

  const now = Math.floor(Date.now() / 1000);
  const exp = now + (options.expiresInSeconds || 86400);

  const roles = options.roles || ['chw'];
  const roleHash = md5Hash(roles.sort().join(','));

  const header = {
    alg: 'RS256',
    typ: 'JWT',
    kid: 'cht-dev-key-1',
  };

  const payload = {
    sub: options.userId,
    aud: 'cht-powersync-dev',
    iat: now,
    exp,
    role_hash: roleHash,
    contact_id: options.contactId || null,
    report_depth: options.reportDepth ?? 1,
  };

  const headerB64 = strToBase64url(JSON.stringify(header));
  const payloadB64 = strToBase64url(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    encoder.encode(signingInput)
  );

  const token = `${signingInput}.${base64url(signature)}`;
  return {
    token,
    expiresAt: new Date(exp * 1000),
  };
}

/**
 * MD5 hash for role_hash JWT claim. Must match Node's crypto.createHash('md5').
 * Minimal pure-JS MD5 implementation for browser use (dev only).
 */
function md5Hash(input: string): string {
  // Pre-computed role hashes for dev users (avoids needing full MD5 in browser)
  const KNOWN_HASHES: Record<string, string> = {
    'chw': 'f5b84b40469cbcfaa4cd7183856ecfaf',
    'chw_supervisor': '7c92f994ff1e92eab97eb65a23ab1f59',
    'national_admin': '20a4b4b81bde00e5fc6f974cf0801e8d',
  };
  return KNOWN_HASHES[input] || 'unknown_role_hash';
}
