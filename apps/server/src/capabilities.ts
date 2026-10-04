import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

export type CapabilityStatus = 'available' | 'blocked' | 'unavailable' | 'not_included';

export interface Capability {
  id: string;
  name: string;
  status: CapabilityStatus;
  detail: string;
}

export interface CapabilityOptions {
  /** Where the browser should be; undefined when Playwright cannot say. Injectable for tests. */
  browserExecutable?: () => string | undefined;
  localTargets?: Array<{ ip: string; port: number }>;
  retentionDays?: number;
}

function defaultBrowserExecutable(): string | undefined {
  try {
    return chromium.executablePath();
  } catch {
    return undefined;
  }
}

/**
 * What this installation can and cannot do right now, stated plainly, so a
 * missing browser or an unbuilt feature is never mistaken for a clean result.
 */
export function buildCapabilities(opts: CapabilityOptions = {}): Capability[] {
  const exe = (opts.browserExecutable ?? defaultBrowserExecutable)();
  const browserOk = Boolean(exe && existsSync(exe));
  const local = opts.localTargets ?? [];
  return [
    browserOk
      ? { id: 'browser', name: 'Scanning browser (Chromium)', status: 'available', detail: 'Installed. Scans, screenshots, and PDF reports can run.' }
      : { id: 'browser', name: 'Scanning browser (Chromium)', status: 'blocked', detail: 'Not installed, so scans and PDF reports cannot run. Run "npm run browsers:install" once while online, then restart the app.' },
    browserOk
      ? { id: 'pdf', name: 'PDF reports', status: 'available', detail: 'Made offline from the same report as the HTML and Excel files.' }
      : { id: 'pdf', name: 'PDF reports', status: 'blocked', detail: 'Needs the scanning browser. JSON, HTML, and Excel reports still work.' },
    { id: 'reports', name: 'JSON, HTML, and Excel reports', status: 'available', detail: 'Always available for any finished scan.' },
    local.length
      ? { id: 'local-targets', name: 'Scanning courses on this computer', status: 'available', detail: `Allowed for ${local.map((l) => `${l.ip}:${l.port}`).join(', ')} by the administrator setting CQA_ALLOW_LOCAL_TARGETS. All other private addresses stay blocked.` }
      : { id: 'local-targets', name: 'Scanning courses on this computer', status: 'blocked', detail: 'Off. Private and loopback addresses are blocked. To scan the sample course pack offline, an administrator can allow exact 127.0.0.1 ports (see docs/SETUP.md).' },
    { id: 'retention', name: 'Automatic clean-up of old scans', status: opts.retentionDays ? 'available' : 'unavailable', detail: opts.retentionDays ? `Scans older than ${opts.retentionDays} days are deleted at start-up, except the latest scan of each course and scans that hold a visual baseline.` : 'Off. Scans are kept until you delete them or run "npm run retention".' },
    { id: 'backup', name: 'Backup and restore', status: 'available', detail: 'Command line: "npm run backup" and "npm run restore -- <file>". There is no button for it in the app.' },
    { id: 'packages', name: 'Course package upload (ZIP)', status: 'available', detail: 'Inspects SCORM 1.2, SCORM 2004, and HTML5 ZIPs without running them, then scans them from a separate local address with outside requests blocked. Scans run the course’s own JavaScript in a browser on this computer, not in a container, so only scan packages you are willing to run.' },
    { id: 'multi-user', name: 'Shared use by a team, sign-in', status: 'not_included', detail: 'This version runs on one computer for one person and is bound to that computer only. Shared hosting needs sign-in first and is not built.' },
    { id: 'docker-worker', name: 'Containerized scan worker', status: 'not_included', detail: 'Not built. Scans, including scans of uploaded packages, run in a Chromium process on this computer under your account.' },
    { id: 'ai', name: 'AI recommendations', status: 'not_included', detail: 'Not included. No AI service is used for any result, and there is nowhere to enter an AI key.' },
    { id: 'scorm', name: 'SCORM test harness (not an LMS)', status: 'available', detail: 'A built-in stand-in for the LMS side of SCORM 1.2 and SCORM 2004 checks what a course sends: start, saving, errors, status, bookmark, and your own pass/fail journeys. It is not an LMS, does not evaluate sequencing, and tests one lesson per scan. Nothing it shows says how a particular LMS will behave.' },
  ];
}
