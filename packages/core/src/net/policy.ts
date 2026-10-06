import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import type { ReasonCode, ScanScope } from '@cqa/shared';

/** Resolves a hostname to all of its addresses. Injectable so tests can simulate DNS. */
export type Resolver = (hostname: string) => Promise<string[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export interface PolicyOptions {
  resolver?: Resolver;
  /**
   * Exact `ip:port` pairs allowed despite being in a reserved range.
   * Used only by tests (fixture server) and, later, the package server.
   * Never settable through the API.
   */
  exemptAddresses?: ReadonlyArray<{ ip: string; port: number }>;
  /**
   * Whether to allow RFC 1918 private unicast addresses (10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16).
   * Off by default; enabled only when the operator explicitly sets CQA_ALLOW_INTRANET.
   */
  allowPrivateAddresses?: boolean;
}

export type PolicyDecision =
  | { ok: true; url: URL; addresses: string[] }
  | { ok: false; reason: ReasonCode; detail: string };

const DEFAULT_PORTS: Record<string, number> = { 'http:': 80, 'https:': 443 };

export function effectivePort(url: URL): number {
  return url.port ? Number(url.port) : (DEFAULT_PORTS[url.protocol] ?? 0);
}

/**
 * Returns true only for RFC 1918 private IPv4 addresses (10/8, 172.16/12, 192.168/16)
 * and IPv6 unique local addresses (fc00::/7).
 */
export function isPrivateAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      parsed = v6.toIPv4Address();
    }
  }
  if (parsed.kind() === 'ipv4') {
    return parsed.range() === 'private';
  }
  return parsed.range() === 'uniqueLocal';
}

/**
 * Returns true only for publicly routable unicast addresses. IPv4-mapped and
 * NAT64-embedded IPv4 addresses are unwrapped and checked as IPv4.
 */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6') {
    const v6 = parsed as ipaddr.IPv6;
    if (v6.isIPv4MappedAddress()) {
      parsed = v6.toIPv4Address();
    } else if (v6.range() === 'rfc6052') {
      // 64:ff9b::/96 embeds an IPv4 address in the last 32 bits.
      const bytes = v6.toByteArray().slice(12);
      parsed = new ipaddr.IPv4(bytes);
    }
  }
  if (parsed.kind() === 'ipv4') {
    return parsed.range() === 'unicast';
  }
  const range = parsed.range();
  // ipaddr.js labels global IPv6 as "unicast"; everything else (loopback,
  // uniqueLocal, linkLocal, multicast, reserved, teredo, 6to4, etc.) is denied.
  return range === 'unicast';
}

function stripBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

export class NetworkPolicy {
  private readonly resolver: Resolver;
  private readonly exempt: Set<string>;
  private readonly allowPrivateAddresses: boolean;

  constructor(options: PolicyOptions = {}) {
    this.resolver = options.resolver ?? systemResolver;
    this.exempt = new Set((options.exemptAddresses ?? []).map((e) => `${normalizeIp(e.ip)}|${e.port}`));
    this.allowPrivateAddresses = options.allowPrivateAddresses ?? false;
  }

  isAddressAllowed(address: string, port: number): boolean {
    if (this.exempt.has(`${normalizeIp(address)}|${port}`)) return true;
    if (this.allowPrivateAddresses && isPrivateAddress(address)) return true;
    return isPublicAddress(address);
  }

  /** Syntactic checks that need no DNS: scheme, credentials, parseability. */
  parseTarget(raw: string): { ok: true; url: URL } | { ok: false; reason: ReasonCode; detail: string } {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return { ok: false, reason: 'blocked_by_policy', detail: 'Not a valid absolute URL.' };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { ok: false, reason: 'blocked_by_policy', detail: `Scheme ${url.protocol} is not allowed; use http or https.` };
    }
    if (url.username || url.password) {
      return { ok: false, reason: 'blocked_by_policy', detail: 'URLs with embedded credentials are not allowed.' };
    }
    if (!url.hostname) {
      return { ok: false, reason: 'blocked_by_policy', detail: 'URL has no host.' };
    }
    return { ok: true, url };
  }

  /** Whether a URL is inside the configured navigation scope (origin, path prefix, port). */
  inScope(url: URL, scope: ScanScope): { ok: true } | { ok: false; detail: string } {
    if (!scope.allowedOrigins.includes(url.origin)) {
      return { ok: false, detail: `Origin ${url.origin} is outside the allowed origins.` };
    }
    const port = effectivePort(url);
    if (port !== DEFAULT_PORTS[url.protocol] && !scope.allowedPorts.includes(port)) {
      return { ok: false, detail: `Port ${port} is not in the allowed ports.` };
    }
    if (scope.allowedPathPrefixes.length > 0 && !scope.allowedPathPrefixes.some((p) => url.pathname.startsWith(p))) {
      return { ok: false, detail: `Path ${url.pathname} is outside the allowed path prefixes.` };
    }
    return { ok: true };
  }

  /**
   * Resolves a host and requires every resolved address to be allowed.
   * Returns the validated addresses so callers can connect to them directly
   * (pinning), which prevents DNS rebinding between check and use.
   */
  async resolveAllowed(hostname: string, port: number): Promise<{ ok: true; addresses: string[] } | { ok: false; reason: ReasonCode; detail: string }> {
    const host = stripBrackets(hostname);
    let addresses: string[];
    if (ipaddr.isValid(host)) {
      addresses = [host];
    } else {
      try {
        addresses = await this.resolver(host);
      } catch (err) {
        return { ok: false, reason: 'navigation_failed', detail: `DNS lookup failed for ${host}: ${(err as Error).message}` };
      }
      if (addresses.length === 0) {
        return { ok: false, reason: 'navigation_failed', detail: `DNS returned no addresses for ${host}.` };
      }
    }
    const denied = addresses.find((a) => !this.isAddressAllowed(a, port));
    if (denied) {
      return { ok: false, reason: 'blocked_by_policy', detail: `${host} resolves to a private or reserved address (${denied}).` };
    }
    return { ok: true, addresses };
  }

  /** Full target validation: syntax, scope, and resolved destination. */
  async validateTarget(raw: string, scope: ScanScope): Promise<PolicyDecision> {
    const parsed = this.parseTarget(raw);
    if (!parsed.ok) return parsed;
    const scoped = this.inScope(parsed.url, scope);
    if (!scoped.ok) return { ok: false, reason: 'out_of_scope', detail: scoped.detail };
    const resolved = await this.resolveAllowed(parsed.url.hostname, effectivePort(parsed.url));
    if (!resolved.ok) return resolved;
    return { ok: true, url: parsed.url, addresses: resolved.addresses };
  }
}

function normalizeIp(ip: string): string {
  const host = stripBrackets(ip);
  return ipaddr.isValid(host) ? ipaddr.parse(host).toNormalizedString() : host;
}
