import type { AosBridge } from '../shared/ipc';

declare global {
  interface Window {
    aos: AosBridge;
  }
}

export {};
