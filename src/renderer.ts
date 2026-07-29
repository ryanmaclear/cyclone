type IMarlinStatus = import('./app-types').IMarlinStatus;
type IPreviewResult = import('./app-types').IPreviewResult;
type ICycloneApi = import('./app-types').ICycloneApi;
type IPreviewSegment = import('./planner/types').IPreviewSegment;
type ISaveArtifactsResult = import('./app-types').ISaveArtifactsResult;
type ISerialPortOption = import('./app-types').ISerialPortOption;
type TLayerParameters = import('./planner/types').TLayerParameters;
type ITubeRecipeInput = import('./recipe').ITubeRecipeInput;
type TLayerMode = import('./recipe').TLayerMode;
type TRecipeSummaryMode = import('./recipe').TRecipeSummaryMode;
type TStrengthPreset = import('./recipe').TStrengthPreset;
type TCustomRecipeLayer = import('./recipe').TCustomRecipeLayer;

type TColorMode = 'layer' | 'circuit' | 'pass';
type TRunSource = 'generated' | 'uploaded';

const TOW_COVERAGES_PER_RECIPE_LAYER = 2;

interface IWrappedPreviewSegment {
    source: IPreviewSegment;
    start: {x: number; y: number};
    end: {x: number; y: number};
}

interface IPreviewView {
    scale: number;
    offsetX: number;
    offsetY: number;
    dragging: boolean;
    lastMouseX: number;
    lastMouseY: number;
    colorMode: TColorMode;
}

interface ISelectedCircuit {
    layerIndex: number;
    circuitIndex: number;
}

interface ICustomLayerDraft {
    id: number;
    windType: 'helical' | 'hoop';
    windAngle: number;
}

interface ITubeOptionControlState {
    id: string;
    value: string;
    checked?: boolean;
}

interface ICycloneDialogElement extends HTMLDialogElement {
    open: boolean;
    showModal(): void;
    close(): void;
}

const DEFAULT_GCODE_FILENAME = 'tube.gcode';
const GCODE_STACK_BREAKPOINT_PX = 1500;
const DEFAULT_WIND_ANGLE_DEGREES = 55;
const MIN_WIND_ANGLE_DEGREES = 10;
const MAX_WIND_ANGLE_DEGREES = 80;

let currentPreview: IPreviewResult | null = null;
const cyclone = window.cyclone ?? createWebCycloneApi();
const visibleLayerIndexes = new Set<number>();
const expandedLayerIndexes = new Set<number>();
let hoveredLayerIndex: number | null = null;
let selectedLayerIndex: number | null = null;
let selectedCircuit: ISelectedCircuit | null = null;
let previewDrawFrame: number | null = null;
let wrappedPreviewSegments: IWrappedPreviewSegment[] = [];
let layerCanvasCacheKey = '';
const wrappedSegmentsBySegment = new WeakMap<IPreviewSegment, IWrappedPreviewSegment[]>();
const layerCanvasCache = new Map<number, HTMLCanvasElement>();
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
    stopping: false,
    queuedCommands: 0,
    totalCommands: 0,
    sentCommands: 0,
    portPath: null
};
let selectedRunSource: TRunSource = 'generated';
let uploadedGCodeCommands: string[] = [];
let uploadedGCodeFilename = '';
let loadedArtifactFilename = '';
let artifactUploadInProgress = false;
let tubeOptionControlSnapshot: ITubeOptionControlState[] | null = null;
let gcodeFilename = DEFAULT_GCODE_FILENAME;
let wasGCodePaneStacked = false;
let gcodeToastTimer: number | null = null;
let selectedRecipeMethod: TLayerMode = 'count';
let customLayers: ICustomLayerDraft[] = [];
let includeTerminalHoop = false;
let customLayerDraft: ICustomLayerDraft[] = [];
let draftIncludesTerminalHoop = false;
let nextCustomLayerId = 1;

window.addEventListener('DOMContentLoaded', () => {
    try {
        bindEvents();
        refreshPorts();
        updateRunControls();

        cyclone.onSerialStatus((status) => {
            currentStatus = status;
            renderMachineStatus();
            updateRunControls();
        });

        cyclone.onSerialLog((message) => appendSerialLog(message));
    } catch (error) {
        setRecipeMessage(getErrorMessage(error));
        console.error(error);
    }
});

function bindEvents(): void {
    byId<HTMLButtonElement>('generate').addEventListener('click', generatePreview);
    byId<HTMLButtonElement>('clear-recipe').addEventListener('click', clearGeneratedRecipe);
    byId<HTMLButtonElement>('save').addEventListener('click', saveArtifacts);
    byId<HTMLInputElement>('artifact-file').addEventListener('change', loadArtifactFile);
    byId<HTMLButtonElement>('discard-artifact').addEventListener('click', discardArtifact);
    byId<HTMLButtonElement>('close-artifact-error').addEventListener('click', () => {
        byId<ICycloneDialogElement>('artifact-error-dialog').close();
    });
    byId<HTMLButtonElement>('refresh-ports').addEventListener('click', refreshPorts);
    byId<HTMLButtonElement>('connect').addEventListener('click', connectSerial);
    byId<HTMLButtonElement>('disconnect').addEventListener('click', disconnectSerial);
    byId<HTMLButtonElement>('run').addEventListener('click', runGCode);
    byId<HTMLButtonElement>('pause').addEventListener('click', pauseMachine);
    byId<HTMLButtonElement>('resume').addEventListener('click', resumeMachine);
    byId<HTMLButtonElement>('clear-queue').addEventListener('click', clearQueue);
    byId<HTMLInputElement>('arm-run').addEventListener('change', updateRunControls);
    byId<HTMLSelectElement>('run-source').addEventListener('change', changeRunSource);
    byId<HTMLInputElement>('uploaded-gcode-file').addEventListener('change', loadUploadedGCode);
    byId<HTMLSelectElement>('recipe-method').addEventListener('change', changeRecipeMethod);
    byId<HTMLInputElement>('layer-count').addEventListener('beforeinput', preventNonIntegerLayerCountInput);
    byId<HTMLInputElement>('layer-count').addEventListener('input', () => changeLayerCount(false));
    byId<HTMLInputElement>('layer-count').addEventListener('change', () => changeLayerCount(true));
    byId<HTMLInputElement>('target-thickness').addEventListener('input', () => syncLayerCountFromTargetThickness(false));
    byId<HTMLInputElement>('target-thickness').addEventListener('change', () => syncLayerCountFromTargetThickness(true));
    byId<HTMLInputElement>('tow-thickness').addEventListener('input', () => syncActiveLayerDimension(false));
    byId<HTMLInputElement>('tow-thickness').addEventListener('change', () => syncActiveLayerDimension(true));
    byId<HTMLInputElement>('fixed-delivery-head').addEventListener('change', updateDeliveryHeadControls);
    byId<HTMLSelectElement>('strength').addEventListener('change', updateStandardTerminalHoopControl);
    byId<HTMLButtonElement>('edit-custom-layers').addEventListener('click', openCustomLayerDialog);
    byId<HTMLButtonElement>('add-custom-layer').addEventListener('click', addCustomLayerDraft);
    byId<HTMLButtonElement>('clear-custom-layers').addEventListener('click', clearCustomLayerDraft);
    byId<HTMLButtonElement>('cancel-custom-layers').addEventListener('click', closeCustomLayerDialog);
    byId<HTMLButtonElement>('apply-custom-layers').addEventListener('click', applyCustomLayerDraft);
    byId<HTMLInputElement>('custom-terminal-hoop').addEventListener('change', changeDraftTerminalHoop);
    const customDialog = byId<ICycloneDialogElement>('custom-layer-dialog');
    customDialog.addEventListener('cancel', (event) => {
        event.preventDefault();
        closeCustomLayerDialog();
    });
    customDialog.addEventListener('click', (event) => {
        if (event.target === customDialog) {
            closeCustomLayerDialog();
        }
    });
    byId<HTMLButtonElement>('fit-preview').addEventListener('click', fitPreview);
    byId<HTMLButtonElement>('actual-size-preview').addEventListener('click', actualSizePreview);
    byId<HTMLButtonElement>('zoom-in-preview').addEventListener('click', () => zoomPreview(1.25));
    byId<HTMLButtonElement>('zoom-out-preview').addEventListener('click', () => zoomPreview(0.8));
    byId<HTMLButtonElement>('show-all-layers').addEventListener('click', showAllLayers);
    byId<HTMLSelectElement>('color-mode').addEventListener('change', () => {
        previewView.colorMode = byId<HTMLSelectElement>('color-mode').value as TColorMode;
        requestPreviewDraw(true);
    });
    byId<HTMLButtonElement>('download-gcode').addEventListener('click', downloadGCodePreview);
    byId<HTMLButtonElement>('copy-gcode').addEventListener('click', copyGCodePreview);
    const gcodeFilenameInput = byId<HTMLInputElement>('gcode-filename');
    gcodeFilenameInput.value = gcodeFilename;
    gcodeFilenameInput.addEventListener('input', () => {
        gcodeFilename = gcodeFilenameInput.value;
    });
    gcodeFilenameInput.addEventListener('change', () => {
        gcodeFilename = normalizeGCodeFilename(gcodeFilenameInput.value);
        gcodeFilenameInput.value = gcodeFilename;
    });
    bindCanvasEvents();
    bindRecipeInvalidationEvents();
    updateLayerModeControls();
    updateDeliveryHeadControls();
    syncActiveLayerDimension(true);
    updateGCodePanel(null);
    syncResponsiveGCodePanel();
    window.addEventListener('resize', () => {
        syncResponsiveGCodePanel();
        requestPreviewDraw(true);
    });
}

async function generatePreview(): Promise<void> {
    byId<HTMLInputElement>('arm-run').checked = false;
    resetGeneratedRecipe();
    updateRunControls();
    setArtifactPaths(null);
    setRecipeMessage('Generating preview...');
    byId<HTMLButtonElement>('generate').disabled = true;
    syncActiveLayerDimension(true);

    try {
        const request = {recipeInput: readRecipeInput()};
        await showGenerationPopup('Generating recipe preview…');
        const preview = await cyclone.generatePreview(request);
        applyGeneratedPreview(preview, 'Preview generated.');
    } catch (error) {
        resetGeneratedRecipe();
        updateRunControls();
        setRecipeMessage(getErrorMessage(error));
        console.error(error);
    } finally {
        hideGenerationPopup();
        byId<HTMLButtonElement>('generate').disabled = loadedArtifactFilename.length > 0;
    }
}

function clearGeneratedRecipe(): void {
    if (loadedArtifactFilename) {
        return;
    }
    byId<HTMLInputElement>('arm-run').checked = false;
    resetGeneratedRecipe();
    updateRunControls();
    setArtifactPaths(null);
    setRecipeMessage('Recipe cleared.');
}

function resetGeneratedRecipe(): void {
    currentPreview = null;
    prepareWrappedPreviewSegments(null);
    invalidatePreviewLayerCache();
    visibleLayerIndexes.clear();
    expandedLayerIndexes.clear();
    hoveredLayerIndex = null;
    selectedLayerIndex = null;
    selectedCircuit = null;
    renderPreview(null);
    byId<HTMLButtonElement>('save').disabled = true;
}

function applyGeneratedPreview(preview: IPreviewResult, message?: string): void {
    currentPreview = preview;
    prepareWrappedPreviewSegments(preview);
    resetLayerVisibility(preview);
    renderPreview(preview);
    byId<HTMLButtonElement>('save').disabled = false;
    selectedRunSource = 'generated';
    byId<HTMLSelectElement>('run-source').value = selectedRunSource;
    updateRunControls();
    if (message) {
        setRecipeMessage(message);
    }
}

async function loadArtifactFile(): Promise<void> {
    const input = byId<HTMLInputElement>('artifact-file');
    const file = input.files?.[0];
    if (!file) {
        updateArtifactStatus('No artifact loaded');
        return;
    }

    updateArtifactStatus(`Validating ${file.name} and generating preview…`);
    artifactUploadInProgress = true;
    input.disabled = true;
    byId<HTMLButtonElement>('generate').disabled = true;
    byId<HTMLInputElement>('arm-run').checked = false;
    resetGeneratedRecipe();
    setArtifactPaths(null);
    setRecipeMessage('');
    updateRunControls();

    try {
        await showGenerationPopup('Validating artifact and generating preview…');
        let artifact: unknown;
        try {
            artifact = JSON.parse(await file.text()) as unknown;
        } catch {
            throw new Error('Artifact file is not valid JSON.');
        }

        const preview = await cyclone.generateArtifactPreview({windParameters: artifact});
        loadedArtifactFilename = file.name;
        clearTubeOptionValuesForArtifact();
        setArtifactLockState(true);
        setArtifactPaths(null);
        applyGeneratedPreview(preview);
        updateArtifactStatus(`${file.name} loaded · ${preview.recipe.summary.requestedLayerCount} planned layers`);
    } catch (error) {
        loadedArtifactFilename = '';
        restoreTubeOptionValues();
        input.value = '';
        setArtifactLockState(false);
        const message = getErrorMessage(error);
        updateArtifactStatus(message, true);
        hideGenerationPopup();
        showArtifactError(message);
        console.error(error);
    } finally {
        hideGenerationPopup();
        artifactUploadInProgress = false;
        updateRunControls();
    }
}

function discardArtifact(): void {
    const filename = loadedArtifactFilename;
    loadedArtifactFilename = '';
    byId<HTMLInputElement>('artifact-file').value = '';
    byId<HTMLInputElement>('arm-run').checked = false;
    restoreTubeOptionValues();
    setArtifactLockState(false);
    resetGeneratedRecipe();
    setArtifactPaths(null);
    updateRunControls();
    updateArtifactStatus('No artifact loaded');
    setRecipeMessage(filename ? `Artifact ${filename} discarded. Tube options unlocked.` : 'Tube options unlocked.');
}

function setArtifactLockState(locked: boolean): void {
    byId<HTMLFieldSetElement>('tube-options').disabled = locked;
    byId<HTMLInputElement>('artifact-file').disabled = locked;
    byId<HTMLButtonElement>('discard-artifact').hidden = !locked;
    byId<HTMLDivElement>('artifact-upload-card').classList.toggle('loaded', locked);
    byId<HTMLButtonElement>('generate').disabled = locked;
    updateRunControls();
}

function updateArtifactStatus(message: string, isError = false): void {
    const status = byId<HTMLParagraphElement>('artifact-upload-status');
    status.textContent = message;
    status.classList.toggle('error', isError);
}

function showArtifactError(message: string): void {
    byId<HTMLParagraphElement>('artifact-error-message').textContent = message;
    const dialog = byId<ICycloneDialogElement>('artifact-error-dialog');
    if (!dialog.open) {
        dialog.showModal();
    }
}

function clearTubeOptionValuesForArtifact(): void {
    const controls = getTubeOptionControls();
    tubeOptionControlSnapshot = controls.map((control) => ({
        id: control.id,
        value: control.value,
        checked: control instanceof HTMLInputElement
            && (control.type === 'checkbox' || control.type === 'radio')
            ? control.checked
            : undefined
    }));

    controls.forEach((control) => {
        if (control instanceof HTMLInputElement && (control.type === 'checkbox' || control.type === 'radio')) {
            control.checked = false;
            control.value = '';
        } else if (control instanceof HTMLSelectElement) {
            control.selectedIndex = -1;
        } else {
            control.value = '';
        }
    });
    byId<HTMLElement>('custom-layer-summary').textContent = '';
    byId<HTMLParagraphElement>('custom-terminal-summary').textContent = '';
}

function restoreTubeOptionValues(): void {
    if (!tubeOptionControlSnapshot) {
        return;
    }

    for (const state of tubeOptionControlSnapshot) {
        const control = byId<HTMLInputElement | HTMLSelectElement>(state.id);
        control.value = state.value;
        if (control instanceof HTMLInputElement && typeof state.checked === 'boolean') {
            control.checked = state.checked;
        }
    }
    tubeOptionControlSnapshot = null;
    updateCustomLayerSummary();
}

function getTubeOptionControls(): Array<HTMLInputElement | HTMLSelectElement> {
    return Array.from(
        byId<HTMLFieldSetElement>('tube-options')
            .querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')
    );
}

async function showGenerationPopup(message: string): Promise<void> {
    byId<HTMLElement>('generation-message').textContent = message;
    byId<HTMLDivElement>('generation-overlay').hidden = false;
    document.body.setAttribute('aria-busy', 'true');
    await new Promise<void>((resolve) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => resolve()));
    });
}

function hideGenerationPopup(): void {
    byId<HTMLDivElement>('generation-overlay').hidden = true;
    document.body.removeAttribute('aria-busy');
}

async function saveArtifacts(): Promise<void> {
    if (!currentPreview || loadedArtifactFilename) {
        return;
    }

    const basePath = await cyclone.chooseBasePath();
    if (!basePath) {
        return;
    }

    try {
        const result = await cyclone.saveArtifacts({
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
        const ports = await cyclone.listSerialPorts();
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
        currentStatus = await cyclone.connectSerial({
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
    currentStatus = await cyclone.disconnectSerial();
    renderMachineStatus();
    updateRunControls();
    setMachineMessage('Disconnected.');
}

async function runGCode(): Promise<void> {
    if (!byId<HTMLInputElement>('arm-run').checked) {
        return;
    }

    const commands = getSelectedRunCommands();
    if (!commands) {
        return;
    }

    try {
        currentStatus = await cyclone.runGCode(commands);
        byId<HTMLInputElement>('arm-run').checked = false;
        renderMachineStatus();
        updateRunControls();
        setMachineMessage(`${selectedRunSource === 'uploaded' ? 'Uploaded' : 'Generated'} G-code queued.`);
    } catch (error) {
        setMachineMessage(getErrorMessage(error));
    }
}

function changeRunSource(): void {
    selectedRunSource = byId<HTMLSelectElement>('run-source').value as TRunSource;
    byId<HTMLInputElement>('arm-run').checked = false;
    updateRunControls();
}

async function loadUploadedGCode(): Promise<void> {
    const input = byId<HTMLInputElement>('uploaded-gcode-file');
    const file = input.files && input.files.length > 0 ? input.files[0] : null;
    byId<HTMLInputElement>('arm-run').checked = false;

    if (!file) {
        uploadedGCodeCommands = [];
        uploadedGCodeFilename = '';
        renderUploadedGCodeStatus();
        updateRunControls();
        return;
    }

    try {
        const text = await file.text();
        uploadedGCodeCommands = text.split(/\r?\n/);
        uploadedGCodeFilename = file.name;
        selectedRunSource = 'uploaded';
        byId<HTMLSelectElement>('run-source').value = selectedRunSource;
        renderUploadedGCodeStatus();
        updateRunControls();
        setMachineMessage('Uploaded G-code file selected.');
    } catch (error) {
        uploadedGCodeCommands = [];
        uploadedGCodeFilename = '';
        renderUploadedGCodeStatus();
        updateRunControls();
        setMachineMessage(getErrorMessage(error));
    }
}

async function pauseMachine(): Promise<void> {
    try {
        currentStatus = await cyclone.pauseMachine();
        renderMachineStatus();
        updateRunControls();
    } catch (error) {
        setMachineMessage(getErrorMessage(error));
    }
}

async function resumeMachine(): Promise<void> {
    try {
        currentStatus = await cyclone.resumeMachine();
        renderMachineStatus();
        updateRunControls();
    } catch (error) {
        setMachineMessage(getErrorMessage(error));
    }
}

async function clearQueue(): Promise<void> {
    try {
        currentStatus = await cyclone.clearMachineQueue();
        renderMachineStatus();
        updateRunControls();
        setMachineMessage('Run stopping.');
    } catch (error) {
        setMachineMessage(getErrorMessage(error));
    }
}

function readRecipeInput(): ITubeRecipeInput {
    const layerMode = getLayerMode();
    const layerCount = readNumber('layer-count');
    const targetThickness = readNumber('target-thickness');
    return {
        diameter: readNumber('diameter'),
        windLength: readNumber('wind-length'),
        windAngle: readNumber('wind-angle'),
        strengthPreset: byId<HTMLSelectElement>('strength').value as TStrengthPreset,
        layerMode,
        layerCount: layerMode === 'count' && Number.isFinite(layerCount) ? layerCount : undefined,
        targetThickness: layerMode === 'thickness' && Number.isFinite(targetThickness) ? targetThickness : undefined,
        customLayers: layerMode === 'custom' ? customLayers.map(toCustomRecipeLayer) : undefined,
        includeTerminalHoop: layerMode === 'custom' ? includeTerminalHoop : undefined,
        terminalFinalHoop: layerMode === 'count' && hasStandardHoopLayer()
            ? byId<HTMLInputElement>('terminal-final-hoop').checked
            : undefined,
        towWidth: readNumber('tow-width'),
        towThickness: readNumber('tow-thickness'),
        defaultFeedRate: readNumber('feed-rate'),
        lockDegrees: readNumber('lock-degrees'),
        leadInMM: readNumber('lead-in'),
        leadOutDegrees: readNumber('lead-out'),
        fixedDeliveryHead: byId<HTMLInputElement>('fixed-delivery-head').checked,
        fixedDeliveryHeadPosition: 0,
        disableSoftEndstops: byId<HTMLInputElement>('disable-soft-endstops').checked
    };
}

function renderPreview(preview: IPreviewResult | null): void {
    const summary = byId<HTMLDivElement>('summary');
    const warnings = byId<HTMLUListElement>('warnings');
    const layerTableBody = byId<HTMLTableSectionElement>('layer-table-body');

    summary.innerHTML = '';
    warnings.innerHTML = '';
    layerTableBody.innerHTML = '';
    updateGCodePanel(preview);

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

    const modeLabels: Record<TRecipeSummaryMode, string> = {
        count: 'Layer count',
        thickness: 'Total thickness',
        custom: 'Custom layers',
        artifact: 'Uploaded artifact'
    };
    addMetric(summary, 'Mode', modeLabels[preview.recipe.summary.layerMode]);
    addMetric(summary, 'Layers', preview.recipe.summary.requestedLayerCount.toString());
    if (preview.recipe.summary.layerMode === 'thickness' && typeof preview.recipe.summary.targetThickness !== 'undefined') {
        addMetric(summary, 'Target thickness', `${formatMM(preview.recipe.summary.targetThickness)} mm`);
    }
    addMetric(summary, 'Achieved thickness', `${formatMM(preview.recipe.summary.achievedThickness)} mm`);
    addMetric(summary, 'Helical', preview.recipe.summary.helicalLayerCount.toString());
    addMetric(summary, 'Hoop', preview.recipe.summary.hoopLayerCount.toString());
    if (preview.recipe.summary.skipLayerCount) {
        addMetric(summary, 'Skip', preview.recipe.summary.skipLayerCount.toString());
    }
    if (typeof preview.recipe.summary.patternNumber === 'number') {
        addMetric(summary, 'Pattern', preview.recipe.summary.patternNumber.toString());
    }
    if (typeof preview.recipe.summary.numCircuits === 'number') {
        addMetric(summary, 'Circuits', preview.recipe.summary.numCircuits.toString());
    }
    addMetric(summary, 'G-code lines', preview.plan.gcode.length.toString());
    addMetric(summary, 'Time', `${Math.round(preview.plan.totalTimeS)} s`);
    addMetric(summary, 'Tow', `${preview.plan.totalTowUseM.toFixed(2)} m`);

    for (const warning of preview.recipe.warnings) {
        const item = document.createElement('li');
        item.textContent = warning;
        warnings.appendChild(item);
    }
}

function updateLayerModeControls(): void {
    const layerMode = getLayerMode();
    const customMode = layerMode === 'custom';
    byId<HTMLDivElement>('standard-recipe-fields').hidden = customMode;
    byId<HTMLDivElement>('custom-recipe-card').hidden = !customMode;
    byId<HTMLLabelElement>('layer-count-field').hidden = layerMode !== 'count';
    byId<HTMLLabelElement>('target-thickness-field').hidden = layerMode !== 'thickness';
    updateStandardTerminalHoopControl();
    updateCustomLayerSummary();
}

function updateDeliveryHeadControls(): void {
    const fixedDeliveryHead = byId<HTMLInputElement>('fixed-delivery-head').checked;
    byId<HTMLInputElement>('lead-in').disabled = fixedDeliveryHead;
    byId<HTMLInputElement>('lead-out').disabled = fixedDeliveryHead;
    byId<HTMLLabelElement>('lead-in-field').classList.toggle('inactive-field', fixedDeliveryHead);
    byId<HTMLLabelElement>('lead-out-field').classList.toggle('inactive-field', fixedDeliveryHead);
}

function changeRecipeMethod(): void {
    const select = byId<HTMLSelectElement>('recipe-method');
    const nextMethod = select.value as TLayerMode;
    if (selectedRecipeMethod === 'custom' && nextMethod !== 'custom' && hasCustomRecipe()) {
        const confirmed = window.confirm('Switching recipe method will discard the custom layer sequence. Continue?');
        if (!confirmed) {
            select.value = selectedRecipeMethod;
            return;
        }
        customLayers = [];
        includeTerminalHoop = false;
    }

    selectedRecipeMethod = nextMethod;
    updateLayerModeControls();
    if (nextMethod !== 'custom') {
        syncActiveLayerDimension(true);
    }
    invalidateGeneratedRecipe();
}

function preventNonIntegerLayerCountInput(event: InputEvent): void {
    if (event.data && /[^\d]/.test(event.data)) {
        event.preventDefault();
    }
}

function changeLayerCount(snapLayerCount: boolean): void {
    normalizeLayerCountInput();
    syncTargetThicknessFromLayerCount(snapLayerCount);
    updateStandardTerminalHoopControl();
}

function updateStandardTerminalHoopControl(): void {
    byId<HTMLLabelElement>('terminal-final-hoop-field').hidden =
        getLayerMode() !== 'count' || !hasStandardHoopLayer();
}

function hasStandardHoopLayer(): boolean {
    const layerCount = readNumber('layer-count');
    const distribution = byId<HTMLSelectElement>('strength').value as TStrengthPreset;
    return Number.isInteger(layerCount) && layerCount > 1 && distribution !== 'light';
}

function normalizeLayerCountInput(): void {
    const input = byId<HTMLInputElement>('layer-count');
    const normalizedValue = input.value.replace(/\D/g, '');
    if (input.value !== normalizedValue) {
        input.value = normalizedValue;
    }
}

function syncActiveLayerDimension(snapTargetThickness: boolean): void {
    syncTargetThicknessConstraints();
    const layerMode = getLayerMode();
    if (layerMode === 'custom') {
        return;
    }
    if (layerMode === 'thickness') {
        syncLayerCountFromTargetThickness(snapTargetThickness);
        return;
    }

    syncTargetThicknessFromLayerCount(snapTargetThickness);
}

function syncTargetThicknessFromLayerCount(snapLayerCount: boolean): void {
    const layerCount = readNumber('layer-count');
    const towThickness = readNumber('tow-thickness');
    if (!Number.isFinite(layerCount) || !Number.isFinite(towThickness) || layerCount < 1 || towThickness <= 0) {
        return;
    }

    const roundedLayerCount = Math.round(layerCount);
    if (snapLayerCount) {
        byId<HTMLInputElement>('layer-count').value = roundedLayerCount.toString();
    }
    const layerThickness = towThickness * TOW_COVERAGES_PER_RECIPE_LAYER;
    byId<HTMLInputElement>('target-thickness').value = formatMM(roundedLayerCount * layerThickness);
}

function syncLayerCountFromTargetThickness(snapTargetThickness: boolean): void {
    const targetThickness = readNumber('target-thickness');
    const towThickness = readNumber('tow-thickness');
    if (!Number.isFinite(targetThickness) || !Number.isFinite(towThickness) || targetThickness <= 0 || towThickness <= 0) {
        return;
    }

    const layerThickness = towThickness * TOW_COVERAGES_PER_RECIPE_LAYER;
    const layerCount = Math.max(1, Math.round(targetThickness / layerThickness));
    byId<HTMLInputElement>('layer-count').value = layerCount.toString();
    if (snapTargetThickness) {
        byId<HTMLInputElement>('target-thickness').value = formatMM(layerCount * layerThickness);
    }
}

function syncTargetThicknessConstraints(): void {
    const towThickness = readNumber('tow-thickness');
    const targetThicknessInput = byId<HTMLInputElement>('target-thickness');
    if (!Number.isFinite(towThickness) || towThickness <= 0) {
        targetThicknessInput.min = '0.01';
        targetThicknessInput.step = '0.01';
        return;
    }

    const layerThickness = towThickness * TOW_COVERAGES_PER_RECIPE_LAYER;
    targetThicknessInput.min = formatMM(layerThickness * 2);
    targetThicknessInput.step = formatMM(layerThickness);
}

function bindRecipeInvalidationEvents(): void {
    const recipeForm = byId<HTMLDivElement>('tube-recipe-form');
    recipeForm.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select').forEach((input) => {
        if (input.id !== 'recipe-method' && input.id !== 'artifact-file') {
            input.addEventListener('input', invalidateGeneratedRecipe);
        }
    });
}

function invalidateGeneratedRecipe(): void {
    if (!currentPreview) {
        return;
    }
    byId<HTMLInputElement>('arm-run').checked = false;
    resetGeneratedRecipe();
    updateRunControls();
    setArtifactPaths(null);
    setRecipeMessage('Recipe changed. Generate a new preview before running.');
}

function openCustomLayerDialog(): void {
    customLayerDraft = customLayers.map((layer) => ({...layer}));
    draftIncludesTerminalHoop = includeTerminalHoop;
    byId<HTMLInputElement>('custom-terminal-hoop').checked = draftIncludesTerminalHoop;
    byId<HTMLDivElement>('custom-layer-dialog-message').textContent = '';
    renderCustomLayerDraft();
    byId<ICycloneDialogElement>('custom-layer-dialog').showModal();
}

function closeCustomLayerDialog(): void {
    const dialog = byId<ICycloneDialogElement>('custom-layer-dialog');
    if (dialog.open) {
        dialog.close();
    }
}

function addCustomLayerDraft(): void {
    const configuredAngle = readNumber('wind-angle');
    customLayerDraft.push({
        id: nextCustomLayerId++,
        windType: 'helical',
        windAngle: Number.isFinite(configuredAngle) ? configuredAngle : DEFAULT_WIND_ANGLE_DEGREES
    });
    renderCustomLayerDraft();
}

function clearCustomLayerDraft(): void {
    if (customLayerDraft.length === 0 && !draftIncludesTerminalHoop) {
        return;
    }
    if (!window.confirm('Clear all custom layers, including the final single-pass hoop?')) {
        return;
    }
    customLayerDraft = [];
    draftIncludesTerminalHoop = false;
    byId<HTMLInputElement>('custom-terminal-hoop').checked = false;
    renderCustomLayerDraft();
}

function changeDraftTerminalHoop(): void {
    draftIncludesTerminalHoop = byId<HTMLInputElement>('custom-terminal-hoop').checked;
    updateDraftTerminalRow();
}

function applyCustomLayerDraft(): void {
    const validationError = getCustomLayerDraftError();
    if (validationError) {
        byId<HTMLDivElement>('custom-layer-dialog-message').textContent = validationError;
        return;
    }

    customLayers = customLayerDraft.map((layer) => ({...layer}));
    includeTerminalHoop = draftIncludesTerminalHoop;
    closeCustomLayerDialog();
    updateCustomLayerSummary();
    invalidateGeneratedRecipe();
}

function getCustomLayerDraftError(): string | null {
    const invalidIndex = customLayerDraft.findIndex((layer) =>
        layer.windType === 'helical'
        && (!Number.isFinite(layer.windAngle)
            || layer.windAngle < MIN_WIND_ANGLE_DEGREES
            || layer.windAngle > MAX_WIND_ANGLE_DEGREES)
    );
    return invalidIndex >= 0
        ? `Layer ${invalidIndex + 1} angle must be between ${MIN_WIND_ANGLE_DEGREES} and ${MAX_WIND_ANGLE_DEGREES} degrees.`
        : null;
}

function renderCustomLayerDraft(): void {
    const layerList = byId<HTMLDivElement>('custom-layer-list');
    layerList.innerHTML = '';

    if (customLayerDraft.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'custom-layer-empty';
        empty.textContent = 'No ordinary layers. Add a layer or use the final single-pass hoop by itself.';
        layerList.appendChild(empty);
    }

    customLayerDraft.forEach((layer, index) => {
        layerList.appendChild(createCustomLayerDraftRow(layer, index));
    });
    updateDraftTerminalRow();
    byId<HTMLDivElement>('custom-layer-dialog-message').textContent = '';
}

function createCustomLayerDraftRow(layer: ICustomLayerDraft, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'custom-layer-row';

    const number = document.createElement('span');
    number.className = 'custom-layer-number';
    number.textContent = (index + 1).toString();

    const typeLabel = document.createElement('label');
    typeLabel.className = 'custom-layer-type';
    typeLabel.textContent = 'Type';
    const typeSelect = document.createElement('select');
    const helicalOption = document.createElement('option');
    helicalOption.value = 'helical';
    helicalOption.textContent = 'Helical';
    const hoopOption = document.createElement('option');
    hoopOption.value = 'hoop';
    hoopOption.textContent = 'Hoop (there and back)';
    typeSelect.append(helicalOption, hoopOption);
    typeSelect.value = layer.windType;
    typeSelect.addEventListener('change', () => {
        layer.windType = typeSelect.value as ICustomLayerDraft['windType'];
        renderCustomLayerDraft();
    });
    typeLabel.appendChild(typeSelect);

    const angleLabel = document.createElement('label');
    angleLabel.className = 'custom-layer-angle';
    angleLabel.textContent = 'Angle deg';
    angleLabel.hidden = layer.windType !== 'helical';
    const angleInput = document.createElement('input');
    angleInput.type = 'number';
    angleInput.min = MIN_WIND_ANGLE_DEGREES.toString();
    angleInput.max = MAX_WIND_ANGLE_DEGREES.toString();
    angleInput.step = '0.1';
    angleInput.value = Number.isFinite(layer.windAngle) ? layer.windAngle.toString() : '';
    angleInput.addEventListener('input', () => {
        layer.windAngle = Number.parseFloat(angleInput.value);
        byId<HTMLDivElement>('custom-layer-dialog-message').textContent = '';
    });
    angleLabel.appendChild(angleInput);

    const actions = document.createElement('div');
    actions.className = 'custom-layer-actions';
    actions.appendChild(createCustomLayerAction('↑', `Move layer ${index + 1} up`, index === 0, () => moveCustomLayerDraft(index, -1)));
    actions.appendChild(createCustomLayerAction('↓', `Move layer ${index + 1} down`, index === customLayerDraft.length - 1, () => moveCustomLayerDraft(index, 1)));
    const deleteButton = createCustomLayerAction('Delete', `Delete layer ${index + 1}`, false, () => {
        customLayerDraft.splice(index, 1);
        renderCustomLayerDraft();
    });
    deleteButton.classList.add('danger');
    actions.appendChild(deleteButton);

    row.append(number, typeLabel, angleLabel, actions);
    return row;
}

function createCustomLayerAction(
    text: string,
    label: string,
    disabled: boolean,
    action: () => void
): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary';
    button.textContent = text;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.disabled = disabled;
    button.addEventListener('click', action);
    return button;
}

function moveCustomLayerDraft(index: number, offset: -1 | 1): void {
    const destination = index + offset;
    if (destination < 0 || destination >= customLayerDraft.length) {
        return;
    }
    const layer = customLayerDraft[index];
    customLayerDraft[index] = customLayerDraft[destination];
    customLayerDraft[destination] = layer;
    renderCustomLayerDraft();
}

function updateDraftTerminalRow(): void {
    byId<HTMLParagraphElement>('terminal-layer-row').hidden = !draftIncludesTerminalHoop;
}

function updateCustomLayerSummary(): void {
    const helicalCount = customLayers.filter((layer) => layer.windType === 'helical').length;
    const hoopCount = customLayers.length - helicalCount + (includeTerminalHoop ? 1 : 0);
    const totalCount = customLayers.length + (includeTerminalHoop ? 1 : 0);
    const layerLabel = totalCount === 1 ? 'layer' : 'layers';
    byId<HTMLElement>('custom-layer-summary').textContent = totalCount === 0
        ? 'No custom layers'
        : `${totalCount} ${layerLabel} · ${helicalCount} helical · ${hoopCount} hoop`;
    byId<HTMLParagraphElement>('custom-terminal-summary').textContent =
        `Final single-pass hoop: ${includeTerminalHoop ? 'Yes' : 'No'}`;
}

function hasCustomRecipe(): boolean {
    return customLayers.length > 0 || includeTerminalHoop;
}

function toCustomRecipeLayer(layer: ICustomLayerDraft): TCustomRecipeLayer {
    return layer.windType === 'helical'
        ? {windType: 'helical', windAngle: layer.windAngle}
        : {windType: 'hoop'};
}

function bindCanvasEvents(): void {
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    canvas.addEventListener('pointerdown', (event) => {
        previewView.dragging = true;
        previewView.lastMouseX = event.clientX;
        previewView.lastMouseY = event.clientY;
        canvas.setPointerCapture(event.pointerId);
        canvas.classList.add('dragging');
    });
    canvas.addEventListener('pointerup', (event) => endCanvasDrag(event));
    canvas.addEventListener('pointercancel', (event) => endCanvasDrag(event));
    canvas.addEventListener('pointerleave', () => {
        if (!previewView.dragging) {
            hidePreviewTooltip();
        }
    });
    canvas.addEventListener('pointermove', (event) => {
        if (!previewView.dragging) {
            if (event.pointerType === 'mouse') {
                updatePreviewTooltip(event);
            }
            return;
        }
        hidePreviewTooltip();
        previewView.offsetX += event.clientX - previewView.lastMouseX;
        previewView.offsetY += event.clientY - previewView.lastMouseY;
        previewView.lastMouseX = event.clientX;
        previewView.lastMouseY = event.clientY;
        requestPreviewDraw(true);
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

function endCanvasDrag(event?: PointerEvent): void {
    previewView.dragging = false;
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    if (event && canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
    }
    canvas.classList.remove('dragging');
}

function fitPreview(): void {
    if (!currentPreview) {
        return;
    }
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const rect = canvas.getBoundingClientRect();
    const windLength = currentPreview.recipe.windParameters.mandrelParameters.windLength;
    const circumference = getPreviewCircumference();
    const paddingLeft = 72;
    const paddingRight = 28;
    const paddingTop = 28;
    const paddingBottom = 54;
    previewView.scale = Math.max(0.1, Math.min((rect.width - paddingLeft - paddingRight) / windLength, (rect.height - paddingTop - paddingBottom) / circumference));
    previewView.offsetX = paddingLeft + ((rect.width - paddingLeft - paddingRight) - windLength * previewView.scale) / 2;
    previewView.offsetY = paddingTop + ((rect.height - paddingTop - paddingBottom) - circumference * previewView.scale) / 2;
    requestPreviewDraw(true);
}

function actualSizePreview(): void {
    if (!currentPreview) {
        return;
    }
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const rect = canvas.getBoundingClientRect();
    const circumference = getPreviewCircumference();
    const paddingTop = 28;
    const paddingBottom = 54;
    previewView.scale = 1;
    previewView.offsetX = 72;
    previewView.offsetY = paddingTop + ((rect.height - paddingTop - paddingBottom) - circumference) / 2;
    requestPreviewDraw(true);
}

function zoomPreview(factor: number, originX?: number, originY?: number): void {
    const canvas = byId<HTMLCanvasElement>('preview-canvas');
    const rect = canvas.getBoundingClientRect();
    const x = typeof originX === 'number' ? originX : rect.width / 2;
    const y = typeof originY === 'number' ? originY : rect.height / 2;
    const worldX = (x - previewView.offsetX) / previewView.scale;
    const worldYMM = (y - previewView.offsetY) / previewView.scale;
    previewView.scale = Math.max(0.05, Math.min(40, previewView.scale * factor));
    previewView.offsetX = x - worldX * previewView.scale;
    previewView.offsetY = y - worldYMM * previewView.scale;
    requestPreviewDraw(true);
}

function requestPreviewDraw(invalidateCache = false): void {
    if (invalidateCache) {
        invalidatePreviewLayerCache();
    }
    if (previewDrawFrame !== null) {
        return;
    }
    previewDrawFrame = window.requestAnimationFrame(() => {
        previewDrawFrame = null;
        drawPreview();
    });
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

    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    ensureLayerCanvasCache(canvas, rect);

    const highlightedSegments: IPreviewSegment[] = [];
    const highlightedSegmentSet = new Set<IPreviewSegment>();
    visibleLayerIndexes.forEach((layerIndex) => {
        const layerCanvas = layerCanvasCache.get(layerIndex);
        if (layerCanvas) {
            ctx.globalAlpha = 1;
            ctx.drawImage(layerCanvas, 0, 0, rect.width, rect.height);
        }
    });

    for (const wrappedSegment of wrappedPreviewSegments) {
        const segment = wrappedSegment.source;
        if (!visibleLayerIndexes.has(segment.layerIndex) || !shouldOverlaySegment(segment)) {
            continue;
        }
        if (!highlightedSegmentSet.has(segment)) {
            highlightedSegmentSet.add(segment);
            highlightedSegments.push(segment);
        }
    }

    for (const segment of highlightedSegments) {
        drawSegment(ctx, segment, true);
    }
}

function ensureLayerCanvasCache(canvas: HTMLCanvasElement, rect: DOMRect): void {
    const cacheKey = getLayerCanvasCacheKey(canvas);
    if (cacheKey !== layerCanvasCacheKey) {
        layerCanvasCacheKey = cacheKey;
        layerCanvasCache.clear();
    }

    if (!currentPreview) {
        return;
    }

    for (let index = 0; index < currentPreview.recipe.windParameters.layers.length; index++) {
        if (!layerCanvasCache.has(index)) {
            layerCanvasCache.set(index, renderLayerCanvas(index, rect));
        }
    }
}

function renderLayerCanvas(layerIndex: number, rect: DOMRect): HTMLCanvasElement {
    const ratio = window.devicePixelRatio || 1;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(rect.width * ratio));
    canvas.height = Math.max(1, Math.floor(rect.height * ratio));

    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('Could not create preview layer cache.');
    }

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';

    for (const wrappedSegment of wrappedPreviewSegments) {
        if (wrappedSegment.source.layerIndex === layerIndex) {
            drawWrappedSegment(ctx, wrappedSegment, false);
        }
    }

    return canvas;
}

function getLayerCanvasCacheKey(canvas: HTMLCanvasElement): string {
    return [
        canvas.width,
        canvas.height,
        previewView.scale.toFixed(6),
        previewView.offsetX.toFixed(3),
        previewView.offsetY.toFixed(3),
        previewView.colorMode
    ].join('|');
}

function invalidatePreviewLayerCache(): void {
    layerCanvasCacheKey = '';
    layerCanvasCache.clear();
}

function drawPreviewGrid(ctx: CanvasRenderingContext2D, width: number, height: number): void {
    const windLength = currentPreview ? currentPreview.recipe.windParameters.mandrelParameters.windLength : 0;
    const circumference = getPreviewCircumference();
    ctx.strokeStyle = '#dde3d8';
    ctx.lineWidth = 1;
    for (const y of [0, 90, 180, 270, 360]) {
        const screenY = previewToScreenY(y);
        ctx.beginPath();
        ctx.moveTo(previewToScreenX(0), screenY);
        ctx.lineTo(previewToScreenX(windLength), screenY);
        ctx.stroke();
    }
    drawLengthMarkers(ctx, windLength, height);
    ctx.strokeStyle = '#c6cec1';
    ctx.strokeRect(previewToScreenX(0), previewToScreenY(0), windLength * previewView.scale, circumference * previewView.scale);
    ctx.fillStyle = '#68727a';
    ctx.font = '12px Arial';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const labelX = Math.max(48, Math.min(width - 12, previewToScreenX(0) - 10));
    ctx.fillText('0 deg', labelX, previewToScreenY(0));
    ctx.fillText('90 deg', labelX, previewToScreenY(90));
    ctx.fillText('180 deg', labelX, previewToScreenY(180));
    ctx.fillText('270 deg', labelX, previewToScreenY(270));
    ctx.fillText('360 deg', labelX, previewToScreenY(360));
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
}

function drawLengthMarkers(ctx: CanvasRenderingContext2D, windLength: number, height: number): void {
    const tubeBottomY = previewToScreenY(360);
    const markerTopY = tubeBottomY + 5;
    const markerBottomY = tubeBottomY + 12;
    const labelY = Math.min(height - 8, tubeBottomY + 28);
    const step = getLengthMarkerStep(windLength);

    ctx.strokeStyle = '#c6cec1';
    ctx.fillStyle = '#68727a';
    ctx.font = '12px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let x = 0; x <= windLength + 0.001; x += step) {
        drawLengthMarker(ctx, x, markerTopY, markerBottomY, labelY);
    }

    if (windLength % step !== 0) {
        drawLengthMarker(ctx, windLength, markerTopY, markerBottomY, labelY);
    }

    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
}

function drawLengthMarker(ctx: CanvasRenderingContext2D, lengthMM: number, markerTopY: number, markerBottomY: number, labelY: number): void {
    const screenX = previewToScreenX(lengthMM);
    ctx.beginPath();
    ctx.moveTo(screenX, markerTopY);
    ctx.lineTo(screenX, markerBottomY);
    ctx.stroke();
    ctx.fillText(`${Math.round(lengthMM)} mm`, screenX, labelY);
}

function getLengthMarkerStep(windLength: number): number {
    const targetMarkerCount = 6;
    const roughStep = windLength / targetMarkerCount;
    const magnitude = 10 ** Math.floor(Math.log10(roughStep));
    for (const multiplier of [1, 2, 5, 10]) {
        const step = multiplier * magnitude;
        if (roughStep <= step) {
            return step;
        }
    }
    return 10 * magnitude;
}

function drawSegment(ctx: CanvasRenderingContext2D, segment: IPreviewSegment, emphasized: boolean): void {
    for (const wrappedSegment of getWrappedSegments(segment)) {
        drawWrappedSegment(ctx, wrappedSegment, emphasized);
    }
    ctx.globalAlpha = 1;
}

function drawWrappedSegment(ctx: CanvasRenderingContext2D, wrappedSegment: IWrappedPreviewSegment, emphasized: boolean): void {
    const segment = wrappedSegment.source;
    const segmentColor = getSegmentColor(segment);
    const towStrokeWidth = getTowStrokeWidth(emphasized);

    strokePreviewLine(ctx, wrappedSegment, segmentColor, towStrokeWidth, emphasized ? 0.95 : 0.56);
    strokeTowEdges(ctx, wrappedSegment, getTowEdgeColor(segmentColor), towStrokeWidth, emphasized ? 0.98 : 0.82);
    ctx.globalAlpha = 1;
}

function strokePreviewLine(
    ctx: CanvasRenderingContext2D,
    wrappedSegment: {start: {x: number; y: number}; end: {x: number; y: number}},
    color: string,
    width: number,
    alpha: number
): void {
    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(previewToScreenX(wrappedSegment.start.x), previewToScreenY(wrappedSegment.start.y));
    ctx.lineTo(previewToScreenX(wrappedSegment.end.x), previewToScreenY(wrappedSegment.end.y));
    ctx.stroke();
}

function strokeTowEdges(
    ctx: CanvasRenderingContext2D,
    wrappedSegment: {start: {x: number; y: number}; end: {x: number; y: number}},
    color: string,
    towWidth: number,
    alpha: number
): void {
    const x1 = previewToScreenX(wrappedSegment.start.x);
    const y1 = previewToScreenY(wrappedSegment.start.y);
    const x2 = previewToScreenX(wrappedSegment.end.x);
    const y2 = previewToScreenY(wrappedSegment.end.y);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length === 0) {
        return;
    }

    const normalX = -dy / length;
    const normalY = dx / length;
    const edgeOffset = towWidth / 2;
    const edgeWidth = Math.max(1, Math.min(2.5, towWidth * 0.08));

    ctx.strokeStyle = color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = edgeWidth;
    for (const sign of [-1, 1]) {
        ctx.beginPath();
        ctx.moveTo(x1 + normalX * edgeOffset * sign, y1 + normalY * edgeOffset * sign);
        ctx.lineTo(x2 + normalX * edgeOffset * sign, y2 + normalY * edgeOffset * sign);
        ctx.stroke();
    }
}

function getTowStrokeWidth(emphasized: boolean): number {
    if (!currentPreview) {
        return 1;
    }

    const towWidth = currentPreview.recipe.windParameters.towParameters.width;
    const highlightBoost = emphasized ? 1.18 : 1;
    return Math.max(2, towWidth * previewView.scale * highlightBoost);
}

function prepareWrappedPreviewSegments(preview: IPreviewResult | null): void {
    wrappedPreviewSegments = [];
    invalidatePreviewLayerCache();

    if (!preview) {
        return;
    }

    for (const segment of preview.plan.previewSegments) {
        const wrappedSegments = splitWrappedSegment(segment).map((wrappedSegment) => ({
            source: segment,
            start: wrappedSegment.start,
            end: wrappedSegment.end
        }));
        wrappedSegmentsBySegment.set(segment, wrappedSegments);
        wrappedPreviewSegments.push(...wrappedSegments);
    }
}

function getWrappedSegments(segment: IPreviewSegment): IWrappedPreviewSegment[] {
    return wrappedSegmentsBySegment.get(segment) || [];
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
        return palette[(getSegmentCircuitIndex(segment) || 0) % palette.length];
    }
    if (previewView.colorMode === 'pass') {
        if (segment.groupKind === 'lock') {
            return '#6f421c';
        }
        return segment.passDirection === 'back' ? '#d1495b' : '#2f6f73';
    }
    return palette[segment.layerIndex % palette.length];
}

function getTowEdgeColor(color: string): string {
    const hexColor = color.replace('#', '');
    const red = Math.max(0, Math.floor(Number.parseInt(hexColor.slice(0, 2), 16) * 0.62));
    const green = Math.max(0, Math.floor(Number.parseInt(hexColor.slice(2, 4), 16) * 0.62));
    const blue = Math.max(0, Math.floor(Number.parseInt(hexColor.slice(4, 6), 16) * 0.62));
    return `rgb(${red}, ${green}, ${blue})`;
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
    return previewDegreesToSurfaceMM(y) * previewView.scale + previewView.offsetY;
}

function previewDegreesToSurfaceMM(degrees: number): number {
    return (degrees / 360) * getPreviewCircumference();
}

function getPreviewCircumference(): number {
    if (!currentPreview) {
        return 360;
    }
    const diameter = currentPreview.recipe.windParameters.mandrelParameters.diameter;
    return Math.PI * diameter;
}

function mod360(value: number): number {
    const result = value % 360;
    return result < 0 ? result + 360 : result;
}

function setPreviewControlsEnabled(enabled: boolean): void {
    const hasPreview = enabled && currentPreview !== null;
    byId<HTMLButtonElement>('fit-preview').disabled = !enabled;
    byId<HTMLButtonElement>('actual-size-preview').disabled = !enabled;
    byId<HTMLButtonElement>('zoom-in-preview').disabled = !enabled;
    byId<HTMLButtonElement>('zoom-out-preview').disabled = !enabled;
    byId<HTMLButtonElement>('show-all-layers').disabled = !enabled;
    byId<HTMLSelectElement>('color-mode').disabled = !enabled;
    byId<HTMLButtonElement>('download-gcode').disabled = !hasPreview;
    byId<HTMLButtonElement>('copy-gcode').disabled = !hasPreview;
}

function resetLayerVisibility(preview: IPreviewResult): void {
    visibleLayerIndexes.clear();
    expandedLayerIndexes.clear();
    hoveredLayerIndex = null;
    selectedLayerIndex = null;
    selectedCircuit = null;
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
    selectedCircuit = null;
    renderLayerTable(currentPreview);
    requestPreviewDraw();
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
            requestPreviewDraw();
        });
        row.addEventListener('mouseleave', () => {
            hoveredLayerIndex = null;
            requestPreviewDraw();
        });
        row.addEventListener('click', () => {
            selectedLayerIndex = selectedLayerIndex === index ? null : index;
            selectedCircuit = null;
            renderLayerTable(preview);
            requestPreviewDraw();
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
            requestPreviewDraw();
        });
        visibilityCell.appendChild(checkbox);

        row.appendChild(visibilityCell);
        row.appendChild(createLayerCell(preview, layer, index));
        row.appendChild(createTextCell(formatLayerParameters(layer)));
        row.appendChild(createTextCell(formatLayerFacts(preview, layer, index)));
        row.appendChild(createTextCell(formatLayerEstimate(preview, index)));
        layerTableBody.appendChild(row);

        if (expandedLayerIndexes.has(index)) {
            layerTableBody.appendChild(createLayerDetailsRow(preview, layer, index));
        }
    });
}

function createLayerCell(preview: IPreviewResult, layer: TLayerParameters, index: number): HTMLTableCellElement {
    const cell = document.createElement('td');
    const wrapper = document.createElement('div');
    wrapper.className = 'layer-cell';

    const expandButton = document.createElement('button');
    expandButton.className = 'expand-layer';
    expandButton.textContent = expandedLayerIndexes.has(index) ? '-' : '+';
    expandButton.addEventListener('click', (event) => {
        event.stopPropagation();
        if (expandedLayerIndexes.has(index)) {
            expandedLayerIndexes.delete(index);
        } else {
            expandedLayerIndexes.add(index);
        }
        renderLayerTable(preview);
    });

    const label = document.createElement('span');
    label.textContent = `${index + 1}: ${layer.windType}`;

    wrapper.appendChild(expandButton);
    wrapper.appendChild(label);
    cell.appendChild(wrapper);
    return cell;
}

function createLayerDetailsRow(preview: IPreviewResult, layer: TLayerParameters, index: number): HTMLTableRowElement {
    const row = document.createElement('tr');
    row.className = 'layer-details-row';
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.appendChild(createLayerDetails(preview, layer, index));
    row.appendChild(cell);
    return row;
}

function createLayerDetails(preview: IPreviewResult, layer: TLayerParameters, index: number): HTMLElement {
    const container = document.createElement('div');
    container.className = 'circuit-list';
    const label = document.createElement('span');
    container.appendChild(label);

    if (layer.windType !== 'helical') {
        label.textContent = 'No generated circuits for this layer.';
        return container;
    }

    const summary = preview.plan.layers.find((layerSummary) => layerSummary.layerIndex === index + 1);
    const circuitCount = summary && summary.circuitCount ? summary.circuitCount : preview.recipe.summary.numCircuits;
    label.textContent = `${circuitCount} circuits`;
    for (let circuitIndex = 0; circuitIndex < circuitCount; circuitIndex++) {
        const button = document.createElement('button');
        button.className = 'circuit-button';
        if (selectedCircuit && selectedCircuit.layerIndex === index && selectedCircuit.circuitIndex === circuitIndex) {
            button.classList.add('selected');
        }
        button.textContent = `${circuitIndex + 1}`;
        button.addEventListener('click', (event) => {
            event.stopPropagation();
            selectedCircuit = selectedCircuit && selectedCircuit.layerIndex === index && selectedCircuit.circuitIndex === circuitIndex
                ? null
                : {layerIndex: index, circuitIndex};
            selectedLayerIndex = null;
            visibleLayerIndexes.add(index);
            renderLayerTable(preview);
            requestPreviewDraw();
        });
        container.appendChild(button);
    }
    return container;
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
        return layer.terminal
            ? 'Final single-pass hoop; uses a fixed 180 deg far-end lock'
            : 'Outer hoop reinforcement; uses fixed 180 deg end locks';
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

function shouldOverlaySegment(segment: IPreviewSegment): boolean {
    return isSegmentSelectedCircuit(segment) || isLayerHighlighted(segment.layerIndex);
}

function isSegmentSelectedCircuit(segment: IPreviewSegment): boolean {
    if (!selectedCircuit || segment.layerIndex !== selectedCircuit.layerIndex) {
        return false;
    }
    return getSegmentCircuitIndex(segment) === selectedCircuit.circuitIndex;
}

function getSegmentCircuitIndex(segment: IPreviewSegment): number | null {
    if (!currentPreview || typeof segment.circuitIndex !== 'number') {
        return null;
    }

    const layer = currentPreview.recipe.windParameters.layers[segment.layerIndex];
    if (!layer || layer.windType !== 'helical') {
        return segment.circuitIndex;
    }
    return ((segment.patternIndex || 0) * layer.patternNumber) + segment.circuitIndex;
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
    for (const wrappedSegment of wrappedPreviewSegments) {
        const segment = wrappedSegment.source;
        if (!visibleLayerIndexes.has(segment.layerIndex)) {
            continue;
        }
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
        const circuitIndex = getSegmentCircuitIndex(segment);
        parts.push(`circuit ${typeof circuitIndex === 'number' ? circuitIndex + 1 : segment.circuitIndex + 1}`);
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

function renderUploadedGCodeStatus(): void {
    const status = byId<HTMLParagraphElement>('uploaded-gcode-status');
    if (!uploadedGCodeFilename) {
        status.textContent = 'No uploaded file selected';
        return;
    }

    const commandCount = countMachineCommands(uploadedGCodeCommands);
    status.textContent = `${uploadedGCodeFilename} | ${commandCount} commands`;
}

function updateRunControls(): void {
    const connected = currentStatus.connected;
    const armed = byId<HTMLInputElement>('arm-run').checked;
    const hasRunnableGCode = getSelectedRunCommands() !== null;
    const runInProgress = currentStatus.totalCommands > 0 && currentStatus.sentCommands < currentStatus.totalCommands;
    const canStopRun = runInProgress || currentStatus.paused || currentStatus.pausing || currentStatus.resuming || currentStatus.stopping;

    byId<HTMLButtonElement>('connect').disabled = connected;
    byId<HTMLButtonElement>('disconnect').disabled = !connected;
    byId<HTMLButtonElement>('clear-recipe').disabled = currentPreview === null || canStopRun || loadedArtifactFilename.length > 0;
    byId<HTMLButtonElement>('save').disabled = currentPreview === null || loadedArtifactFilename.length > 0;
    byId<HTMLInputElement>('artifact-file').disabled = artifactUploadInProgress || loadedArtifactFilename.length > 0 || canStopRun;
    byId<HTMLButtonElement>('discard-artifact').disabled = canStopRun;
    byId<HTMLSelectElement>('run-source').disabled = canStopRun;
    byId<HTMLInputElement>('uploaded-gcode-file').disabled = canStopRun;
    byId<HTMLInputElement>('arm-run').disabled = !hasRunnableGCode || canStopRun;
    byId<HTMLButtonElement>('run').disabled = !connected || !hasRunnableGCode || !armed || canStopRun;
    byId<HTMLButtonElement>('pause').disabled = !connected || !runInProgress || currentStatus.paused || currentStatus.pausing || currentStatus.resuming || currentStatus.stopping;
    byId<HTMLButtonElement>('resume').disabled = !connected || !currentStatus.paused || currentStatus.resuming || currentStatus.stopping;
    byId<HTMLButtonElement>('clear-queue').disabled = !connected || !canStopRun;
}

function getSelectedRunCommands(): string[] | null {
    if (selectedRunSource === 'uploaded') {
        return countMachineCommands(uploadedGCodeCommands) > 0 ? uploadedGCodeCommands : null;
    }

    return currentPreview ? currentPreview.plan.gcode : null;
}

function countMachineCommands(commands: string[]): number {
    return commands.filter((command) => command.trim().length > 0 && command.trim().slice(0, 1) !== ';').length;
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

function updateGCodePanel(preview: IPreviewResult | null): void {
    const gcodePreview = byId<HTMLPreElement>('gcode-preview');
    const downloadButton = byId<HTMLButtonElement>('download-gcode');
    const copyButton = byId<HTMLButtonElement>('copy-gcode');

    if (!preview) {
        gcodePreview.textContent = 'No G-code generated';
        gcodePreview.classList.add('empty');
        downloadButton.disabled = true;
        copyButton.disabled = true;
        clearGCodeToast();
        return;
    }

    gcodePreview.textContent = preview.plan.gcode.join('\n');
    gcodePreview.classList.remove('empty');
    downloadButton.disabled = false;
    copyButton.disabled = false;
}

function syncResponsiveGCodePanel(): void {
    const gcodePane = byId<HTMLDetailsElement>('gcode-pane');
    const stacked = window.innerWidth <= GCODE_STACK_BREAKPOINT_PX;

    if (stacked && !wasGCodePaneStacked) {
        gcodePane.open = false;
    } else if (!stacked) {
        gcodePane.open = true;
    }

    wasGCodePaneStacked = stacked;
}

async function downloadGCodePreview(): Promise<void> {
    if (!currentPreview) {
        return;
    }

    const normalizedFilename = normalizeGCodeFilename(gcodeFilename);
    gcodeFilename = normalizedFilename;
    byId<HTMLInputElement>('gcode-filename').value = normalizedFilename;

    const gcodeText = `${currentPreview.plan.gcode.join('\n')}\n`;
    const blob = new Blob([gcodeText], { type: 'text/plain;charset=utf-8' });
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = downloadUrl;
    link.download = normalizedFilename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(downloadUrl);
}

async function copyGCodePreview(): Promise<void> {
    if (!currentPreview) {
        return;
    }

    const gcodeText = currentPreview.plan.gcode.join('\n');
    try {
        await writeTextToClipboard(gcodeText);
        showGCodeToast('G-code copied to clipboard.');
    } catch (error) {
        setRecipeMessage(getErrorMessage(error));
    }
}

function normalizeGCodeFilename(filename: string): string {
    const sanitized = filename
        .trim()
        .replace(/[\\/:*?"<>|]+/g, '-')
        .replace(/\s+/g, ' ');
    const withFallback = sanitized || DEFAULT_GCODE_FILENAME;
    return /\.gcode$/i.test(withFallback) ? withFallback : `${withFallback}.gcode`;
}

function clearGCodeToast(): void {
    const toast = byId<HTMLDivElement>('gcode-toast');
    toast.classList.remove('visible');
    toast.textContent = '';
    if (gcodeToastTimer !== null) {
        window.clearTimeout(gcodeToastTimer);
        gcodeToastTimer = null;
    }
}

function showGCodeToast(message: string): void {
    clearGCodeToast();
    const toast = byId<HTMLDivElement>('gcode-toast');
    toast.textContent = message;
    toast.classList.add('visible');
    gcodeToastTimer = window.setTimeout(() => {
        toast.classList.remove('visible');
        toast.textContent = '';
        gcodeToastTimer = null;
    }, 1800);
}

async function writeTextToClipboard(text: string): Promise<void> {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(text);
        return;
    }

    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', 'true');
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    textArea.style.position = 'fixed';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    const copied = document.execCommand('copy');
    textArea.remove();
    if (!copied) {
        throw new Error('Could not copy G-code to clipboard.');
    }
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

function getLayerMode(): TLayerMode {
    return byId<HTMLSelectElement>('recipe-method').value as TLayerMode;
}

function readNumber(id: string): number {
    return Number.parseFloat(byId<HTMLInputElement>(id).value);
}

function formatMM(value: number): string {
    return Number.isInteger(value) ? value.toString() : value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
}

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '');
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

function createWebCycloneApi(): ICycloneApi {
    type TEventHandler = (payload: unknown) => void;
    const eventHandlers = new Map<string, Set<TEventHandler>>();
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${protocol}://${window.location.host}/api/events`);

    socket.addEventListener('message', (message) => {
        if (typeof message.data !== 'string') {
            return;
        }
        let parsed: { event?: string; payload?: unknown } | null = null;
        try {
            parsed = JSON.parse(message.data) as { event?: string; payload?: unknown };
        } catch {
            return;
        }
        if (!parsed || typeof parsed.event !== 'string') {
            return;
        }
        const handlers = eventHandlers.get(parsed.event);
        if (!handlers) {
            return;
        }
        handlers.forEach((handler) => handler(parsed?.payload));
    });

    function onEvent(event: string, callback: TEventHandler): () => void {
        const handlers = eventHandlers.get(event) ?? new Set<TEventHandler>();
        handlers.add(callback);
        eventHandlers.set(event, handlers);
        return () => handlers.delete(callback);
    }

    async function postJson<T>(url: string, body: unknown): Promise<T> {
        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        return apiParseResponse<T>(response);
    }

    async function getJson<T>(url: string): Promise<T> {
        const response = await fetch(url);
        return apiParseResponse<T>(response);
    }

    return {
        generatePreview: (request) => postJson('/api/recipe/preview', request),
        generateArtifactPreview: (request) => postJson('/api/artifact/preview', request),
        chooseBasePath: async () => window.prompt('Enter output base path on server (example: /home/pi/jobs/tube1)') ?? null,
        saveArtifacts: (request) => postJson('/api/recipe/artifacts', request),
        listSerialPorts: () => getJson('/api/serial/ports'),
        connectSerial: (request) => postJson('/api/serial/connect', request),
        disconnectSerial: () => postJson('/api/serial/disconnect', {}),
        runGCode: (commands) => postJson('/api/serial/run', { commands }),
        pauseMachine: () => postJson('/api/serial/pause', {}),
        resumeMachine: () => postJson('/api/serial/resume', {}),
        clearMachineQueue: () => postJson('/api/serial/clear', {}),
        onSerialStatus: (callback) => onEvent('serial:status', (payload) => callback(payload as IMarlinStatus)),
        onSerialLog: (callback) => onEvent('serial:log', (payload) => callback(String(payload)))
    };
}

async function apiParseResponse<T>(response: Response): Promise<T> {
    if (!response.ok) {
        const payload = await response.json().catch(() => ({ error: response.statusText }));
        throw new Error((payload as { error?: string }).error ?? response.statusText);
    }
    return response.json() as Promise<T>;
}
