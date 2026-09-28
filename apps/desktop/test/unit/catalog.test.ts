import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultSettings } from '@shared/settings';
import type { RuntimeCatalog } from '@shared/agents';
import { Accounts } from '../../src/main/accounts';
import { Catalog } from '../../src/main/agents/catalog';
import { route } from '../../src/main/agents/router';
import { openDb } from '../../src/main/store/db';
import { insecureDevEncryptor, SecretStore } from '../../src/main/store/secrets';
import { SettingsStore } from '../../src/main/store/settings';

const noClis = new Accounts(async () => ({ ok: false, out: '' }), async () => null);

function setup() {
  const db = openDb(':memory:');
  const settings = new SettingsStore(db, defaultSettings('/h'));
  const secrets = new SecretStore(db, insecureDevEncryptor, {});
  const catalog = new Catalog({ db, accounts: noClis, secrets, settings, scratchDir: '/tmp' });
  return { db, secrets, catalog };
}

let nimModels = ['nvidia/nemotron-3-super-120b-a12b', 'nvidia/nemotron-3.5-lightning-30b-a3b', 'nvidia/nemotron-4-340b-reward'];
const fetchMock = vi.fn(async (url: string) => {
  if (!url.startsWith('https://integrate.api.nvidia.com')) throw new Error('offline');
  return new Response(JSON.stringify({ data: nimModels.map((id) => ({ id })) }));
});

afterEach(() => vi.unstubAllGlobals());

describe('catalog auto-update', () => {
  it('adding an NVIDIA key makes its models appear and routable, reward models excluded', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const { secrets, catalog } = setup();
    const before = await catalog.list();
    expect(before.find((c) => c.runtime === 'nvidia')).toMatchObject({ available: false });

    const pushed: RuntimeCatalog[][] = [];
    catalog.onChange((l) => pushed.push(l));
    secrets.set('nvidia', 'nvapi-test-key-123');
    catalog.invalidate(['nvidia']);
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    const nvidia = pushed[0].find((c) => c.runtime === 'nvidia')!;
    expect(nvidia.available).toBe(true);
    expect(nvidia.models.map((m) => m.id)).not.toContain('nvidia/nemotron-4-340b-reward');
    expect(route('plan', pushed[0])).toMatchObject({ runtime: 'nvidia', model: 'nvidia/nemotron-3-super-120b-a12b' });
  });

  it('a stale list is served instantly, refreshed in the background, and new models are pushed', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const { db, secrets, catalog } = setup();
    secrets.set('nvidia', 'nvapi-test-key-123');
    await catalog.list();
    db.prepare('UPDATE catalog SET updated_at = 0').run();
    nimModels = [...nimModels, 'nvidia/nemotron-4-ultra-1000b-a90b'];

    const pushed: RuntimeCatalog[][] = [];
    catalog.onChange((l) => pushed.push(l));
    const served = await catalog.list();
    expect(served.find((c) => c.runtime === 'nvidia')!.models).toHaveLength(2);
    await vi.waitFor(() => expect(pushed.length).toBe(1));
    expect(route('plan', pushed[0])).toMatchObject({ model: 'nvidia/nemotron-4-ultra-1000b-a90b' });
  });
});

describe('blocked models', () => {
  it('a model refused by the provider disappears from the catalog and routing', async () => {
    vi.stubGlobal('fetch', fetchMock);
    const { secrets, catalog } = setup();
    secrets.set('nvidia', 'nvapi-test-key-123');
    const first = await catalog.list();
    const top = route('plan', first)!;
    catalog.block('nvidia', top.model, "Function 'x': Not found for account 'y'");
    const next = await catalog.list();
    expect(next.find((c) => c.runtime === 'nvidia')!.models.map((m) => m.id)).not.toContain(top.model);
    expect(route('plan', next)?.model).not.toBe(top.model);
  });
});
