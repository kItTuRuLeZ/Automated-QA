import os from 'node:os';

/**
 * Optional LAN demo mode. Off unless CQA_LAN_HOST is set; localhost-only stays the default.
 *
 * This file only decides what the server entry point binds and which Host and Origin values it accepts. It lives in the
 * server app on purpose: the shared core configuration (SERVER_HOST, PACKAGE_PORT) is not touched, so the package
 * server and everything else in core remain loopback-only whatever is set here.
 */
export interface LanConfig {
  /** The one private IPv4 address the application API and UI bind to. Never 0.0.0.0. */
  host: string;
  port: number;
  user: string;
  password: string;
  /** Exactly the LAN Host header, and nothing else. */
  allowedHosts: string[];
  /** Exactly the LAN origin, and nothing else. */
  allowedOrigins: string[];
}

export type LanResolution = { mode: 'local' } | { mode: 'lan'; config: LanConfig } | { mode: 'invalid'; problems: string[] };

export type Interfaces = ReturnType<typeof os.networkInterfaces>;

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/** RFC 1918 private ranges only: 10/8, 172.16/12, 192.168/16. */
export function isPrivateIPv4(ip: string): boolean {
  if (!IPV4.test(ip)) return false;
  const [a, b] = ip.split('.').map(Number) as [number, number];
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

export function localPrivateAddresses(interfaces: Interfaces = os.networkInterfaces()): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal && isPrivateIPv4(i.address)) out.push(i.address);
  return [...new Set(out)];
}

export const MIN_PASSWORD_LENGTH = 12;

/**
 * Reads the LAN settings. A half-configured or unsafe LAN setting never falls back to something else: it returns
 * "invalid" with every problem, and the server refuses to start.
 */
export function resolveLanMode(env: NodeJS.ProcessEnv, port: number, interfaces: Interfaces = os.networkInterfaces()): LanResolution {
  const rawHost = env.CQA_LAN_HOST?.trim();
  if (!rawHost) {
    const stray = ['CQA_LAN_USER', 'CQA_LAN_PASSWORD'].filter((k) => env[k]);
    // Credentials without a host mean the person meant to turn LAN mode on. Say so instead of silently staying local.
    return stray.length ? { mode: 'invalid', problems: [`${stray.join(' and ')} is set but CQA_LAN_HOST is not. Set CQA_LAN_HOST to this computer's private IPv4 address to turn LAN demo mode on, or clear ${stray.join(' and ')} to stay on this computer only.`] } : { mode: 'local' };
  }

  const problems: string[] = [];
  const available = localPrivateAddresses(interfaces);
  if (!IPV4.test(rawHost)) problems.push(`CQA_LAN_HOST must be one IPv4 address such as 192.168.1.50 (not a name, not a range). It is "${rawHost}".`);
  else if (rawHost === '0.0.0.0') problems.push('CQA_LAN_HOST must not be 0.0.0.0. The app binds only to the one address you name.');
  else if (rawHost.startsWith('127.')) problems.push('CQA_LAN_HOST must not be a loopback address. Leave CQA_LAN_HOST unset for this-computer-only mode.');
  else if (!isPrivateIPv4(rawHost)) problems.push(`CQA_LAN_HOST must be a private network address (10.x.x.x, 172.16-31.x.x or 192.168.x.x). ${rawHost} is not.`);
  else if (!available.includes(rawHost)) problems.push(`${rawHost} is not an address of this computer.${available.length ? ` Private addresses found here: ${available.join(', ')}.` : ' No private network address was found; connect to the network first.'}`);

  const user = env.CQA_LAN_USER?.trim() || 'demo';
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(user)) problems.push('CQA_LAN_USER may use letters, digits, dot, dash and underscore only, up to 32 characters.');
  const password = env.CQA_LAN_PASSWORD ?? '';
  if (!password) problems.push('CQA_LAN_PASSWORD is required in LAN demo mode. There is no default password.');
  else if (password.length < MIN_PASSWORD_LENGTH) problems.push(`CQA_LAN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  else if (password.toLowerCase() === user.toLowerCase()) problems.push('CQA_LAN_PASSWORD must not be the same as the user name.');

  if (problems.length) return { mode: 'invalid', problems };
  const hostHeader = `${rawHost}:${port}`;
  return { mode: 'lan', config: { host: rawHost, port, user, password, allowedHosts: [hostHeader], allowedOrigins: [`http://${hostHeader}`] } };
}
