import { ExternalLink, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ACCOUNTS, type AccountStatus } from '@shared/accounts';
import { SECRETS, type SecretId, type SecretStatus } from '@shared/secrets';
import { Badge, Button, Field, Input, Section } from '../../components/ui';
import { ipcError } from '../../lib/settings';
import { CommitInput } from './sections';

function KeyRow({ def, status, onChange }: {
  def: (typeof SECRETS)[number];
  status: SecretStatus;
  onChange: (s: SecretStatus) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onChange(await window.aos.secrets.set(def.id, value));
      setValue('');
      setEditing(false);
    } catch (e) {
      setError(ipcError(e));
    } finally {
      setBusy(false);
    }
  };

  const looksWrong = value.length > 0 && def.prefix && !value.trim().startsWith(def.prefix);

  return (
    <Field
      label={def.label}
      hint={
        <button className="inline-flex items-center gap-1 hover:text-accent" onClick={() => void window.aos.system.openExternal(def.url)}>
          Get a key <ExternalLink size={11} />
        </button>
      }
    >
      {editing ? (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            autoFocus
            type="password"
            aria-label={`${def.label} API key`}
            placeholder={def.prefix ? `${def.prefix}…` : 'Paste key'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setEditing(false)}
            className="font-mono text-xs"
          />
          <Button variant="primary" type="submit" disabled={busy || value.trim().length < 8}>
            Save
          </Button>
          <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </form>
      ) : (
        <div className="flex h-8 items-center gap-2">
          {status.stored ? (
            <Badge tone="success">Stored ···· {status.hint}</Badge>
          ) : status.fromEnv ? (
            <Badge tone="accent">From environment (${def.env})</Badge>
          ) : (
            <Badge>Not set</Badge>
          )}
          <div className="ml-auto flex gap-1">
            <Button onClick={() => setEditing(true)}>{status.stored ? 'Replace' : 'Add key'}</Button>
            {status.stored && (
              <Button variant="danger" onClick={async () => onChange(await window.aos.secrets.remove(def.id))}>
                Remove
              </Button>
            )}
          </div>
        </div>
      )}
      {looksWrong && <div className="mt-1.5 text-xs text-warning">{def.label} keys usually start with “{def.prefix}”.</div>}
      {error && <div className="mt-1.5 text-xs text-danger">{error}</div>}
    </Field>
  );
}

function AccountCard({ def, status }: { def: (typeof ACCOUNTS)[number]; status: AccountStatus | undefined }) {
  const badge = !status ? (
    <Badge>Checking…</Badge>
  ) : !status.installed ? (
    <Badge>Not installed</Badge>
  ) : status.signedIn ? (
    <Badge tone="success">Signed in{status.plan ? ` · ${status.plan}` : ''}</Badge>
  ) : status.signedIn === false ? (
    <Badge tone="warning">Not signed in</Badge>
  ) : (
    <Badge tone="accent">Installed</Badge>
  );
  const action = status && !status.installed ? 'install' : status && status.signedIn === false ? 'login' : null;
  return (
    <div className="flex items-start gap-3 py-3.5" data-account={def.id}>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
          {def.label}
          <span className="text-xs font-normal text-faint">{def.vendor}{status?.version ? ` · v${status.version}` : ''}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted">{def.covers}</div>
        <div className="mt-1.5">{badge}</div>
      </div>
      {action && (
        <Button onClick={() => void window.aos.accounts.openTerminal(def.id, action)} title={action === 'install' ? def.install : def.login}>
          {action === 'install' ? 'Install…' : 'Sign in…'}
        </Button>
      )}
    </div>
  );
}

function SubscriptionsSection() {
  const [statuses, setStatuses] = useState<AccountStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = async (refresh = false) => {
    setBusy(true);
    try {
      setStatuses(await window.aos.accounts.list(refresh));
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    return window.aos.on('accounts:changed', setStatuses);
  }, []);
  const signedIn = statuses?.filter((s) => s.signedIn).length ?? 0;
  return (
    <section className="mb-8">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold text-fg">Subscriptions</h2>
        {statuses && <Badge tone={signedIn ? 'success' : 'neutral'}>{signedIn} active</Badge>}
        <Button variant="ghost" className="ml-auto" onClick={() => void load(true)} disabled={busy} aria-label="Re-check subscriptions">
          <RefreshCw size={14} className={busy ? 'animate-spin' : ''} /> Re-check
        </Button>
      </div>
      <p className="mt-1 max-w-prose text-[13px] text-muted">
        Agents run through each vendor's official CLI, so they use the plan you're already signed in to, with no API key needed.
        Signing in happens in the CLI itself. The OS never reads or copies those login tokens.
      </p>
      <div className="mt-3 divide-y divide-line border-t border-line">
        {ACCOUNTS.map((d) => (
          <AccountCard key={d.id} def={d} status={statuses?.find((s) => s.id === d.id)} />
        ))}
      </div>
    </section>
  );
}

export function ProvidersSection() {
  const [statuses, setStatuses] = useState<SecretStatus[] | null>(null);
  useEffect(() => void window.aos.secrets.list().then(setStatuses), []);
  const put = (s: SecretStatus) => setStatuses((prev) => prev!.map((x) => (x.id === s.id ? s : x)));
  const byId = (id: SecretId) => statuses?.find((s) => s.id === id);

  return (
    <>
      <SubscriptionsSection />
      <Section
        title="API keys"
        description="For pay-as-you-go models, including NVIDIA NIM. Keys are encrypted with your macOS Keychain and never leave the main process, and the interface can't read them back."
      >
        {statuses && SECRETS.map((d) => <KeyRow key={d.id} def={d} status={byId(d.id)!} onChange={put} />)}
      </Section>
      <Section title="Local models" description="Ollama runs models on this Mac for free. Install it from ollama.com and pull a model.">
        <Field label="Ollama server">
          <CommitInput k="ollamaBaseUrl" label="Ollama server URL" className="font-mono text-xs" />
        </Field>
      </Section>
    </>
  );
}
