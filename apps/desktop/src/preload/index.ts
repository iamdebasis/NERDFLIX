import { contextBridge, ipcRenderer } from 'electron';
import type {
  BrowseData,
  LibraryApi,
  LibraryCard,
  PlaybackApi,
  TrackInfo,
} from '../shared/types.js';

/**
 * The only bridge between renderer and disk. Per ARCHITECTURE.md §4 the renderer
 * never touches fs, path, or child_process — everything crosses here, typed.
 */
const api: LibraryApi = {
  list: () => ipcRenderer.invoke('libraries:list') as Promise<LibraryCard[]>,
  add: () => ipcRenderer.invoke('libraries:add') as Promise<string | null>,
  remove: (id) => ipcRenderer.invoke('libraries:remove', id) as Promise<boolean>,
  reveal: (path) => ipcRenderer.invoke('libraries:reveal', path) as Promise<void>,
  scan: (volumeId, prune) => ipcRenderer.invoke('libraries:scan', volumeId, prune),
  enrich: () => ipcRenderer.invoke('libraries:enrich'),
  setToken: (token) => ipcRenderer.invoke('libraries:setToken', token) as Promise<boolean>,
  hasToken: () => ipcRenderer.invoke('libraries:hasToken') as Promise<boolean>,
  onEnrichProgress: (cb) => {
    const handler = (_e: unknown, p: unknown) => cb(p as never);
    ipcRenderer.on('libraries:enrichProgress', handler);
    return () => ipcRenderer.off('libraries:enrichProgress', handler);
  },
  onScanProgress: (cb) => {
    const handler = (_e: unknown, p: unknown) => cb(p as never);
    ipcRenderer.on('libraries:scanProgress', handler);
    return () => ipcRenderer.off('libraries:scanProgress', handler);
  },
  browse: (volumeId) => ipcRenderer.invoke('library:browse', volumeId) as Promise<BrowseData>,
  toggleMyList: (titleId) => ipcRenderer.invoke('library:toggleMyList', titleId) as Promise<boolean>,
  onChanged: (cb) => {
    const handler = () => cb();
    ipcRenderer.on('libraries:changed', handler);
    return () => ipcRenderer.off('libraries:changed', handler);
  },
};

const playback: PlaybackApi = {
  play: (titleId, opts) =>
    ipcRenderer.invoke('library:play', titleId, opts) as Promise<{ ok: boolean }>,
  stop: () => ipcRenderer.invoke('library:stop') as Promise<void>,
  tracks: (titleId, versionIndex) =>
    ipcRenderer.invoke('library:tracks', titleId, versionIndex) as Promise<TrackInfo>,
};

contextBridge.exposeInMainWorld('libraries', api);
contextBridge.exposeInMainWorld('playback', playback);
