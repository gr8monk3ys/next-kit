/**
 * Deriving a rate-limit bucket key from an inbound request.
 *
 * The whole point is that a client must not be able to choose its own bucket.
 * Two ways to get that wrong, and this module exists to avoid both:
 *
 * 1. `x-forwarded-for` is a list that proxies APPEND to, so its left-most entry
 *    is whatever the caller invented and its right-most entry is the hop your
 *    own edge added. Reading `[0]` — the obvious thing — lets anyone mint a
 *    fresh bucket per request just by rotating a header.
 *
 * 2. A *platform* header is only trustworthy on the platform that sets it.
 *    `cf-connecting-ip` is written (and any inbound copy overwritten) by
 *    Cloudflare — but an app deployed straight onto Vercel, Fly, Render or a
 *    bare Node server has nothing that strips it, so the client sends whatever
 *    it likes and mints a fresh bucket per request. Same for
 *    `x-vercel-forwarded-for` off Vercel. That is why trust here is
 *    **declared, not assumed**: nothing platform-specific is read unless the
 *    caller names the platform (or lists the headers) it actually runs behind.
 */

/**
 * Headers a platform sets itself and overwrites on every request — but only
 * on that platform. Read only when the caller declares it.
 */
const PLATFORM_HEADERS = {
  vercel: ["x-vercel-forwarded-for"],
  cloudflare: ["cf-connecting-ip"],
  generic: [],
} as const satisfies Record<string, readonly string[]>;

/**
 * Trusted on every platform this package targets: a single-value header that a
 * reverse proxy sets, and which no CDN forwards from client input.
 *
 * `x-real-ip` is the nginx convention and is what Vercel, Fly and Render each
 * set as well, so it is the portable default. It is still only as trustworthy
 * as your own edge — see {@link GetClientIdOptions.trustedHeaders} if you have
 * no proxy in front of the app at all.
 */
const DEFAULT_TRUSTED_HEADERS = ["x-real-ip"] as const;

function isValidIpv4(value: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(value)) return false;
  return value.split(".").every((segment) => {
    const num = Number(segment);
    return num >= 0 && num <= 255;
  });
}

function isValidIpv6(value: string): boolean {
  return /^[a-f0-9:]+$/i.test(value) && value.includes(":");
}

/**
 * Strip the wrappers a proxy may add (`for=`, quotes, `[v6]`, `:port`) and
 * return the address only if it actually parses as one.
 */
export function normalizeIpCandidate(value: string): string | null {
  let candidate = value.trim();
  if (!candidate) return null;

  if (candidate.toLowerCase().startsWith("for=")) {
    candidate = candidate.slice(4).trim();
  }

  candidate = candidate.replace(/^"|"$/g, "");

  if (candidate.startsWith("[") && candidate.includes("]")) {
    candidate = candidate.slice(1, candidate.indexOf("]"));
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(candidate)) {
    candidate = candidate.replace(/:\d+$/, "");
  }

  if (isValidIpv4(candidate) || isValidIpv6(candidate)) return candidate;
  return null;
}

function hashString(value: string): string {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (Math.imul(31, hash) + value.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/** Where the app is deployed, which is what decides who wrote a header. */
export type ClientIdPlatform = keyof typeof PLATFORM_HEADERS;

export interface GetClientIdOptions {
  /**
   * The platform this app is deployed on, which is the only thing that makes
   * that platform's header trustworthy.
   *
   * - `"cloudflare"` — prepends `cf-connecting-ip`. Correct **only** behind
   *   Cloudflare, which overwrites any inbound copy of it.
   * - `"vercel"` — prepends `x-vercel-forwarded-for`, which Vercel strips from
   *   client input and rewrites.
   * - `"generic"` (default) — no platform header at all: `x-real-ip`, then the
   *   right-most `x-forwarded-for` entry.
   *
   * Declaring the wrong platform is a rate-limit bypass: a header your edge
   * does not overwrite is a header the caller controls.
   */
  platform?: ClientIdPlatform;
  /**
   * Single-value headers to read first, most trustworthy first. Replaces the
   * platform + default list entirely, for edges this package does not know
   * about (`true-client-ip` on Akamai, `fastly-client-ip`, your own
   * `x-edge-client-ip`). Only list headers your own infrastructure
   * *overwrites*; anything else is caller-supplied.
   */
  trustedHeaders?: string[];
  /**
   * Cookie names to fall back to when no trustworthy IP is available, so
   * unidentified callers get their own bucket instead of sharing one global
   * `"anonymous"` bucket any single client could exhaust for everyone.
   */
  sessionCookieNames?: string[];
  /**
   * Last resort when there is no IP and no session cookie. `"fingerprint"`
   * (default) hashes UA + accept headers; `"anonymous"` returns a shared bucket.
   */
  fallback?: "fingerprint" | "anonymous";
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const entry of header.split(";")) {
    const [rawName, ...rest] = entry.trim().split("=");
    if (rawName === name && rest.length > 0) return rest.join("=");
  }
  return null;
}

/** The single-value headers to read, in order, for these options. */
function trustedHeadersFor(options: GetClientIdOptions): readonly string[] {
  if (options.trustedHeaders) return options.trustedHeaders;
  return [
    ...PLATFORM_HEADERS[options.platform ?? "generic"],
    ...DEFAULT_TRUSTED_HEADERS,
  ];
}

/**
 * Best available client identifier, most trustworthy source first.
 *
 * Reads, in order: the trusted single-value headers (`x-real-ip` only, unless
 * you declare a `platform` or your own `trustedHeaders`), then the
 * **right-most** `x-forwarded-for` entry, then an optional session cookie,
 * then a UA fingerprint.
 *
 * ```ts
 * getClientId(request);                            // Vercel / Fly / nginx
 * getClientId(request, { platform: "cloudflare" }); // behind Cloudflare
 * getClientId(request, { trustedHeaders: ["true-client-ip"] }); // Akamai
 * ```
 *
 * Works with any `Request` — a `NextRequest` is one.
 */
export function getClientId(
  request: Request,
  options: GetClientIdOptions = {},
): string {
  for (const header of trustedHeadersFor(options)) {
    const value = request.headers.get(header);
    if (!value) continue;
    const ip = normalizeIpCandidate(value.split(",")[0] ?? value);
    if (ip) return ip;
  }

  // Right-most entry: the hop our own edge appended. Never [0].
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) {
    const parts = forwardedFor
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) {
      const ip = normalizeIpCandidate(last);
      if (ip) return ip;
    }
  }

  for (const name of options.sessionCookieNames ?? []) {
    const value = readCookie(request, name);
    if (value) return `session:${hashString(`${name}:${value}`)}`;
  }

  if (options.fallback === "anonymous") return "anonymous";

  const fingerprint = [
    request.headers.get("user-agent") ?? "",
    request.headers.get("accept-language") ?? "",
    request.headers.get("accept-encoding") ?? "",
  ].join(":");

  return `fingerprint:${hashString(fingerprint)}`;
}
