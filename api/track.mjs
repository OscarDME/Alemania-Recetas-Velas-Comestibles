// api/track.mjs
//
// The only on-demand route in this project. Every page stays static HTML.
//
// It receives an event from the browser and forwards it to Meta's Conversions
// API, adding the visitor's IP address and user agent — which are only visible
// here, because a browser does not know its own public IP.
//
// The IP is used solely to build the call to Meta. It is never stored, never
// written to logs and never returned to the client.

import { createHash } from 'node:crypto';

// Read from process.env at request time, never from a bundler-inlined value:
// that would embed the token in the deployed artifact and force a redeploy to
// rotate it. The Pixel id falls back to the same literal used in the HTML so
// browser and server can never silently drift apart and break deduplication.
const env = (name) => (typeof process !== 'undefined' ? process.env?.[name] : undefined);

const DEFAULT_PIXEL_ID = '1089931066809976';
const GRAPH_VERSION = 'v21.0';

// Only these events are accepted. The endpoint is public and must not become a
// way to inject arbitrary events into the Pixel. Purchase is deliberately
// absent: OrioPay already sends it from its own side.
const ALLOWED_EVENTS = new Set(['PageView', 'InitiateCheckout']);

const ALLOWED_CURRENCIES = new Set(['EUR']);

const MAX_BODY_BYTES = 2048;

// Hosts allowed to call this endpoint.
const ALLOWED_HOSTS = new Set([
  'rezepte-fuer-essbare-kerzen.crearis.online',
]);

/**
 * Normalizes the way Meta requires before hashing: lowercase, no punctuation,
 * no special characters and NO SPACES.
 *
 * decodeURIComponent is not optional: Vercel delivers x-vercel-ip-city with
 * non-ASCII characters percent-encoded, so "Montréal" arrives as
 * "Montr%C3%A9al". Without decoding, the hash matches no Meta profile.
 */
function normalize(value) {
  if (!value) return '';
  let s = String(value).trim();
  try {
    s = decodeURIComponent(s);
  } catch {
    // Malformed percent-encoding: carry on with the raw value.
  }
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** City, region: standard normalization. */
function hashed(value) {
  const s = normalize(value);
  return s ? sha256(s) : undefined;
}

/**
 * Postal code. On top of the standard normalization Meta asks for the first
 * five digits only in the United States. Alphanumeric postcodes from the UK and
 * Canada ("SW1A 1AA", "M5V 3A8") are kept whole, already without the space.
 */
function hashedZip(value) {
  let s = normalize(value);
  if (!s) return undefined;
  if (/^\d/.test(s)) s = s.slice(0, 5);
  return sha256(s);
}

/**
 * Ad click identifier. Meta stores it in the _fbc cookie, but that cookie is
 * created by fbevents.js, which is deferred here so it does not hurt LCP: on a
 * first visit from an ad it usually does not exist yet. Meta documents the
 * fallback — compose it from the URL's fbclid — and ad traffic is exactly the
 * traffic that needs this signal most.
 */
function resolveFbc(body, eventTimeMs) {
  if (body.fbc) return String(body.fbc).slice(0, 500);
  if (!body.fbclid) return undefined;
  const fbclid = String(body.fbclid).slice(0, 500);
  return `fb.1.${eventTimeMs}.${fbclid}`;
}

/**
 * Visitor IP. Order matters: x-vercel-forwarded-for cannot be overwritten by a
 * proxy sitting in front of Vercel, and Vercel rewrites x-forwarded-for to
 * prevent spoofing, so both are trustworthy here.
 */
function resolveClientIp(headers) {
  const get = (name) => {
    const v = headers[name];
    return (Array.isArray(v) ? v[0] : v) || '';
  };
  const candidate =
    get('x-vercel-forwarded-for') ||
    get('x-forwarded-for').split(',')[0] ||
    get('x-real-ip') ||
    '';
  const ip = candidate.trim();
  // Meta requires a valid IPv4 or IPv6 and rejects loopback.
  if (!ip || ip === '::1' || ip === '127.0.0.1') return undefined;
  return ip.replace(/^::ffff:/, '');
}

/** The endpoint only serves requests coming from the landing itself. */
function isSameOrigin(headers) {
  const origin = headers.origin;
  if (!origin) return false;
  try {
    const incoming = new URL(origin).host;
    if (ALLOWED_HOSTS.has(incoming)) return true;
    // Also allow the host actually serving the request: Vercel preview
    // deployments and localhost during development.
    const self = Array.isArray(headers.host) ? headers.host[0] : headers.host;
    return Boolean(self) && incoming === self;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  // Always 204: the client needs nothing back, and this keeps the endpoint from
  // becoming an oracle for whether the token or the Pixel id are valid.
  const noContent = () => {
    res.statusCode = 204;
    res.end();
  };

  try {
    if (req.method !== 'POST') return noContent();

    const headers = req.headers || {};
    const pixelId = env('META_PIXEL_ID') || DEFAULT_PIXEL_ID;
    const capiToken = env('META_CAPI_TOKEN');
    const testEventCode = env('META_TEST_EVENT_CODE');

    if (!pixelId || !capiToken) return noContent();
    if (!isSameOrigin(headers)) return noContent();

    const declaredLength = Number(headers['content-length'] || 0);
    if (declaredLength > MAX_BODY_BYTES) return noContent();

    // Vercel parses application/json into req.body; a string body is also
    // handled so the endpoint does not depend on that behaviour.
    let body = req.body;
    if (typeof body === 'string') {
      if (body.length > MAX_BODY_BYTES) return noContent();
      body = JSON.parse(body);
    }
    if (!body || typeof body !== 'object') return noContent();

    const eventName = body.event_name;
    if (!ALLOWED_EVENTS.has(eventName)) return noContent();

    const clientIp = resolveClientIp(headers);
    const userAgent = headers['user-agent'] || undefined;
    const header = (name) => {
      const v = headers[name];
      return (Array.isArray(v) ? v[0] : v) || undefined;
    };

    const nowMs = Date.now();

    const userData = {
      // In clear: Meta explicitly requires these NOT to be hashed.
      client_ip_address: clientIp,
      client_user_agent: userAgent,
      fbp: body.fbp ? String(body.fbp).slice(0, 200) : undefined,
      fbc: resolveFbc(body, nowMs),
      // Coarse geolocation Vercel derives from the IP. These DO go hashed, and
      // normalized the way Meta asks for before hashing.
      country: hashed(header('x-vercel-ip-country')),
      st: hashed(header('x-vercel-ip-country-region')),
      ct: hashed(header('x-vercel-ip-city')),
      zp: hashedZip(header('x-vercel-ip-postal-code')),
    };

    // Only when the client sends them (InitiateCheckout). Meta needs both
    // together: a value without a currency is discarded.
    const value = Number(body.value);
    const currency = String(body.currency || '').toUpperCase();
    const hasCustomData =
      Number.isFinite(value) && value > 0 && ALLOWED_CURRENCIES.has(currency);

    const payload = {
      data: [
        {
          event_name: eventName,
          event_time: Math.floor(nowMs / 1000),
          // Same id as the Pixel's eventID: Meta deduplicates both (48 h window).
          event_id: body.event_id ? String(body.event_id).slice(0, 200) : undefined,
          event_source_url: body.event_source_url
            ? String(body.event_source_url).slice(0, 1000)
            : undefined,
          action_source: 'website',
          user_data: userData,
          ...(hasCustomData ? { custom_data: { value, currency } } : {}),
        },
      ],
    };

    if (testEventCode) payload.test_event_code = testEventCode;

    const endpoint =
      `https://graph.facebook.com/${GRAPH_VERSION}/${pixelId}/events` +
      `?access_token=${encodeURIComponent(capiToken)}`;

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      // Log the failure of the call, never the IP nor the payload.
      console.error('[CAPI] Meta responded', response.status, eventName);
    }
  } catch (error) {
    console.error('[CAPI] error:', error?.message);
  }

  res.statusCode = 204;
  res.end();
}
