import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captionedVideosFromData, checkMediaAndNames, extractArchive, imageSize, inspectPackage, MEDIA_LIMITS } from '@cqa/core';
import { makeZip, manifest2004, page } from './support/packages.js';

const MB = 1024 * 1024;
const png = (w: number, h: number, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};
/** A JPEG with an APP0 segment, a DHT table (C4, which must not be read as a frame) and then a baseline frame. */
const jpeg = (w: number, h: number, pad = 0) => {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x05, 0x00, 0x01, 0x02]);
  const sof = Buffer.alloc(11);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(9, 2);
  sof[4] = 8;
  sof.writeUInt16BE(h, 5);
  sof.writeUInt16BE(w, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, dht, sof, Buffer.alloc(pad)]);
};

const dirWith = (files: Record<string, Buffer | string>) => {
  const root = mkdtempSync(path.join(tmpdir(), 'cqa-media-'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  return { root, list: Object.entries(files).map(([rel, body]) => ({ rel, bytes: Buffer.byteLength(body) })) };
};
const of = (issues: ReturnType<typeof checkMediaAndNames>, id: string) => issues.filter((i) => i.ruleId === id);

describe('image headers', () => {
  it('reads PNG and JPEG sizes, skipping a JPEG table segment that is not a frame', () => {
    expect(imageSize(png(10639, 3780))).toEqual({ width: 10639, height: 3780 });
    expect(imageSize(jpeg(6000, 2637))).toEqual({ width: 6000, height: 2637 });
    expect(imageSize(Buffer.from('not an image'))).toBeUndefined();
  });
});

describe('PKG-008 large media', () => {
  it('flags an image over 1 MB, an image wider than 2560 px, a large video and large audio, and nothing below the limits', () => {
    const { root, list } = dirWith({
      'a/heavy.png': png(800, 600, MB + 10),
      'a/wide.jpg': jpeg(4000, 1000),
      'a/fine.jpg': jpeg(2560, 1440, 200 * 1024),
      'a/ok.png': png(1280, 720),
    });
    const issues = checkMediaAndNames(root, [...list, { rel: 'v/big.mp4', bytes: MEDIA_LIMITS.videoBytes + 1 }, { rel: 'v/small.mp4', bytes: 1000 }, { rel: 's/long.mp3', bytes: MEDIA_LIMITS.audioBytes + 1 }]);
    const flagged = of(issues, 'PKG-008').flatMap((i) => i.paths ?? []);
    expect(flagged.sort()).toEqual(['a/heavy.png', 'a/wide.jpg', 's/long.mp3', 'v/big.mp4']);
    expect(of(issues, 'PKG-008').every((i) => i.outcome === 'needs_review')).toBe(true);
    expect(of(issues, 'PKG-008').find((i) => i.paths?.[0] === 'a/wide.jpg')!.title).toMatch(/4000 × 1000 px/);
  });

  it('passes when nothing is over the limits, and says when an image header could not be read', () => {
    const { root, list } = dirWith({ 'ok.png': png(100, 100), 'broken.jpg': Buffer.from('xx') });
    const issues = of(checkMediaAndNames(root, list), 'PKG-008');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ outcome: 'passed' });
    expect(issues[0]!.detail).toMatch(/1 image\(s\) could not be read/);
  });
});

describe('PKG-009 package size', () => {
  it('flags a package over 100 MB and names its largest files', () => {
    const big = of(checkMediaAndNames('.', [{ rel: 'x.bin', bytes: 60 * MB }, { rel: 'y.bin', bytes: 41 * MB }]), 'PKG-009')[0]!;
    expect(big.outcome).toBe('needs_review');
    expect(big.detail).toMatch(/x\.bin \(60\.0 MB\)/);
    expect(of(checkMediaAndNames('.', [{ rel: 'x.bin', bytes: 99 * MB }]), 'PKG-009')[0]!.outcome).toBe('passed');
  });
});

describe('PKG-010 caption files', () => {
  it('accepts a caption file with the same name, and flags a video without one', () => {
    const issues = of(checkMediaAndNames('.', [{ rel: 'm/intro.mp4', bytes: 1 }, { rel: 'm/intro.vtt', bytes: 1 }, { rel: 'm/outro.mp4', bytes: 1 }, { rel: 'other/outtro.vtt', bytes: 1 }]), 'PKG-010');
    expect(issues.map((i) => i.paths?.[0])).toEqual(['m/outro.mp4']);
    expect(issues[0]!.outcome).toBe('needs_review');
  });

  it('links captions the way Rise does (a caption asset naming its video asset), so a renamed caption file still counts', () => {
    const course = {
      mondrian: { items: { x: { assets: {
        v1: { id: 'v1', path: 'cmvideo1.mp4', name: 'avatar-video.mp4', type: 'video' },
        c1: { id: 'c1', path: 'cmcaption1.vtt', name: 'ai-captions.vtt', type: 'caption', videoAssetId: 'v1' },
        v2: { id: 'v2', path: 'avatar-video.mp4', type: 'video' },
        c2: { id: 'c2', path: 'cmcaption2.vtt', type: 'caption', videoAssetId: 'v2' },
      } } } },
      lessons: [{ items: [{ media: { video: { key: 'Eric%20Itambo.mp4', originalUrl: 'Eric Itambo.mp4' } } }, { media: { video: { key: 'talk.mp4', captions: [{ key: 'talk-en.vtt' }] } } }] }],
    };
    expect([...captionedVideosFromData(course)].sort()).toEqual(['avatar-video.mp4', 'cmvideo1.mp4', 'talk.mp4']);
    const files = ['cmvideo1.mp4', 'avatar-video.mp4', 'Eric Itambo.mp4', 'talk.mp4', 'cmcaption1.vtt', 'cmcaption2.vtt', 'talk-en.vtt'].map((f) => ({ rel: `scormcontent/assets/${f}`, bytes: 1 }));
    const issues = of(checkMediaAndNames('.', files, { data: course, product: 'Rise 360' }), 'PKG-010');
    expect(issues.map((i) => i.paths?.[0])).toEqual(['scormcontent/assets/Eric Itambo.mp4']);
    expect(issues[0]!.detail).toMatch(/Rise 360's course data/);
  });

  it('does not count an unrelated caption elsewhere in the same lesson as the video\'s captions', () => {
    const course = { lessons: [{ items: [{ media: { video: { key: 'a.mp4' } } }, { media: { video: { key: 'b.mp4', captions: [{ key: 'b.vtt' }] } } }] }] };
    expect([...captionedVideosFromData(course)]).toEqual(['b.mp4']);
  });

  it('accepts a caption file with a language suffix or in another folder, but not one for a different video', () => {
    const files = ['media/intro.mp4', 'media/intro.en.vtt', 'media/demo.mp4', 'captions/demo_en-us.srt', 'media/intro2.mp4', 'media/intro-final.vtt'].map((rel) => ({ rel, bytes: 1 }));
    expect(of(checkMediaAndNames('.', files), 'PKG-010').map((i) => i.paths?.[0])).toEqual(['media/intro2.mp4']);
  });

  it('passes when every video has captions and is not applicable without video', () => {
    expect(of(checkMediaAndNames('.', [{ rel: 'a.mp4', bytes: 1 }, { rel: 'a.srt', bytes: 1 }]), 'PKG-010')[0]!.outcome).toBe('passed');
    expect(of(checkMediaAndNames('.', [{ rel: 'a.png', bytes: 1 }]), 'PKG-010')[0]!.outcome).toBe('not_applicable');
  });
});

describe('PKG-011 file names', () => {
  it('flags spaces and special characters, and passes plain names', () => {
    const bad = of(checkMediaAndNames('.', [{ rel: 'assets/Eric Itambo.png', bytes: 1 }, { rel: 'assets/café.jpg', bytes: 1 }, { rel: 'assets/ok_file-1.js', bytes: 1 }]), 'PKG-011')[0]!;
    expect(bad).toMatchObject({ outcome: 'needs_review', paths: ['assets/Eric Itambo.png', 'assets/café.jpg'] });
    expect(of(checkMediaAndNames('.', [{ rel: 'a/b_c-1.png', bytes: 1 }]), 'PKG-011')[0]!.outcome).toBe('passed');
  });
});

describe('package inspection includes the media checks', () => {
  it('runs them on an uploaded package and does not keep the decoded course data', () => {
    const runtimeData = (course: object) => `__jsonp("runtime-data.js","${Buffer.from(JSON.stringify({ course })).toString('base64')}");`;
    const dir = path.join(mkdtempSync(path.join(tmpdir(), 'cqa-media-')), 'content');
    extractArchive(
      makeZip({
        'imsmanifest.xml': manifest2004({ launch: 'scormdriver/indexAPI.html' }),
        'scormdriver/indexAPI.html': page('Rise driver'),
        'scormcontent/index.html': page('Rise', '', '<script src="lib/rise/app.js"></script>'),
        'scormcontent/lib/rise/app.js': '1',
        'scormcontent/runtime-data.js': runtimeData({ lessons: [{ type: 'blocks', title: 'One', items: [{ media: { video: { key: 'clip.mp4', captions: [{ key: 'clip-en.vtt' }] } } }] }], exportSettings: {} }),
        'scormcontent/assets/clip.mp4': 'x',
        'scormcontent/assets/clip-en.vtt': 'WEBVTT',
        'scormcontent/assets/Bad Name.mp4': 'x',
      }),
      dir,
    );
    const r = inspectPackage(dir);
    expect(r.authoringTool?.tool).toBe('rise');
    expect(r.authoringTool?.courseData).toBeUndefined();
    expect(r.issues.filter((i) => i.ruleId === 'PKG-010').map((i) => i.paths?.[0])).toEqual(['scormcontent/assets/Bad Name.mp4']);
    expect(r.issues.find((i) => i.ruleId === 'PKG-011')!.outcome).toBe('needs_review');
    expect(r.issues.find((i) => i.ruleId === 'PKG-009')!.outcome).toBe('passed');
  });
});
