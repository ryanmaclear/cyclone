type IMarlinStatus = import('./app-types').IMarlinStatus;
type IPreviewResult = import('./app-types').IPreviewResult;
type IPreviewSegment = import('./planner/types').IPreviewSegment;
type ISaveArtifactsResult = import('./app-types').ISaveArtifactsResult;
type ISerialPortOption = import('./app-types').ISerialPortOption;
type TLayerParameters = import('./planner/types').TLayerParameters;
type ITubeRecipeInput = import('./recipe').ITubeRecipeInput;
type TStrengthPreset = import('./recipe').TStrengthPreset;

type TColorMode = 'layer' | 'circuit' | 'pass';

interface IPreviewView {
    scale: number;
    offsetX: number;
    offsetY: number;
    dragging: boolean;
    lastMouseX: number;
    lastMouseY: number;
    colorMode: TColorMode;
}

let currentPreview: IPreviewResult | null = null;
const visibleLayerIndexes = new Set<number>();
let hoveredLayerIndex: number | null = null;
let selectedLayerIndex: number | null = null;
const previewView: IPreviewView = {
    scale: 1,
    offsetX: 20,
    offsetY: 20,
    dragging: false,
    lastMouseX: 0,
    lastMouseY: 0,
    colorMode: 'layer'
};
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
    byId<HTMLButtonElement>('fit-preview').addEventListener('click', fitPreview);
    byId<HTMLButtonElement>('actual-size-preview').addEventListener('click', actualSizePreview);
    byId<HTMLButtonElement>('zoom-in-preview').addEventListener('click', () => zoomPreview(1.25));
    byId<HTMLButtonElement>('zoom-out-preview').addEventListener('click', () => zoomPreview(0.8));
    byId<HTMLButtonElement>('show-all-layers').addEventListener('click', showAllLayers);
    byId<HTMLSelectElement>('color-mode').addEventListener('change', () => {
        previewView.colorMode = byId<HTMLSelectElement>('color-mode').value as TColorMode;
        drawPreview();
    });
    bindCanvasEvents();
    window.addEventListener('resize', drawPreview);
}

async function generatePreview(): Promise<void> {
    setRecipeMessage('Generating preview...');
    setArtifactPaths(null);
    byId<HTMLInputElement>('arm-run').checked = false;
    byId<HTMLButtonElement>('generate').disabled = true;

    try {
        const preview = await window.cyclone.generatePreview({ recipeInput: readRecipeInput() });
        currentPreview = preview;
        resetLayerVisibility(preview);
        renderPreview(preview);
        byId<HTMLButtonElement>('save').disabled = false;
        byId<HTMLInputElement>('arm-run').disabled = false;
        updateRunControls();
        setRecipeMessage('Preview generated.');
    } catch (error) {
        currentPreview = null;
        visibleLayerIndexes.clear();
        hoveredLayerIndex = null;
        selectedLayerIndex = null;
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
    const summary = byId<HTMLDivElement>('summary');
    const warnings = byId<HTMLUListElement>('warnings');
    const layerTableBody = byId<HTMLTableSectionElement>('layer-table-body');

    summary.innerHTML = '';
    warnings.innerHTML = '';
    layerTableBody.innerHTML = '';

    if (!preview) {
        setPreviewControlsEnabled(false);
        byId<HTMLSpanElement>('empty-preview').style.display = 'block';
        hidePreviewTooltip();
        clearPreviewCanvas();
        return;
    }

    setPreviewControlsEnabled(true);
    byId<HTMLSpanElement>('empty-preview').style.display = 'none';
    fitPreview();
    renderLayerTable(preview);

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

function bindCanvasEvents(): void {
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    canvas.addEventListener('mousedown', (event) => {
        previewView.dragging = true;
        previewView.lastMouseX = event.clientX;
        previewView.lastMouseY = event.clientY;
        canvas.classList.add('dragging');
    });
    canvas.addEventListener('mouseup', () => endCanvasDrag());
    canvas.addEventListener('mouseleave', () => {
        endCanvasDrag();
        hidePreviewTooltip();
    });
    canvas.addEventListener('mousemove', (event) => {
        if (!previewView.dragging) {
            updatePreviewTooltip(event);
            return;
        }
        hidePreviewTooltip();
        previewView.offsetX += event.clientX - previewView.lastMouseX;
        previewView.offsetY += event.clientY - previewView.lastMouseY;
        previewView.lastMouseX = event.clientX;
        previewView.lastMouseY = event.clientY;
        drawPreview();
    });
    canvas.addEventListener('wheel', (event) => {
        if (!currentPreview) {
            return;
        }
        event.preventDefault();
        const rect = canvas.getBoundingClientRect();
        const factor = event.deltaY < 0 ? 1.15 : 0.87;
        zoomPreview(factor, event.clientX - rect.left, event.clientY - rect.top);
    }, {passive: false});
}

function endCanvasDrag(): void {
    previewView.dragging = false;
    byId<HTMLCanvasElement>('preview-canvas').classList.remove('dragging');
}

function fitPreview(): void {
    if (!currentPreview) {
        return;
    }
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const rect = canvas.getBoundingClientRect();
    const windLength = currentPreview.recipe.windParameters.mandrelParameters.windLength;
    const padding = 28;
    previewView.scale = Math.max(0.1, Math.min((rect.width - padding * 2) / windLength, (rect.height - padding * 2) / 360));
    previewView.offsetX = (rect.width - windLength * previewView.scale) / 2;
    previewView.offsetY = (rect.height - 360 * previewView.scale) / 2;
    drawPreview();
}

function actualSizePreview(): void {
    previewView.scale = 1;
    previewView.offsetX = 24;
    previewView.offsetY = 24;
    drawPreview();
}

function zoomPreview(factor: number, originX?: number, originY?: number): void {
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const rect = canvas.getBoundingClientRect();
    const x = typeof originX === 'number' ? originX : rect.width / 2;
    const y = typeof originY === 'number' ? originY : rect.height / 2;
    const worldX = (x - previewView.offsetX) / previewView.scale;
    const worldY = (y - previewView.offsetY) / previewView.scale;
    previewView.scale = Math.max(0.05, Math.min(40, previewView.scale * factor));
    previewView.offsetX = x - worldX * previewView.scale;
    previewView.offsetY = y - worldY * previewView.scale;
    drawPreview();
}

function drawPreview(): void {
    if (!currentPreview) {
        clearPreviewCanvas();
        return;
    }

    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const ctx = resizeCanvas(canvas);
    const rect = canvas.getBoundingClientRect();

    ctx.fillStyle = '#fbfbf8';
    ctx.fillRect(0, 0, rect.width, rect.height);
    drawPreviewGrid(ctx, rect.width, rect.height);

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const highlightedSegments: IPreviewSegment[] = [];
    for (const segment of currentPreview.plan.previewSegments) {
        if (!visibleLayerIndexes.has(segment.layerIndex)) {
            continue;
        }
        if (isLayerHighlighted(segment.layerIndex)) {
            highlightedSegments.push(segment);
            continue;
        }
        drawSegment(ctx, segment, false);
    }
    for (const segment of highlightedSegments) {
        drawSegment(ctx, segment, true);
    }
}

function drawPreviewGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const windLength = currentPreview ? currentPreview.recipe.windParameters.mandrelParameters.windLength : 0;
    ctx.strokeStyle = '#dde3d8';
    ctx.lineWidth = 1;
    for (const y of [0, 90, 180, 270, 360]) {
        const screenY = previewToScreenY(y);
        ctx.beginPath();
        ctx.moveTo(previewToScreenX(0), screenY);
        ctx.lineTo(previewToScreenX(windLength), screenY);
        ctx.stroke();
    }
    ctx.strokeStyle = '#c6cec1';
    ctx.strokeRect(previewToScreenX(0), previewToScreenY(0), windLength * previewView.scale, 360 * previewView.scale);
    ctx.fillStyle = '#68727a';
    ctx.font = '12px Arial';
    ctx.fillText('0 deg', Math.min(width - 42, previewToScreenX(0) + 6), Math.max(14, previewToScreenY(0) + 14));
    ctx.fillText('360 deg', Math.min(width - 54, previewToScreenX(0) + 6), Math.min(height - 6, previewToScreenY(360) - 6));
}

function drawSegment(ctx: CanvasRenderingContext2D, segment: IPreviewSegment, emphasized: boolean): void {
    ctx.strokeStyle = getSegmentColor(segment);
    ctx.globalAlpha = emphasized ? 1 : 0.62;
    ctx.lineWidth = Math.max(1.25, Math.min(8, previewView.scale * 0.9));

    for (const wrappedSegment of splitWrappedSegment(segment)) {
        ctx.beginPath();
        ctx.moveTo(previewToScreenX(wrappedSegment.start.x), previewToScreenY(wrappedSegment.start.y));
        ctx.lineTo(previewToScreenX(wrappedSegment.end.x), previewToScreenY(wrappedSegment.end.y));
        ctx.stroke();
    }
    ctx.globalAlpha = 1;
}

function splitWrappedSegment(segment: IPreviewSegment): Array<{start: {x: number; y: number}; end: {x: number; y: number}}> {
    const result: Array<{start: {x: number; y: number}; end: {x: number; y: number}}> = [];
    let start = {...segment.start};
    const end = {...segment.end};
    const direction = end.y >= start.y ? 1 : -1;
    let guard = 0;

    while (Math.floor(start.y / 360) !== Math.floor(end.y / 360) && guard < 1000) {
        let boundary = direction > 0 ? Math.ceil(start.y / 360) * 360 : Math.floor(start.y / 360) * 360;
        if (boundary === start.y) {
            boundary += direction * 360;
        }
        const t = (boundary - start.y) / (end.y - start.y);
        const boundaryX = start.x + (end.x - start.x) * t;
        result.push({
            start: {x: start.x, y: mod360(start.y)},
            end: {x: boundaryX, y: direction > 0 ? 360 : 0}
        });
        start = {
            x: boundaryX,
            y: boundary + direction * 0.001
        };
        guard += 1;
    }

    result.push({
        start: {x: start.x, y: mod360(start.y)},
        end: {x: end.x, y: mod360(end.y)}
    });
    return result;
}

function getSegmentColor(segment: IPreviewSegment): string {
    const palette = ['#1f77b4', '#d1495b', '#2e8b57', '#8a5b28', '#6f4aa8', '#2f6f73', '#c36f09', '#5c677d'];
    if (previewView.colorMode === 'circuit') {
        return palette[(segment.circuitIndex || 0) % palette.length];
    }
    if (previewView.colorMode === 'pass') {
        if (segment.groupKind === 'lock') {
            return '#6f421c';
        }
        return segment.passDirection === 'back' ? '#d1495b' : '#2f6f73';
    }
    return palette[segment.layerIndex % palette.length];
}

function clearPreviewCanvas(): void {
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const ctx = resizeCanvas(canvas);
    const rect = canvas.getBoundingClientRect();
    ctx.fillStyle = '#fbfbf8';
    ctx.fillRect(0, 0, rect.width, rect.height);
}

function resizeCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
    const rect = canvas.getBoundingClientRect();
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * ratio));
    const height = Math.max(1, Math.floor(rect.height * ratio));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Could not create preview canvas context.');
    }
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return ctx;
}

function previewToScreenX(x: number): number {
    return x * previewView.scale + previewView.offsetX;
}

function previewToScreenY(y: number): number {
    return y * previewView.scale + previewView.offsetY;
}

function mod360(value: number): number {
    const result = value % 360;
    return result < 0 ? result + 360 : result;
}

function setPreviewControlsEnabled(enabled: boolean): void {
    byId<HTMLButtonElement>('fit-preview').disabled = !enabled;
    byId<HTMLButtonElement>('actual-size-preview').disabled = !enabled;
    byId<HTMLButtonElement>('zoom-in-preview').disabled = !enabled;
    byId<HTMLButtonElement>('zoom-out-preview').disabled = !enabled;
    byId<HTMLButtonElement>('show-all-layers').disabled = !enabled;
    byId<HTMLSelectElement>('color-mode').disabled = !enabled;
}

function resetLayerVisibility(preview: IPreviewResult): void {
    visibleLayerIndexes.clear();
    hoveredLayerIndex = null;
    selectedLayerIndex = null;
    for (let index = 0; index < preview.recipe.windParameters.layers.length; index++) {
        visibleLayerIndexes.add(index);
    }
}

function showAllLayers(): void {
    if (!currentPreview) {
        return;
    }

    for (let index = 0; index < currentPreview.recipe.windParameters.layers.length; index++) {
        visibleLayerIndexes.add(index);
    }
    renderLayerTable(currentPreview);
    drawPreview();
}

function renderLayerTable(preview: IPreviewResult): void {
    const layerTableBody = byId<HTMLTableSectionElement>('layer-table-body');
    layerTableBody.innerHTML = '';

    preview.recipe.windParameters.layers.forEach((layer, index) => {
        const row = document.createElement('tr');
        if (selectedLayerIndex === index) {
            row.classList.add('selected');
        }
        row.addEventListener('mouseenter', () => {
            hoveredLayerIndex = index;
            drawPreview();
        });
        row.addEventListener('mouseleave', () => {
            hoveredLayerIndex = null;
            drawPreview();
        });
        row.addEventListener('click', () => {
            selectedLayerIndex = selectedLayerIndex === index ? null : index;
            renderLayerTable(preview);
            drawPreview();
        });

        const visibilityCell = document.createElement('td');
        visibilityCell.className = 'visibility-cell';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = visibleLayerIndexes.has(index);
        checkbox.addEventListener('click', (event) => event.stopPropagation());
        checkbox.addEventListener('change', () => {
            if (checkbox.checked) {
                visibleLayerIndexes.add(index);
            } else {
                visibleLayerIndexes.delete(index);
            }
            drawPreview();
        });
        visibilityCell.appendChild(checkbox);

        row.appendChild(visibilityCell);
        row.appendChild(createTextCell(`${index + 1}: ${layer.windType}`));
        row.appendChild(createTextCell(formatLayerParameters(layer)));
        row.appendChild(createTextCell(formatLayerFacts(preview, layer, index)));
        row.appendChild(createTextCell(formatLayerEstimate(preview, index)));
        layerTableBody.appendChild(row);
    });
}

function createTextCell(text: string): HTMLTableCellElement {
    const cell = document.createElement('td');
    cell.textContent = text;
    return cell;
}

function formatLayerParameters(layer: TLayerParameters): string {
    if (layer.windType === 'helical') {
        return `angle ${layer.windAngle} deg, pattern ${layer.patternNumber}, skip ${layer.skipIndex}, lock ${layer.lockDegrees} deg, lead-in ${layer.leadInMM} mm, lead-out ${layer.leadOutDegrees} deg`;
    }
    if (layer.windType === 'hoop') {
        return `terminal ${layer.terminal ? 'yes' : 'no'}`;
    }
    return `mandrel rotation ${layer.mandrelRotation} deg`;
}

function formatLayerFacts(preview: IPreviewResult, layer: TLayerParameters, index: number): string {
    const summary = preview.plan.layers.find((layerSummary) => layerSummary.layerIndex === index + 1);
    if (layer.windType === 'helical') {
        const circuitCount = summary && summary.circuitCount ? summary.circuitCount : preview.recipe.summary.numCircuits;
        return `${circuitCount} circuits, ${layer.patternNumber} starts, ${layer.skipInitialNearLock ? 'initial lock skipped' : 'initial lock included'}`;
    }
    if (layer.windType === 'hoop') {
        return 'Outer hoop reinforcement; uses fixed 180 deg end locks';
    }
    return 'Offsets the next layer start angle';
}

function formatLayerEstimate(preview: IPreviewResult, index: number): string {
    const summary = preview.plan.layers.find((layerSummary) => layerSummary.layerIndex === index + 1);
    if (!summary) {
        return 'not planned';
    }
    return `${Math.round(summary.timeS)} s, ${summary.towUseM.toFixed(2)} m tow`;
}

function isLayerHighlighted(layerIndex: number): boolean {
    return layerIndex === selectedLayerIndex || layerIndex === hoveredLayerIndex;
}

function updatePreviewTooltip(event: MouseEvent): void {
    if (!currentPreview) {
        hidePreviewTooltip();
        return;
    }

    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const rect = canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const segment = findNearestSegment(x, y);
    if (!segment) {
        hidePreviewTooltip();
        return;
    }

    const tooltip = byId<HTMLDivElement>('preview-tooltip');
    tooltip.style.display = 'block';
    const tooltipX = Math.max(0, Math.min(rect.width - 270, x + 12));
    const tooltipY = Math.max(0, Math.min(rect.height - 110, y + 12));
    tooltip.style.transform = `translate(${tooltipX}px, ${tooltipY}px)`;
    tooltip.textContent = formatSegmentTooltip(segment);
}

function hidePreviewTooltip(): void {
    byId<HTMLDivElement>('preview-tooltip').style.display = 'none';
}

function findNearestSegment(screenX: number, screenY: number): IPreviewSegment | null {
    if (!currentPreview) {
        return null;
    }

    let nearestSegment: IPreviewSegment | null = null;
    let nearestDistance = 10;
    for (const segment of currentPreview.plan.previewSegments) {
        if (!visibleLayerIndexes.has(segment.layerIndex)) {
            continue;
        }
        for (const wrappedSegment of splitWrappedSegment(segment)) {
            const distance = distanceToScreenSegment(
                screenX,
                screenY,
                previewToScreenX(wrappedSegment.start.x),
                previewToScreenY(wrappedSegment.start.y),
                previewToScreenX(wrappedSegment.end.x),
                previewToScreenY(wrappedSegment.end.y)
            );
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestSegment = segment;
            }
        }
    }
    return nearestSegment;
}

function distanceToScreenSegment(px: number, py: number, x1: number, y1: number, x2: number, y2: number): number {
    const dx = x2 - x1;
    const dy = y2 - y1;
    if (dx === 0 && dy === 0) {
        return Math.hypot(px - x1, py - y1);
    }
    const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function formatSegmentTooltip(segment: IPreviewSegment): string {
    const parts = [
        `Layer ${segment.layerIndex + 1} ${segment.layerType}`,
        segment.groupKind
    ];
    if (typeof segment.circuitIndex === 'number') {
        parts.push(`circuit ${segment.circuitIndex + 1}`);
    }
    if (segment.passDirection) {
        parts.push(segment.passDirection);
    }
    parts.push(`(${segment.start.x.toFixed(1)}, ${mod360(segment.start.y).toFixed(1)}) -> (${segment.end.x.toFixed(1)}, ${mod360(segment.end.y).toFixed(1)})`);
    return parts.join(' | ');
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
