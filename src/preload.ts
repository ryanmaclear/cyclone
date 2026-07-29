import { contextBridge, ipcRenderer } from 'electron';
import {
  IArtifactPreviewRequest,
  IMarlinStatus,
  IPreviewRequest,
  ISaveArtifactsRequest,
  ISerialConnectRequest
} from './app-types';

contextBridge.exposeInMainWorld('cyclone', {
  generatePreview: (request: IPreviewRequest) => ipcRenderer.invoke('recipe:generate-preview', request),
  generateArtifactPreview: (request: IArtifactPreviewRequest) => ipcRenderer.invoke('artifact:generate-preview', request),
  chooseBasePath: () => ipcRenderer.invoke('recipe:choose-base-path'),
  saveArtifacts: (request: ISaveArtifactsRequest) => ipcRenderer.invoke('recipe:save-artifacts', request),
  listSerialPorts: () => ipcRenderer.invoke('serial:list-ports'),
  connectSerial: (request: ISerialConnectRequest) => ipcRenderer.invoke('serial:connect', request),
  disconnectSerial: () => ipcRenderer.invoke('serial:disconnect'),
  runGCode: (commands: string[]) => ipcRenderer.invoke('serial:run-gcode', commands),
  pauseMachine: () => ipcRenderer.invoke('serial:pause'),
  resumeMachine: () => ipcRenderer.invoke('serial:resume'),
  clearMachineQueue: () => ipcRenderer.invoke('serial:clear-queue'),
  onSerialStatus: (callback: (status: IMarlinStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: IMarlinStatus) => callback(status);
    ipcRenderer.on('serial:status', listener);
    return () => ipcRenderer.off('serial:status', listener);
  },
  onSerialLog: (callback: (message: string) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on('serial:log', listener);
    return () => ipcRenderer.off('serial:log', listener);
  }
});
