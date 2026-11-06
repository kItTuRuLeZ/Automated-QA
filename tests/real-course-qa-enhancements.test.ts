import { describe, expect, it } from 'vitest';
import { detectSoftError, isTelemetryOrTracker } from '../apps/worker/src/engines/capture';
import { isAllowedContentFrameOrigin } from '../apps/worker/src/adapters/content-root';

describe('Soft-404 and Auth Wall Detection (detectSoftError)', () => {
  it('detects Articulate Review 360 item not found error', () => {
    const res = detectSoftError(
      'Item not found | Review 360',
      'https://360.articulate.com/review/content/95556fd0-4090-4e7d-b3e7-ba32aff3f52f/review',
      'Item not found',
      'The item you requested was not found. It may have been deleted or moved.',
    );
    expect(res).not.toBeNull();
    expect(res?.isError).toBe(true);
    expect(res?.type).toBe('not_found');
    expect(res?.title).toContain('Item not found');
  });

  it('detects generic 404 SPA shell error', () => {
    const res = detectSoftError(
      '404 Not Found',
      'https://lms.example.com/courses/123/view',
      'Page Not Found',
      'Sorry, the page you were looking for does not exist.',
    );
    expect(res).not.toBeNull();
    expect(res?.isError).toBe(true);
    expect(res?.type).toBe('not_found');
  });

  it('detects auth / login walls requiring sign in', () => {
    const res = detectSoftError(
      'Sign In - Articulate ID',
      'https://id.articulate.com/sign-in',
      'Sign in',
      'Sign in to your account with your email and password to continue.',
    );
    expect(res).not.toBeNull();
    expect(res?.isError).toBe(true);
    expect(res?.type).toBe('auth_required');
    expect(res?.title).toContain('requires sign-in');
  });

  it('does not flag normal course pages with typical lesson titles', () => {
    const res = detectSoftError(
      'Module 1: Workplace Safety Essentials',
      'https://learn.example.com/content/course1/index.html',
      'Workplace Safety Essentials',
      'Welcome to this lesson. In this topic, we will review the safety guidelines for all employees.',
    );
    expect(res).toBeNull();
  });
});

describe('Telemetry & Tracker Exclusion (isTelemetryOrTracker)', () => {
  it('identifies Bing ad beacon', () => {
    expect(isTelemetryOrTracker('https://bat.bing.com/action/0?ti=12345&Ver=2')).toBe(true);
  });

  it('identifies Google Analytics and Tag Manager beacons', () => {
    expect(isTelemetryOrTracker('https://www.google-analytics.com/g/collect?v=2')).toBe(true);
    expect(isTelemetryOrTracker('https://www.googletagmanager.com/gtm.js?id=GTM-XYZ')).toBe(true);
  });

  it('identifies Clarity, DoubleClick, and LinkedIn tracking', () => {
    expect(isTelemetryOrTracker('https://www.clarity.ms/tag/xyz')).toBe(true);
    expect(isTelemetryOrTracker('https://stats.g.doubleclick.net/r/collect')).toBe(true);
    expect(isTelemetryOrTracker('https://px.ads.linkedin.com/collect')).toBe(true);
  });

  it('identifies Review 360 session ping endpoints', () => {
    expect(isTelemetryOrTracker('https://360.articulate.com/sessions/me')).toBe(true);
    expect(isTelemetryOrTracker('https://example.com/api/v1/sessions')).toBe(true);
  });

  it('does not filter legitimate course images or media assets', () => {
    expect(isTelemetryOrTracker('https://example.com/assets/banner.png')).toBe(false);
    expect(isTelemetryOrTracker('https://example.com/scorm/media/intro.mp4')).toBe(false);
    expect(isTelemetryOrTracker('https://articulateusercontent.com/review/assets/icon.svg')).toBe(false);
  });
});

describe('Content Root Frame Origin Allowance (isAllowedContentFrameOrigin)', () => {
  it('allows same-origin iframes', () => {
    expect(
      isAllowedContentFrameOrigin('https://learn.example.com/frame1.html', 'https://learn.example.com/index.html'),
    ).toBe(true);
  });

  it('allows Articulate Review 360 embeds across subdomains and CDN', () => {
    expect(
      isAllowedContentFrameOrigin(
        'https://articulateusercontent.com/review/content/123/index.html',
        'https://360.articulate.com/review/content/123/review',
      ),
    ).toBe(true);
    expect(
      isAllowedContentFrameOrigin(
        'https://d1234.cloudfront.net/player/frame.html',
        'https://360.articulate.com/review/content/123/review',
      ),
    ).toBe(true);
  });

  it('allows organizational subdomains sharing second-level domain', () => {
    expect(
      isAllowedContentFrameOrigin(
        'https://content.mycompany.com/scorm/player.html',
        'https://lms.mycompany.com/courses/view',
      ),
    ).toBe(true);
  });

  it('blocks unrelated external third-party origins', () => {
    expect(
      isAllowedContentFrameOrigin(
        'https://untrusted-ad-network.com/widget.html',
        'https://learn.example.com/course/index.html',
      ),
    ).toBe(false);
  });
});

