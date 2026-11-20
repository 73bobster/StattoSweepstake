// Minimal JWT verification against a JWKS (Neon Auth issues EdDSA/Ed25519 or RS256 tokens). No dependencies.
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
const dec = (s) => JSON.parse(new TextDecoder().decode(b64u(s)));

let jwksCache = { at: 0, keys: null, url: '' };
async function getJwks(url, force) {
  if (!force && jwksCache.keys && jwksCache.url === url && Date.now() - jwksCache.at < 10 * 60 * 1000) return jwksCache.keys;
  const r = await fetch(url);
  if (!r.ok) throw new Error('Could not load signing keys');
  const { keys } = await r.json();
  jwksCache = { at: Date.now(), keys, url };
  return keys;
}

function importParams(jwk) {
  if (jwk.kty === 'OKP' && jwk.crv === 'Ed25519') return { imp: { name: 'Ed25519' }, ver: { name: 'Ed25519' } };
  if (jwk.kty === 'RSA') return { imp: { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, ver: { name: 'RSASSA-PKCS1-v1_5' } };
  if (jwk.kty === 'EC' && jwk.crv === 'P-256') return { imp: { name: 'ECDSA', namedCurve: 'P-256' }, ver: { name: 'ECDSA', hash: 'SHA-256' } };
  throw new Error('Unsupported key type');
}

/** Returns the verified claims, or throws. */
export async function verifyJwt(token, jwksUrl) {
  const [h, p, s] = (token || '').split('.');
  if (!h || !p || !s) throw new Error('Malformed token');
  const header = dec(h);
  let keys = await getJwks(jwksUrl, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) { keys = await getJwks(jwksUrl, true); jwk = keys.find((k) => k.kid === header.kid); }
  if (!jwk) throw new Error('Unknown signing key');
  const { imp, ver } = importParams(jwk);
  const key = await crypto.subtle.importKey('jwk', jwk, imp, false, ['verify']);
  const ok = await crypto.subtle.verify(ver, key, b64u(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok) throw new Error('Bad signature');
  const claims = dec(p);
  if (claims.exp && claims.exp * 1000 < Date.now()) throw new Error('Token expired');
  if (!claims.sub) throw new Error('No subject');
  return claims;
}
