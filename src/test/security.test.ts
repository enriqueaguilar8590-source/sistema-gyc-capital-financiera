import { describe, expect, it } from 'vitest';
import { checkOrigin, guardRequest, secureResponse, securityHeaders, buildCsp } from '../lib/security';

const req = (url: string, init: RequestInit & { headers?: Record<string, string> } = {}) => new Request(url, init);
const PROD = 'https://one-system-anywhere.lovable.app';

describe('CORS', () => {
  it('lets same-origin requests through, including behind a proxy host header', () => {
    expect(checkOrigin(req(PROD + '/', { method: 'POST', headers: { origin: PROD } }))).toBe('same');
    expect(checkOrigin(req('http://internal/', { headers: { origin: 'https://miapp.com', host: 'miapp.com', 'x-forwarded-proto': 'https' } }))).toBe('same');
  });
  it('allows only the production and dev origins cross-origin', () => {
    expect(checkOrigin(req('https://otra.app/', { headers: { origin: PROD } }))).toBe('allowed');
    expect(checkOrigin(req('https://otra.app/', { headers: { origin: 'http://localhost:3000' } }))).toBe('allowed');
    expect(checkOrigin(req(PROD + '/', { headers: { origin: 'https://evil.example' } }))).toBe('blocked');
  });
  it('blocks foreign origins with 403 and unused methods with 405', async () => {
    expect(guardRequest(req(PROD + '/', { method: 'POST', headers: { origin: 'https://evil.example' } }))?.status).toBe(403);
    const m = guardRequest(req(PROD + '/', { method: 'DELETE' }));
    expect(m?.status).toBe(405);
    expect(m?.headers.get('allow')).toBe('GET, HEAD, POST, OPTIONS');
    expect(guardRequest(req(PROD + '/'))).toBeNull();
  });
  it('answers the preflight of an allowed origin and nothing else', () => {
    const ok = guardRequest(req('https://otra.app/', { method: 'OPTIONS', headers: { origin: PROD } }));
    expect([ok?.status, ok?.headers.get('access-control-allow-origin'), ok?.headers.get('access-control-allow-methods')]).toEqual([204, PROD, 'GET, HEAD, POST, OPTIONS']);
    expect(guardRequest(req('https://otra.app/', { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }))?.status).toBe(403);
  });
  it('CORS_ENFORCE=false stops blocking (emergency switch)', () => {
    expect(guardRequest(req(PROD + '/', { method: 'POST', headers: { origin: 'https://evil.example' } }), { CORS_ENFORCE: 'false' })).toBeNull();
  });
});

describe('security headers', () => {
  it('sets the full set on the published site', () => {
    const h = securityHeaders(req(PROD + '/'));
    expect(Object.keys(h).sort()).toEqual(['Content-Security-Policy', 'Permissions-Policy', 'Referrer-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options']);
    expect(h['X-Frame-Options']).toBe('SAMEORIGIN');
    expect(h['Content-Security-Policy']).toContain("frame-ancestors 'self'");
  });
  it('lets the Lovable editor frame previews only', () => {
    const preview = securityHeaders(req('https://id-preview--abc.lovable.app/'));
    expect(preview['X-Frame-Options']).toBeUndefined();
    expect(preview['Content-Security-Policy']).toContain('frame-ancestors \'self\' https://lovable.dev');
    expect(buildCsp('one-system-anywhere.lovable.app', true)).not.toContain('lovable.dev https://*.lovable.dev https://gptengineer');
  });
  it('lets the embedded system open the SMS app (sms: links from the iframe)', () => expect(securityHeaders(req(PROD + '/'))['Content-Security-Policy']).toContain("frame-src 'self' sms:"));
  it('skips HSTS over plain http (local dev)', () => expect(securityHeaders(req('http://localhost:3000/'))['Strict-Transport-Security']).toBeUndefined());
  it('adds the headers to the app response without changing its body', async () => {
    const r = secureResponse(req(PROD + '/'), new Response('hola', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect([await r.text(), r.headers.get('x-content-type-options'), r.headers.get('content-type')]).toEqual(['hola', 'nosniff', 'text/html']);
  });
});
