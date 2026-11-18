import { closeSync, openSync, readSync } from 'node:fs';
import path from 'node:path';

/**
 * Static checks on the package's media files and file names (PKG-008 to PKG-011). They read file sizes, image
 * headers and, for Rise, the course data's own list of assets. Nothing is decoded or played, and no course code runs.
 * Every outcome here is advisory (needs review): a large file or a missing caption file is often a real problem,
 * but the course's own player may handle it, and the runtime checks (MED-003, MED-005) decide on screens reached.
 */
export type MediaRuleId = 'PKG-008' | 'PKG-009' | 'PKG-010' | 'PKG-011';
export interface MediaIssue {
  ruleId: MediaRuleId;
  outcome: 'passed' | 'needs_review' | 'not_applicable';
  title?: string;
  detail: string;
  paths?: string[];
}

export const MEDIA_LIMITS = {
  imageBytes: 1024 * 1024,
  imageWidthPx: 2560,
  videoBytes: 50 * 1024 * 1024,
  audioBytes: 20 * 1024 * 1024,
  packageBytes: 100 * 1024 * 1024,
};
const MAX_LISTED = 50;

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg']);
const VIDEO_EXT = new Set(['.mp4', '.m4v', '.webm', '.mov', '.ogv']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.wav', '.ogg', '.aac']);
const CAPTION_EXT = new Set(['.vtt', '.srt']);

export const formatBytes = (n: number): string => (n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

function readHead(file: string, bytes: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/** Width and height from a PNG or JPEG header, or undefined when the header cannot be read. */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return undefined;
      const marker = buf[i + 1]!;
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
        i += 2;
        continue;
      }
      const len = buf.readUInt16BE(i + 2);
      // Start-of-frame markers (baseline, progressive and the rarer kinds), never DHT (C4), JPG (C8) or DAC (CC).
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) return undefined;
      i += 2 + len;
    }
  }
  return undefined;
}

const keyOf = (name: string): string => {
  let n = name;
  try {
    n = decodeURIComponent(name);
  } catch {
    /* keep as is */
  }
  return path.posix.basename(n.split(/[?#]/)[0]!).toLowerCase();
};

/**
 * Video file names that the course data links to a caption file. Two shapes are recognised: an asset list where a
 * caption asset names its video's asset id (Rise), and a video object whose own fields include a .vtt or .srt file.
 */
export function captionedVideosFromData(data: unknown): Set<string> {
  const out = new Set<string>();
  const assets = new Map<string, { path?: string; type?: string; videoAssetId?: string }>();
  const isVideo = (s: string) => VIDEO_EXT.has(path.extname(keyOf(s)));
  const hasCaption = (o: unknown, depth: number): boolean => {
    if (depth > 4 || !o || typeof o !== 'object') return false;
    for (const v of Object.values(o as Record<string, unknown>)) {
      if (typeof v === 'string' && CAPTION_EXT.has(path.extname(keyOf(v)))) return true;
      if (typeof v === 'object' && hasCaption(v, depth + 1)) return true;
    }
    return false;
  };
  const walk = (o: unknown, depth: number) => {
    if (depth > 60 || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      for (const v of o) walk(v, depth + 1);
      return;
    }
    const rec = o as Record<string, unknown>;
    if (typeof rec.id === 'string' && typeof rec.type === 'string' && (typeof rec.path === 'string' || typeof rec.videoAssetId === 'string')) {
      assets.set(rec.id, { path: rec.path as string | undefined, type: rec.type, videoAssetId: rec.videoAssetId as string | undefined });
    }
    const own = Object.values(rec).filter((v): v is string => typeof v === 'string' && isVideo(v));
    if (own.length && hasCaption(rec, 0)) for (const v of own) out.add(keyOf(v));
    for (const v of Object.values(rec)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  walk(data, 0);
  for (const a of assets.values()) {
    if (a.type !== 'caption' || !a.videoAssetId) continue;
    const video = assets.get(a.videoAssetId);
    if (video?.path) out.add(keyOf(video.path));
  }
  return out;
}

export function checkMediaAndNames(root: string, files: ReadonlyArray<{ rel: string; bytes: number }>, courseData?: { data: unknown; product: string }): MediaIssue[] {
  const issues: MediaIssue[] = [];
  const ext = (rel: string) => path.extname(rel).toLowerCase();

  // PKG-008: heavy media files.
  const heavy: MediaIssue[] = [];
  let unreadable = 0;
  for (const f of files) {
    const e = ext(f.rel);
    if (IMAGE_EXT.has(e)) {
      const notes: string[] = [];
      if (f.bytes > MEDIA_LIMITS.imageBytes) notes.push(`${formatBytes(f.bytes)}, above the ${formatBytes(MEDIA_LIMITS.imageBytes)} limit`);
      if (e === '.png' || e === '.jpg' || e === '.jpeg') {
        let size: { width: number; height: number } | undefined;
        try {
          size = imageSize(readHead(path.join(root, f.rel), 512 * 1024));
        } catch {
          size = undefined;
        }
        if (!size) unreadable++;
        else if (size.width > MEDIA_LIMITS.imageWidthPx) notes.push(`${size.width} × ${size.height} px, wider than ${MEDIA_LIMITS.imageWidthPx} px`);
      }
      if (notes.length) heavy.push({ ruleId: 'PKG-008', outcome: 'needs_review', title: `Large image: ${path.posix.basename(f.rel)} (${notes.join('; ')})`, detail: `"${f.rel}" is ${notes.join(' and ')}. Images this big slow the screen down and enlarge the package. Export it at the size it is shown and compress it.`, paths: [f.rel] });
    } else if (VIDEO_EXT.has(e) && f.bytes > MEDIA_LIMITS.videoBytes) {
      heavy.push({ ruleId: 'PKG-008', outcome: 'needs_review', title: `Large video: ${path.posix.basename(f.rel)} (${formatBytes(f.bytes)})`, detail: `"${f.rel}" is ${formatBytes(f.bytes)}, above the ${formatBytes(MEDIA_LIMITS.videoBytes)} limit. Large videos are slow to start through an LMS. Re-encode it or stream it from a video service.`, paths: [f.rel] });
    } else if (AUDIO_EXT.has(e) && f.bytes > MEDIA_LIMITS.audioBytes) {
      heavy.push({ ruleId: 'PKG-008', outcome: 'needs_review', title: `Large audio file: ${path.posix.basename(f.rel)} (${formatBytes(f.bytes)})`, detail: `"${f.rel}" is ${formatBytes(f.bytes)}, above the ${formatBytes(MEDIA_LIMITS.audioBytes)} limit.`, paths: [f.rel] });
    }
  }
  const unreadNote = unreadable ? ` The pixel size of ${unreadable} image(s) could not be read from their headers.` : '';
  if (heavy.length) issues.push(...heavy.slice(0, MAX_LISTED));
  if (heavy.length > MAX_LISTED) issues.push({ ruleId: 'PKG-008', outcome: 'needs_review', title: `${heavy.length - MAX_LISTED} more large media files`, detail: `Only the first ${MAX_LISTED} are listed.` });
  if (!heavy.length) issues.push({ ruleId: 'PKG-008', outcome: 'passed', detail: `No image is over ${formatBytes(MEDIA_LIMITS.imageBytes)} or wider than ${MEDIA_LIMITS.imageWidthPx} px, no video over ${formatBytes(MEDIA_LIMITS.videoBytes)} and no audio over ${formatBytes(MEDIA_LIMITS.audioBytes)}.${unreadNote}` });
  else if (unreadNote) issues.push({ ruleId: 'PKG-008', outcome: 'needs_review', title: 'Some image sizes could not be read', detail: unreadNote.trim() });

  // PKG-009: total size.
  const total = files.reduce((n, f) => n + f.bytes, 0);
  issues.push(
    total > MEDIA_LIMITS.packageBytes
      ? { ruleId: 'PKG-009', outcome: 'needs_review', title: `Package is ${formatBytes(total)} unzipped`, detail: `The unzipped package is ${formatBytes(total)}, above ${formatBytes(MEDIA_LIMITS.packageBytes)}. Many LMSs limit uploads to about that size, and learners on slow connections wait longer. The largest files: ${[...files].sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((f) => `${f.rel} (${formatBytes(f.bytes)})`).join(', ')}.` }
      : { ruleId: 'PKG-009', outcome: 'passed', detail: `The unzipped package is ${formatBytes(total)}, within ${formatBytes(MEDIA_LIMITS.packageBytes)}.` },
  );

  // PKG-010: a caption file for each video.
  const videos = files.filter((f) => VIDEO_EXT.has(ext(f.rel)));
  if (!videos.length) issues.push({ ruleId: 'PKG-010', outcome: 'not_applicable', detail: 'The package has no video files.' });
  else {
    const linked = courseData ? captionedVideosFromData(courseData.data) : new Set<string>();
    // A caption file named after the video, in any folder, with or without a language suffix (intro.vtt, intro.en.vtt, intro_en.srt).
    const stem = (rel: string) => path.posix.basename(rel, path.extname(rel)).toLowerCase();
    const captionStems = files.filter((f) => CAPTION_EXT.has(ext(f.rel))).map((f) => stem(f.rel));
    const hasNamedCaption = (v: string) => captionStems.some((c) => c === stem(v) || (c.startsWith(stem(v)) && /^[._-][a-z]{2}(?:[-_][a-z]{2})?$/.test(c.slice(stem(v).length))));
    const missing = videos.filter((v) => !linked.has(keyOf(v.rel)) && !hasNamedCaption(v.rel));
    const how = courseData ? `${courseData.product}'s course data and caption files with the same name` : 'caption files (.vtt or .srt) with the same name next to each video';
    for (const v of missing.slice(0, MAX_LISTED)) {
      issues.push({ ruleId: 'PKG-010', outcome: 'needs_review', title: `Video has no caption file: ${path.posix.basename(v.rel)}`, detail: `No caption file is linked to "${v.rel}" (looked in ${how}). If the video has speech, learners who cannot hear it need captions. Captions added in code are not seen here; the runtime caption check decides for videos on screens the scan reaches.`, paths: [v.rel] });
    }
    if (!missing.length) issues.push({ ruleId: 'PKG-010', outcome: 'passed', detail: `Each of the ${videos.length} video(s) has a caption file (found through ${how}).` });
  }

  // PKG-011: file names that some servers and LMSs handle badly.
  const awkward = files.filter((f) => /[^A-Za-z0-9._\-/]/.test(f.rel));
  issues.push(
    awkward.length
      ? { ruleId: 'PKG-011', outcome: 'needs_review', title: `${awkward.length} file name(s) contain spaces or special characters`, detail: `For example: ${awkward.slice(0, 5).map((f) => f.rel).join(', ')}. Most LMSs cope, but some older ones and some proxies do not. Use letters, digits, hyphens and underscores only.`, paths: awkward.slice(0, 10).map((f) => f.rel) }
      : { ruleId: 'PKG-011', outcome: 'passed', detail: 'Every file name uses only letters, digits, dots, hyphens and underscores.' },
  );
  return issues;
}
