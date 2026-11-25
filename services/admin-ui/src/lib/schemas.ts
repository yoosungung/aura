import { z } from 'zod';

export const uuidSchema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    'tenant UUID required'
  );

export const sessionSchema = z.object({
  bearer: z.string().min(1, 'Bearer token required'),
  baseUrl: z.string().url('base URL required'),
  tenantId: uuidSchema.optional(),
});

export const sourceKindSchema = z.enum(['agent', 'mcp']);
export const runtimeSchema = z.enum(['nodejs', 'python', 'custom']);

const configObjectSchema = z
  .record(z.unknown())
  .superRefine((val, ctx) => {
    if ('runtime' in val) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'runtime_in_config_forbidden',
      });
    }
  });

export const checksumSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/i, 'checksum must be sha256:<64 hex>');

export const createSourceSchema = z.object({
  kind: sourceKindSchema,
  name: z.string().min(1),
  version: z.string().min(1),
  entrypoint: z.string().min(1),
  bundle_uri: z.string().min(1),
  checksum: checksumSchema,
  runtime: z.enum(['nodejs', 'python']).default('nodejs'),
  sig_uri: z.string().optional(),
  config: configObjectSchema.default({}),
});

/** custom = container executor Function name in entrypoint; no Garage upload. */
export const createCustomSourceSchema = z
  .object({
    kind: sourceKindSchema,
    name: z.string().min(1),
    version: z.string().min(1),
    entrypoint: z.string().min(1),
    runtime: z.literal('custom'),
    sig_uri: z.string().optional(),
    config: configObjectSchema.default({}),
  })
  .superRefine((val, ctx) => {
    const ep = val.entrypoint;
    let ok = false;
    if (val.kind === 'agent') {
      ok = ep.startsWith('aura-agent-invoke-') && ep.length > 'aura-agent-invoke-'.length;
    } else if (ep.startsWith('aura-mcp-invoke-rpc-')) {
      ok = ep.length > 'aura-mcp-invoke-rpc-'.length;
    } else if (ep.startsWith('aura-mcp-invoke-')) {
      ok = ep.length > 'aura-mcp-invoke-'.length;
    }
    if (!ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'function_prefix_invalid',
        path: ['entrypoint'],
      });
    }
  });

export const overlaySchema = z
  .object({
    principal_id: z.string().min(1),
    config: configObjectSchema.default({}),
    secrets_ref: z.string().optional().nullable(),
    reason: z.string().optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    if ('secrets' in val || 'secret_value' in val) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plaintext_secrets_forbidden',
      });
    }
  });

export const reasonSchema = z.object({
  reason: z.string().min(1, 'reason_required'),
});

export const auditItemSchema = z.object({
  id: z.string(),
  actor: z.string(),
  action: z.string(),
  resource_type: z.string(),
  resource_id: z.string(),
  reason: z.string().nullable().optional(),
  at: z.string(),
});

export const auditListSchema = z.object({
  items: z.array(auditItemSchema),
  next_cursor: z.string().nullable().optional(),
});

export type CreateSourceInput = z.infer<typeof createSourceSchema>;
export type CreateCustomSourceInput = z.infer<typeof createCustomSourceSchema>;
export type OverlayInput = z.infer<typeof overlaySchema>;
