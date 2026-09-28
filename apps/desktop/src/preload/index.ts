import { contextBridge, ipcRenderer } from 'electron';
import { EVENT_CHANNELS, INVOKE_CHANNELS, type AosBridge, type AosEvents } from '@shared/ipc';

// Build `window.aos` from the channel list so the surface can't drift from the contract.
const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {};
for (const [ns, methods] of Object.entries(INVOKE_CHANNELS)) {
  api[ns] = {};
  for (const m of methods) api[ns][m] = (...args) => ipcRenderer.invoke(`${ns}:${m}`, ...args);
}

const allowed = new Set<string>(EVENT_CHANNELS);

const bridge = {
  ...api,
  on<E extends keyof AosEvents>(event: E, cb: (payload: AosEvents[E]) => void) {
    if (!allowed.has(event)) throw new Error(`unknown event ${event}`);
    const listener = (_e: unknown, payload: AosEvents[E]) => cb(payload);
    ipcRenderer.on(event, listener);
    return () => void ipcRenderer.removeListener(event, listener);
  },
} as unknown as AosBridge;

contextBridge.exposeInMainWorld('aos', bridge);
