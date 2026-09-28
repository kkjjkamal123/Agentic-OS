// Agents use subscriptions only by running the vendor's CLI; the OS never touches its OAuth tokens.
export const ACCOUNTS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    vendor: 'Anthropic',
    covers: 'Claude Pro / Max / Team',
    bin: 'claude',
    login: 'claude auth login',
    install: 'curl -fsSL https://claude.ai/install.sh | bash',
  },
  {
    id: 'codex',
    label: 'Codex',
    vendor: 'OpenAI',
    covers: 'ChatGPT Plus / Pro / Business',
    bin: 'codex',
    login: 'codex login',
    install: 'npm install -g @openai/codex',
  },
  {
    id: 'omp',
    label: 'omp',
    vendor: 'oh-my-pi',
    covers: 'Any provider omp is signed in to (Antigravity, Anthropic, OpenAI…)',
    bin: 'omp',
    login: 'omp login',
    install: 'brew install omp',
  },
  {
    id: 'antigravity',
    label: 'Antigravity CLI',
    vendor: 'Google',
    covers: 'Google AI Pro / Ultra (Gemini)',
    bin: 'agy',
    login: 'agy',
    install: 'brew install --cask antigravity-cli',
  },
] as const;

export type AccountId = (typeof ACCOUNTS)[number]['id'];

export interface AccountStatus {
  id: AccountId;
  installed: boolean;
  signedIn: boolean | null;
  plan: string | null;
  version: string | null;
  error?: string;
}
