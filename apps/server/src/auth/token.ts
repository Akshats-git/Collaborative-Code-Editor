import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';

export interface SessionClaims {
  /** Stable id for this session's user. */
  sub: string;
  name: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * A signed session token: `base64url(claims).base64url(hmac)`.
 *
 * This is a JWT minus the parts we do not use -- there is one algorithm, one
 * key, and no `alg` field for an attacker to set to `none`. Verification is a
 * constant-time HMAC comparison and an expiry check, which is the whole of what
 * a symmetric bearer token needs.
 */
export function issueToken(user: { sub: string; name: string }): string {
  const claims: SessionClaims = {
    sub: user.sub,
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + config.auth.ttlSeconds,
  };

  const body = base64url(Buffer.from(JSON.stringify(claims)));
  return `${body}.${base64url(sign(body))}`;
}

export function verifyToken(token: string): SessionClaims | undefined {
  const [body, signature] = token.split('.');
  if (!body || !signature) return undefined;

  const expected = base64url(sign(body));
  if (!constantTimeEquals(signature, expected)) return undefined;

  let claims: SessionClaims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionClaims;
  } catch {
    return undefined;
  }

  if (typeof claims.sub !== 'string' || typeof claims.name !== 'string') return undefined;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 < Date.now()) return undefined;

  return claims;
}

/**
 * Every instance must sign with the same key: a token issued by one has to
 * verify on any other, since nothing pins a client to the instance that
 * authenticated it.
 */
export function resolveSecret(): Buffer {
  if (config.auth.secret) return Buffer.from(config.auth.secret);
  return randomBytes(32);
}

let secret: Buffer | undefined;

function sign(body: string): Buffer {
  secret ??= resolveSecret();
  return createHmac('sha256', secret).update(body).digest();
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is not itself a secret.
  return left.length === right.length && timingSafeEqual(left, right);
}
