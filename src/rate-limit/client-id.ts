/**
 * Deriving a rate-limit bucket key from an inbound request.
 *
 * The whole point is that a client must not be able to choose its own bucket.
 * `x-forwarded-for` is a list that proxies APPEND to, so its left-most entry is
 * whatever the caller invented and its right-most entry is the hop your own edge
 * added. Reading `[0]` — the obvious thing — lets anyone mint a fresh bucket per
 * request just by rotating a header.
 */

/** Headers a platform sets itself and overwrites on every request. */
const TRUSTED_SINGLE_VALUE_HEADERS = [
  "x-vercel-forwarded-for", // Vercel
  "cf-connecting-ip", // Cloudflare
  "x-real-ip", // nginx / Vercel
] as const;

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

export interface GetClientIdOptions {
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

/**
 * Best available client identifier, most trustworthy source first.
 *
 * Works with any `Request` — a `NextRequest` is one.
 */
export function getClientId(
  request: Request,
  options: GetClientIdOptions = {},
): string {
  for (const header of TRUSTED_SINGLE_VALUE_HEADERS) {
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
