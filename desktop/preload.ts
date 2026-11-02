import { contextBridge, ipcRenderer } from 'electron';
import type { ReviewerDesktop } from '../shared/platform.js';
const adapter: ReviewerDesktop = Object.freeze({
  platform: 'desktop',
  chooseDirectory: () => ipcRenderer.invoke('reviewer:choose-directory'),
});
contextBridge.exposeInMainWorld('reviewerDesktop', adapter);
