import { z } from 'zod';
import { ROLES, RUNTIME_IDS, type RuntimeId } from './agents';
import { SECRETS, type SecretId } from './secrets';

// Runtime validation lives here, imported only by the main process, so zod stays out of the UI bundle.

export const ThemeSchema = z.enum(['system', 'dark', 'light']);
export const ApprovalModeSchema = z.enum(['ask', 'auto-in-workspace', 'yolo']);
export const QualitySchema = z.enum(['saver', 'balanced', 'max']);

export const SettingsSchema = z.object({
  theme: ThemeSchema,
  workspaceRoot: z.string().min(1),
  approvalMode: ApprovalModeSchema,
  quality: QualitySchema,
  missionTokenBudget: z.number('must be a number').int('must be a whole number').min(0, 'must be 0 or more').max(100_000, 'must be 100,000 or less'),
  maxParallelAgents: z.number('must be a number').int('must be a whole number').min(1, 'must be at least 1').max(16, 'must be 16 or fewer'),
  ollamaBaseUrl: z.string().url('must be a URL like http://127.0.0.1:11434'),
  brainVault: z.string(),
  recordToBrain: z.boolean(),
});

export const SettingsPatchSchema = SettingsSchema.partial().strict();

export const SecretIdSchema = z.enum(SECRETS.map((s) => s.id) as [SecretId, ...SecretId[]]);
export const SecretValueSchema = z.string().trim().min(8).max(512);

export const RoleSchema = z.enum(ROLES);
export const ModelRefSchema = z.object({ runtime: z.enum(RUNTIME_IDS as [RuntimeId, ...RuntimeId[]]), model: z.string().min(1).max(200) }).strict();
export const StartOptsSchema = z.object({ ref: ModelRefSchema.optional(), workspaceId: z.string().uuid().optional(), quality: QualitySchema.optional() }).strict();
