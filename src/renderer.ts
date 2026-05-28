type IMarlinStatus = import('./app-types').IMarlinStatus;
type IPreviewResult = import('./app-types').IPreviewResult;
type ISaveArtifactsResult = import('./app-types').ISaveArtifactsResult;
type ISerialPortOption = import('./app-types').ISerialPortOption;
type ITubeRecipeInput = import('./recipe').ITubeRecipeInput;
type TStrengthPreset = import('./recipe').TStrengthPreset;

let currentPreview: IPreviewResult | null = null;
let currentStatus: IMarlinStatus = {
    connected: false,
    paused: false,
    pausing: false,
    resuming: false,
    queuedCommands: 0,
    totalCommands: 0,
    sentCommands: 0,
    portPath: null
};

window.addEventListener('DOMContentLoaded', () => {
    if (!window.cyclone) {
        setRecipeMessage('Electron preload API did not load. Rebuild and restart the app.');
        return;
    }

    try {
        bindEvents();
        refreshPorts();
        updateRunControls();

        window.cyclone.onSerialStatus((status) => {
            currentStatus = status;
            renderMachineStatus();
            updateRunControls();
        });

        window.cyclone.onSerialLog((message) => appendSerialLog(message));
    } catch (error) {
        setRecipeMessage(getErrorMessage(error));
        console.error(error);
    }
});

function bindEvents(): void {
    byId<HTMLButtonElement>('generate').addEventListener('click', generatePreview);
    byId<HTMLButtonElement>('save').addEventListener('click', saveArtifacts);
    byId<HTMLButtonElement>('refresh-ports').addEventListener('click', refreshPorts);
    byId<HTMLButtonElement>('connect').addEventListener('click', connectSerial);
    byId<HTMLButtonElement>('disconnect').addEventListener('click', disconnectSerial);
    byId<HTMLButtonElement>('run').addEventListener('click', runGCode);
    byId<HTMLButtonElement>('pause').addEventListener('click', pauseMachine);
    byId<HTMLButtonElement>('resume').addEventListener('click', resumeMachine);
    byId<HTMLButtonElement>('clear-queue').addEventListener('click', clearQueue);
    byId<HTMLInputElement>('arm-run').addEventListener('change', updateRunControls);
}

async function generatePreview(): Promise<void> {
    setRecipeMessage('Generating preview...');
    setArtifactPaths(null);
    byId<HTMLInputElement>('arm-run').checked = false;
    byId<HTMLButtonElement>('generate').disabled = true;

    try {
        const preview = await window.cyclone.generatePreview({ recipeInput: readRecipeInput() });
        currentPreview = preview;
        renderPreview(preview);
        byId<HTMLButtonElement>('save').disabled = false;
        byId<HTMLInputElement>('arm-run').disabled = false;
        updateRunControls();
        setRecipeMessage('Preview generated.');
    } catch (error) {
        currentPreview = null;
        renderPreview(null);
        byId<HTMLButtonElement>('save').disabled = true;
        byId<HTMLInputElement>('arm-run').disabled = true;
        updateRunControls();
        setRecipeMessage(getErrorMessage(error));
        console.error(error);
    } finally {
        byId<HTMLButtonElement>('generate').disabled = false;
    }
}

async function saveArtifacts(): Promise<void> {
    if (!currentPreview) {
        return;
    }

    const basePath = await window.cyclone.chooseBasePath();
    if (!basePath) {
        return;
    }

    try {
        const result = await window.cyclone.saveArtifacts({
            basePath,
            windParameters: currentPreview.recipe.windParameters,
            gcode: currentPreview.plan.gcode,
            plotPngBase64: getPlotBase64(currentPreview.plotDataUrl)
        });
        setArtifactPaths(result);
        setRecipeMessage('Artifacts saved.');
    } catch (error) {
        setRecipeMessage(getErrorMessage(error));
    }
}

async function refreshPorts(): Promise<void> {
    const select = byId<HTMLSelectElement>('serial-port');
    select.innerHTML = '';

    try {
        const ports = await window.cyclone.listSerialPorts();
        if (ports.length === 0) {
            const option = document.createElement('option');
            option.value = '';
            option.textContent = 'No serial ports';
            select.appendChild(option);
            return;
        }

        for (const port of ports) {
            select.appendChild(createPortOption(port));
        }
    } catch (error) {
        setMachineMessage(getErrorMessage(error));
    }
}

async function connectSerial(): Promise<void> {
    const portPath = byId<HTMLSelectElement>('serial-port').value;
    if (!portPath) {
        setMachineMessage('Select a serial port.');
        return;
    }

    try {
        currentStatus = await window.cyclone.connectSerial({
            path: portPath,
            baudRate: readNumber('baud-rate')
        });
        renderMachineStatus();
        updateRunControls();
        setMachineMessage('Connected.');
    } catch (error) {
        setMachineMessage(getErrorMessage(error));
    }
}

async function disconnectSerial(): Promise<void> {
    currentStatus = await window.cyclone.disconnectSerial();
    renderMachineStatus();
    updateRunControls();
    setMachineMessage('Disconnected.');
}

async function runGCode(): Promise<void> {
    if (!currentPreview || !byId<HTMLInputElement>('arm-run').checked) {
        return;
    }

    try {
        currentStatus = await window.cyclone.runGCode(currentPreview.plan.gcode);
        byId<HTMLInputElement>('arm-run').checked = false;
        renderMachineStatus();
        updateRunControls();
        setMachineMessage('Run queued.');
    } catch (error) {
        setMachineMessage(getErrorMessage(error));
    }
}

async function pauseMachine(): Promise<void> {
    currentStatus = await window.cyclone.pauseMachine();
    renderMachineStatus();
    updateRunControls();
}

async function resumeMachine(): Promise<void> {
    currentStatus = await window.cyclone.resumeMachine();
    renderMachineStatus();
    updateRunControls();
}

async function clearQueue(): Promise<void> {
    currentStatus = await window.cyclone.clearMachineQueue();
    renderMachineStatus();
    updateRunControls();
}

function readRecipeInput(): ITubeRecipeInput {
    const layerCount = readNumber('layer-count');
    return {
        diameter: readNumber('diameter'),
        windLength: readNumber('wind-length'),
        windAngle: readNumber('wind-angle'),
        strengthPreset: byId<HTMLSelectElement>('strength').value as TStrengthPreset,
        layerCount: Number.isFinite(layerCount) ? layerCount : undefined,
        towWidth: readNumber('tow-width'),
        towThickness: readNumber('tow-thickness'),
        defaultFeedRate: readNumber('feed-rate'),
        lockDegrees: readNumber('lock-degrees'),
        leadInMM: readNumber('lead-in'),
        leadOutDegrees: readNumber('lead-out')
    };
}

function renderPreview(preview: IPreviewResult | null): void {
    const plotFrame = byId<HTMLDivElement>('plot-frame');
    const summary = byId<HTMLDivElement>('summary');
    const warnings = byId<HTMLUListElement>('warnings');

    plotFrame.innerHTML = '';
    summary.innerHTML = '';
    warnings.innerHTML = '';

    if (!preview) {
        const empty = document.createElement('span');
        empty.className = 'empty-preview';
        empty.textContent = 'No preview generated';
        plotFrame.appendChild(empty);
        return;
    }

    if (preview.plotDataUrl) {
        const image = document.createElement('img');
        image.src = preview.plotDataUrl;
        image.alt = 'Winding plot preview';
        plotFrame.appendChild(image);
    }

    addMetric(summary, 'Layers', preview.recipe.summary.requestedLayerCount.toString());
    addMetric(summary, 'Helical', preview.recipe.summary.helicalLayerCount.toString());
    addMetric(summary, 'Hoop', preview.recipe.summary.hoopLayerCount.toString());
    addMetric(summary, 'Pattern', preview.recipe.summary.patternNumber.toString());
    addMetric(summary, 'Circuits', preview.recipe.summary.numCircuits.toString());
    addMetric(summary, 'G-code lines', preview.plan.gcode.length.toString());
    addMetric(summary, 'Time', `${Math.round(preview.plan.totalTimeS)} s`);
    addMetric(summary, 'Tow', `${preview.plan.totalTowUseM.toFixed(2)} m`);

    for (const warning of preview.recipe.warnings) {
        const item = document.createElement('li');
        item.textContent = warning;
        warnings.appendChild(item);
    }
}

function renderMachineStatus(): void {
    const status = byId<HTMLSpanElement>('machine-status');
    if (!currentStatus.connected) {
        status.textContent = 'Disconnected';
        return;
    }

    const progress = currentStatus.totalCommands === 0 ? '0/0' : `${currentStatus.sentCommands}/${currentStatus.totalCommands}`;
    status.textContent = `${currentStatus.portPath || 'Connected'} ${progress}`;
}

function updateRunControls(): void {
    const connected = currentStatus.connected;
    const hasPreview = currentPreview !== null;
    const armed = byId<HTMLInputElement>('arm-run').checked;

    byId<HTMLButtonElement>('connect').disabled = connected;
    byId<HTMLButtonElement>('disconnect').disabled = !connected;
    byId<HTMLButtonElement>('run').disabled = !connected || !hasPreview || !armed;
    byId<HTMLButtonElement>('pause').disabled = !connected || currentStatus.paused || currentStatus.pausing;
    byId<HTMLButtonElement>('resume').disabled = !connected || (!currentStatus.paused && !currentStatus.pausing);
    byId<HTMLButtonElement>('clear-queue').disabled = !connected;
}

function addMetric(container: HTMLElement, label: string, value: string): void {
    const row = document.createElement('div');
    row.className = 'metric';

    const labelElement = document.createElement('span');
    labelElement.textContent = label;

    const valueElement = document.createElement('strong');
    valueElement.textContent = value;

    row.appendChild(labelElement);
    row.appendChild(valueElement);
    container.appendChild(row);
}

function createPortOption(port: ISerialPortOption): HTMLOptionElement {
    const option = document.createElement('option');
    option.value = port.path;
    option.textContent = port.manufacturer ? `${port.path} - ${port.manufacturer}` : port.path;
    return option;
}

function setRecipeMessage(message: string): void {
    byId<HTMLDivElement>('recipe-message').textContent = message;
}

function setMachineMessage(message: string): void {
    byId<HTMLDivElement>('machine-message').textContent = message;
}

function setArtifactPaths(result: ISaveArtifactsResult | null): void {
    const paths = byId<HTMLPreElement>('paths');
    paths.textContent = result ? [result.windPath, result.gcodePath, result.plotPath].filter(Boolean).join('\n') : '';
}

function appendSerialLog(message: string): void {
    const log = byId<HTMLPreElement>('serial-log');
    log.textContent = `${log.textContent}${message}\n`;
    log.scrollTop = log.scrollHeight;
}

function getPlotBase64(plotDataUrl: string | null): string | null {
    if (!plotDataUrl) {
        return null;
    }
    return plotDataUrl.split(',')[1] || null;
}

function readNumber(id: string): number {
    return Number.parseFloat(byId<HTMLInputElement>(id).value);
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function byId<T extends HTMLElement>(id: string): T {
    const element = document.getElementById(id);
    if (!element) {
        throw new Error(`Missing element ${id}`);
    }
    return element as T;
}
