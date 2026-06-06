import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import * as path from 'path';
import { promises as fs } from 'fs';
import { Readable } from 'stream';
import { SerialPort } from 'serialport';
import { MarlinPort } from './marlin-port';
import { planWindDetailed } from './planner';
import { plotGCode } from './plotter';
import { generateTubeRecipe } from './recipe';
import {
  IMarlinStatus,
  IPreviewRequest,
  IPreviewResult,
  ISaveArtifactsRequest,
  ISerialConnectRequest,
  ISerialPortOption
} from './app-types';

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

let mainWindow: BrowserWindow | null = null;
let marlin: MarlinPort | null = null;

const disconnectedStatus: IMarlinStatus = {
  connected: false,
  paused: false,
  pausing: false,
  resuming: false,
  stopping: false,
  queuedCommands: 0,
  totalCommands: 0,
  sentCommands: 0,
  portPath: null
};

function createWindow() {
  mainWindow = new BrowserWindow({
    height: 760,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
    width: 1180,
  });

  mainWindow.webContents.on('console-message', (_event, _level, message) => {
    console.log(`Renderer: ${message}`);
  });
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.log(`Renderer failed to load ${errorCode}: ${errorDescription}`);
  });

  mainWindow.loadFile(path.join(__dirname, '../../index.html'));
}

ipcMain.handle('recipe:generate-preview', async (_event, request: IPreviewRequest): Promise<IPreviewResult> => {
  console.log('Generating recipe preview...');
  const recipe = generateTubeRecipe(request.recipeInput);
  const plan = planWindDetailed(recipe.windParameters, false, false);
  const plotStream = plotGCode(plan.gcode);
  const plotDataUrl = plotStream ? `data:image/png;base64,${(await streamToBuffer(plotStream)).toString('base64')}` : null;
  console.log(`Generated ${plan.gcode.length} G-code lines.`);

  return {
    recipe,
    plan,
    plotDataUrl
  };
});

ipcMain.handle('recipe:choose-base-path', async () => {
  const result = await dialog.showSaveDialog({
    title: 'Save winding artifacts',
    defaultPath: 'tube.wind',
    filters: [
      { name: 'Cyclone wind file', extensions: ['wind'] }
    ]
  });

  return result.canceled || !result.filePath ? null : result.filePath;
});

ipcMain.handle('recipe:save-artifacts', async (_event, request: ISaveArtifactsRequest) => {
  const basePath = getArtifactBasePath(request.basePath);
  const windPath = `${basePath}.wind`;
  const gcodePath = `${basePath}.gcode`;
  const plotPath = request.plotPngBase64 ? `${basePath}.png` : undefined;

  await fs.writeFile(windPath, JSON.stringify(request.windParameters, null, 2));
  await fs.writeFile(gcodePath, request.gcode.join('\n'));

  if (plotPath && request.plotPngBase64) {
    await fs.writeFile(plotPath, Buffer.from(request.plotPngBase64, 'base64'));
  }

  return {
    windPath,
    gcodePath,
    plotPath
  };
});

ipcMain.handle('serial:list-ports', async (): Promise<ISerialPortOption[]> => {
  const ports = await SerialPort.list();
  return ports.map((port) => ({
    path: port.path,
    manufacturer: port.manufacturer,
    serialNumber: port.serialNumber
  }));
});

ipcMain.handle('serial:connect', async (_event, request: ISerialConnectRequest) => {
  if (marlin) {
    await marlin.disconnect();
  }

  marlin = new MarlinPort(request.path, false, request.baudRate, {
    onStatus: sendSerialStatus,
    onLog: sendSerialLog
  });
  await marlin.initialize();
  return marlin.getStatus();
});

ipcMain.handle('serial:disconnect', async () => {
  if (!marlin) {
    return disconnectedStatus;
  }

  await marlin.disconnect();
  marlin = null;
  sendSerialStatus(disconnectedStatus);
  return disconnectedStatus;
});

ipcMain.handle('serial:run-gcode', async (_event, commands: string[]) => {
  if (!marlin) {
    throw new Error('Connect to a serial port before running G-code.');
  }
  marlin.queueCommands(commands);
  return marlin.getStatus();
});

ipcMain.handle('serial:pause', async () => {
  if (!marlin) {
    throw new Error('Connect to a serial port before pausing.');
  }
  marlin.pause();
  return marlin.getStatus();
});

ipcMain.handle('serial:resume', async () => {
  if (!marlin) {
    throw new Error('Connect to a serial port before resuming.');
  }
  marlin.resume();
  return marlin.getStatus();
});

ipcMain.handle('serial:clear-queue', async () => {
  if (!marlin) {
    return disconnectedStatus;
  }
  marlin.clearQueue();
  return marlin.getStatus();
});

app.on('ready', () => {
  createWindow();

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

function sendSerialStatus(status: IMarlinStatus): void {
  if (mainWindow) {
    mainWindow.webContents.send('serial:status', status);
  }
}

function sendSerialLog(message: string): void {
  if (mainWindow) {
    mainWindow.webContents.send('serial:log', message);
  }
}

function getArtifactBasePath(filePath: string): string {
  const parsedPath = path.parse(filePath);
  const extension = parsedPath.ext.toLowerCase();
  if (extension === '.wind' || extension === '.gcode' || extension === '.png') {
    return path.join(parsedPath.dir, parsedPath.name);
  }
  return filePath;
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}
