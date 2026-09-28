/** Provider credentials the OS can hold. Values never leave the main process. */
export const SECRETS = [
  { id: 'anthropic', label: 'Anthropic', env: 'ANTHROPIC_API_KEY', prefix: 'sk-ant-', url: 'https://console.anthropic.com/settings/keys' },
  { id: 'openai', label: 'OpenAI', env: 'OPENAI_API_KEY', prefix: 'sk-', url: 'https://platform.openai.com/api-keys' },
  { id: 'google', label: 'Google Gemini', env: 'GOOGLE_GENERATIVE_AI_API_KEY', prefix: '', url: 'https://aistudio.google.com/apikey' },
  { id: 'openrouter', label: 'OpenRouter', env: 'OPENROUTER_API_KEY', prefix: 'sk-or-', url: 'https://openrouter.ai/keys' },
  // OpenAI-compatible endpoint at https://integrate.api.nvidia.com/v1 (NIM / build.nvidia.com).
  { id: 'nvidia', label: 'NVIDIA NIM', env: 'NVIDIA_API_KEY', prefix: 'nvapi-', url: 'https://build.nvidia.com/settings/api-keys' },
] as const;

export type SecretId = (typeof SECRETS)[number]['id'];

export interface SecretStatus {
  id: SecretId;
  /** Stored in the OS keychain-backed store. */
  stored: boolean;
  /** Present in the environment the app was launched with (used when nothing is stored). */
  fromEnv: boolean;
  /** Last 4 characters, for recognition only. */
  hint: string | null;
  updatedAt: string | null;
}

