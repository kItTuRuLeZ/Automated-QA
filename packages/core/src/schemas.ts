import { z } from 'zod';

/** API input schemas. Output types come from @cqa/shared. */

export const CreateProjectInput = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120),
  description: z.string().trim().max(2000).optional(),
  courseUrl: z.string().trim().max(2048).optional().or(z.literal('').transform(() => undefined)),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

const origin = z
  .string()
  .trim()
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v.replace(/\/$/, '');
    } catch {
      return false;
    }
  }, 'Must be an origin like https://example.com')
  .transform((v) => new URL(v).origin);

export const CreateScanInput = z.object({
  url: z.string().trim().min(1, 'URL is required').max(2048),
  allowedOrigins: z.array(origin).max(20).optional(),
  allowedPathPrefixes: z
    .array(z.string().trim().startsWith('/', 'Path prefixes must start with /').max(512))
    .max(20)
    .optional(),
  navigationTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  viewport: z
    .object({
      name: z.string().trim().min(1).max(40),
      width: z.number().int().min(200).max(3840),
      height: z.number().int().min(200).max(2160),
    })
    .optional(),
});
export type CreateScanInput = z.infer<typeof CreateScanInput>;
