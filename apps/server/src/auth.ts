import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

export interface SessionClaims {
  /** Stable id for this session's user. */
  sub: string;
  name: string;
  /** Unix seconds. */
  exp: number;
}

/**
 * A signed session token, shaped as `base64url(claims).base64url(hmac)`.
 *
 * This is a JWT minus the parts we do not use. There is one algorithm and one
 * key, so there is no `alg` field for an attacker to set to `none`. Verifying a
 * symmetric bearer token needs nothing more than a constant time HMAC
 * comparison and an expiry check.
 */
export function issueToken(user: { sub: string; name: string }): string {
  const claims: SessionClaims = {
    sub: user.sub,
    name: user.name,
    exp: Math.floor(Date.now() / 1000) + config.auth.ttlSeconds,
  };

  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string): SessionClaims | undefined {
  const [body, signature] = token.split('.');
  if (!body || !signature) return undefined;
  if (!constantTimeEquals(signature, sign(body))) return undefined;

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
 * Every instance signs with the same key. Nothing pins a client to the instance
 * that authenticated it, so a token issued by one has to verify on any other.
 */
let secret: Buffer | undefined;

function sign(body: string): string {
  secret ??= config.auth.secret ? Buffer.from(config.auth.secret) : randomBytes(32);
  return createHmac('sha256', secret).update(body).digest('base64url');
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is not itself a secret.
  return left.length === right.length && timingSafeEqual(left, right);
}
