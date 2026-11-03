import { contextBridge, ipcRenderer } from 'electron';
import type { ReviewerDesktop, UpdateState } from '../shared/platform.js';
const adapter: ReviewerDesktop = Object.freeze({
  platform: 'desktop',
  chooseDirectory: () => ipcRenderer.invoke('reviewer:choose-directory'),
  updates: Object.freeze({
    state: () => ipcRenderer.invoke('reviewer:update-state'),
    check: () => ipcRenderer.invoke('reviewer:update-check'),
    install: () => ipcRenderer.invoke('reviewer:update-install'),
    subscribe: (listener: (state: UpdateState) => void) => {
      const handler = (_event: unknown, state: UpdateState) => listener(state);
      ipcRenderer.on('reviewer:update-changed', handler);
      return () => void ipcRenderer.removeListener('reviewer:update-changed', handler);
    },
  }),
});
contextBridge.exposeInMainWorld('reviewerDesktop', adapter);
