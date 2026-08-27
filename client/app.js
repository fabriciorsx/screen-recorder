import { io } from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";

// ==================================================
// UTILS / LOGGING
// ==================================================
function log(event, data = null) {
    const ts = new Date().toISOString();
    data
        ? console.log(`[CLIENT] [${ts}] ${event}`, data)
        : console.log(`[CLIENT] [${ts}] ${event}`);
}

// ==================================================
// STATE
// ==================================================
let socket = null;
let device = null;
let producerTransport = null;
let consumerTransport = null;

// Agora usamos um array para suportar tanto áudio quanto vídeo
let localProducers = [];
let localStream = null;
let consumers = new Map();

// Mapa para associar producerIds aos socketIds (agrupamento)
let producerToSocket = new Map();

// Stream metadata: key -> { id, label, isLocal, hidden, stream }
let streamsMeta = new Map();

// ==================================================
// UI ELEMENTS
// ==================================================
const ui = {
    joinScreen:       document.getElementById('join-screen'),
    roomScreen:       document.getElementById('room-screen'),
    username:         document.getElementById('username'),
    roomId:           document.getElementById('room-id'),
    btnJoin:          document.getElementById('btn-join'),
    joinError:        document.getElementById('join-error'),
    lblRoom:          document.getElementById('lbl-room'),
    lblParticipants:  document.getElementById('lbl-participants'),
    lblState:         document.getElementById('lbl-state'),
    lblStateMobile:   document.getElementById('lbl-state-mobile'),
    btnShare:         document.getElementById('btn-share'),
    btnStopShare:     document.getElementById('btn-stop-share'),
    btnLeave:         document.getElementById('btn-leave'),
    videoGrid:        document.getElementById('video-grid'),
    videoPlaceholder: document.getElementById('video-placeholder'),
    streamList:       document.getElementById('stream-list'),
    btnMenu:          document.getElementById('btn-menu'),
    sidebar:          document.getElementById('sidebar'),
};

// ==================================================
// SIDEBAR MOBILE TOGGLE
// ==================================================
let sidebarBackdrop = null;

function createBackdrop() {
    if (sidebarBackdrop) return;
    sidebarBackdrop = document.createElement('div');
    sidebarBackdrop.id = 'sidebar-backdrop';
    ui.roomScreen.appendChild(sidebarBackdrop);
    sidebarBackdrop.addEventListener('click', closeSidebar);
}

function openSidebar() {
    createBackdrop();
    ui.sidebar.classList.add('open');
    sidebarBackdrop.classList.add('visible');
}

function closeSidebar() {
    ui.sidebar.classList.remove('open');
    if (sidebarBackdrop) sidebarBackdrop.classList.remove('visible');
}

ui.btnMenu?.addEventListener('click', () => {
    ui.sidebar.classList.contains('open') ? closeSidebar() : openSidebar();
});

// ==================================================
// BUTTON WIRING
// ==================================================
ui.btnJoin.addEventListener('click', joinRoom);
ui.btnShare.addEventListener('click', startScreenShare);
ui.btnStopShare.addEventListener('click', stopScreenShare);
ui.btnLeave.addEventListener('click', leaveRoom);

// ==================================================
// STATE BADGE
// ==================================================
function setStateLabel(text, type = 'connected') {
    const badge = ui.lblState;
    badge.textContent = text;
    badge.className = 'state-badge';
    if (type === 'disconnected') badge.classList.add('disconnected');
    if (type === 'connecting')   badge.classList.add('connecting');

    if (ui.lblStateMobile) {
        ui.lblStateMobile.style.color =
            type === 'connected'  ? 'var(--success)' :
            type === 'connecting' ? '#ffc83c' : 'var(--danger)';
    }
}

// ==================================================
// SOCKET & ROOM LOGIC
// ==================================================
async function joinRoom() {
    const user = ui.username.value.trim();
    const room = ui.roomId.value.trim();
    if (!user || !room) { ui.joinError.innerText = 'Preencha nome e sala.'; return; }

    ui.btnJoin.disabled = true;
    setStateLabel('Conectando...', 'connecting');

    socket = io();

    socket.on('connect', () => {
        log('Socket conectado', { socketId: socket.id });
        setStateLabel('Conectado', 'connected');

        socket.emit('join-room', { roomId: room, username: user }, async (response) => {
            if (response.error) { ui.joinError.innerText = response.error; socket.disconnect(); return; }
            
            log('joinRoom: sucesso', response);
            ui.joinScreen.classList.add('hidden');
            ui.roomScreen.classList.remove('hidden');
            ui.lblRoom.innerText = room;
            ui.lblParticipants.innerText = response.totalParticipants;

            await initMediasoupDevice(response.routerRtpCapabilities);
            await createTransports(response.iceServers);
            
            fetchExistingProducers();
        });
    });

    socket.on('disconnect', () => {
        log('Socket desconectado');
        setStateLabel('Desconectado', 'disconnected');
        resetState();
    });

    socket.on('participant-joined', (data) => {
        ui.lblParticipants.innerText = data.totalParticipants;
    });

    socket.on('participant-left', (data) => {
        ui.lblParticipants.innerText = data.totalParticipants;
    });

    socket.on('screen-sharing-started', async (data) => {
        await consume(data.producerId, data.socketId, data.username);
    });

    socket.on('screen-sharing-stopped', (data) => {
        const remoteSocketId = producerToSocket.get(data.producerId);
        if (remoteSocketId) {
            removeVideoTile(remoteSocketId);
            producerToSocket.delete(data.producerId);
        }
    });
}

function leaveRoom() {
    socket.emit('leave-room');
    socket.disconnect();
    resetState();
    
    ui.roomScreen.classList.add('hidden');
    ui.joinScreen.classList.remove('hidden');
    ui.btnJoin.disabled = false;
    closeSidebar();
}

function resetState() {
    if (localProducers.length > 0) {
        localProducers.forEach(p => p.close());
        localProducers = [];
    }
    if (localStream) { 
        localStream.getTracks().forEach(t => t.stop()); 
        localStream = null; 
    }
    if (producerTransport) { producerTransport.close(); producerTransport = null; }
    if (consumerTransport) { consumerTransport.close(); consumerTransport = null; }

    consumers.forEach(c => c.close());
    consumers.clear();
    streamsMeta.clear();
    producerToSocket.clear();

    const tiles = ui.videoGrid.querySelectorAll('.video-tile');
    tiles.forEach(t => t.remove());
    ui.videoPlaceholder.classList.remove('hidden');
    
    updateGridLayout();
    renderStreamList();
    
    ui.btnShare.classList.remove('hidden');
    ui.btnStopShare.classList.add('hidden');
}

// ==================================================
// MEDIASOUP
// ==================================================
async function initMediasoupDevice(routerRtpCapabilities) {
    try {
        device = new mediasoupClient.Device();
        await device.load({ routerRtpCapabilities });
    } catch (error) {
        log('Erro ao carregar device', error);
    }
}

async function createTransports(iceServers) {
    const prodParams = await requestSocketPromise('create-transport', { direction: 'producer' });
    producerTransport = device.createSendTransport({ ...prodParams.transportOptions, iceServers });
    
    producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        socket.emit('connect-transport', { direction: 'producer', dtlsParameters }, (res) => {
            res.error ? errback(new Error(res.error)) : callback();
        });
    });

    producerTransport.on('produce', async (parameters, callback, errback) => {
        socket.emit('produce', { kind: parameters.kind, rtpParameters: parameters.rtpParameters }, (res) => {
            res.error ? errback(new Error(res.error)) : callback({ id: res.id });
        });
    });

    const consParams = await requestSocketPromise('create-transport', { direction: 'consumer' });
    consumerTransport = device.createRecvTransport({ ...consParams.transportOptions, iceServers });
    
    consumerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        socket.emit('connect-transport', { direction: 'consumer', dtlsParameters }, (res) => {
            res.error ? errback(new Error(res.error)) : callback();
        });
    });
}

function fetchExistingProducers() {
    socket.emit('get-producers', {}, async (res) => {
        for (const prod of res.producers) {
            await consume(prod.producerId, prod.socketId, prod.username);
        }
    });
}

// ==================================================
// SCREEN SHARE
// ==================================================
async function startScreenShare() {
    try {
        localStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        
        // Producer de Vídeo
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.onended = () => stopScreenShare();
            const videoProducer = await producerTransport.produce({ track: videoTrack });
            localProducers.push(videoProducer);
        }
        
        // Producer de Áudio
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            const audioProducer = await producerTransport.produce({ track: audioTrack });
            localProducers.push(audioProducer);
        }

        ui.btnShare.classList.add('hidden');
        ui.btnStopShare.classList.remove('hidden');
        
        addVideoTile('local', localStream, true, 'Você (local)');
    } catch (error) {
        log('startScreenShare: erro', error);
    }
}

function stopScreenShare() {
    if (localProducers.length > 0) {
        localProducers.forEach(p => {
            socket.emit('stop-sharing', { producerId: p.id });
            p.close();
        });
        localProducers = [];
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    removeVideoTile('local');
    ui.btnShare.classList.remove('hidden');
    ui.btnStopShare.classList.add('hidden');
}

// ==================================================
// CONSUME
// ==================================================
async function consume(producerId, remoteSocketId, username) {
    try {
        const { rtpCapabilities } = device;
        const res = await requestSocketPromise('consume', { producerId, rtpCapabilities });
        
        const consumer = await consumerTransport.consume({
            id: res.id,
            producerId: res.producerId,
            kind: res.kind,
            rtpParameters: res.rtpParameters
        });
        
        consumers.set(consumer.id, consumer);
        producerToSocket.set(producerId, remoteSocketId);
        
        let meta = streamsMeta.get(remoteSocketId);
        if (!meta) {
            const stream = new MediaStream([consumer.track]);
            addVideoTile(remoteSocketId, stream, false, username || `Stream ${streamsMeta.size + 1}`);
        } else {
            meta.stream.addTrack(consumer.track);
            const tile = document.getElementById(`tile-${remoteSocketId}`);
            if (tile) {
                tile.querySelectorAll('video').forEach(v => { v.srcObject = meta.stream; });
            }
        }
        
        await requestSocketPromise('resume-consumer', { consumerId: consumer.id });
    } catch (error) {
        log('consume: erro', error);
    }
}

// ==================================================
// VIDEO TILE MANAGEMENT
// ==================================================
function tileId(key, isLocal) {
    return isLocal ? 'tile-local' : `tile-${key}`;
}

function addVideoTile(key, stream, isLocal, label = 'Stream') {
    ui.videoPlaceholder.classList.add('hidden');
    const id = tileId(key, isLocal);
    
    let tile = document.getElementById(id);
    if (!tile) {
        tile = buildTile(id, isLocal, label, key);
        ui.videoGrid.appendChild(tile);
    }
    
    // Set stream on both the tile video and the zoom-canvas video
    const tileVideo = tile.querySelector('.tile-video');
    if (tileVideo) tileVideo.srcObject = stream;
    
    const zoomVideo = tile.querySelector('.zoom-canvas video');
    if (zoomVideo) zoomVideo.srcObject = stream;

    const metaKey = isLocal ? 'local' : key;
    streamsMeta.set(metaKey, { id: metaKey, label, isLocal, hidden: false, stream });
    
    updateGridLayout();
    renderStreamList();
}

function buildTile(id, isLocal, label, key) {
    const tile = document.createElement('div');
    tile.id = id;
    tile.className = 'video-tile' + (isLocal ? ' is-local' : '');
    tile.dataset.key = isLocal ? 'local' : key;

    // --- Zoom canvas (handles zoom/pan, sits behind overlay) ---
    const zoomCanvas = document.createElement('div');
    zoomCanvas.className = 'zoom-canvas';
    
    const zoomVideo = document.createElement('video');
    zoomVideo.autoplay = true;
    zoomVideo.playsInline = true;
    if (isLocal) zoomVideo.muted = true;
    zoomCanvas.appendChild(zoomVideo);
    tile.appendChild(zoomCanvas);

    // Keep a direct reference for thumbnail (hidden by zoom-canvas)
    const tileVideo = document.createElement('video');
    tileVideo.className = 'tile-video';
    tileVideo.autoplay = true;
    tileVideo.playsInline = true;
    tileVideo.muted = true;
    tileVideo.style.display = 'none'; // used only as srcObject ref
    tile.appendChild(tileVideo);

    // --- Tile hover overlay ---
    const overlay = document.createElement('div');
    overlay.className = 'tile-overlay';
    
    overlay.innerHTML = `
        <div class="tile-label">
            <span class="tile-label-text">${label}</span>
            ${isLocal 
                ? '<span class="local-badge">LOCAL</span>' 
                : '<span class="live-badge">LIVE</span>'
            }
        </div>
        <div class="tile-controls">
            <button class="tile-btn btn-fullscreen" title="Tela cheia (F)">
                <svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 3h5v2H5v3H3V3zm9 0h5v5h-2V5h-3V3zM3 12h2v3h3v2H3v-5zm12 3h-3v2h5v-5h-2v3z"/></svg>
            </button>
            <button class="tile-btn btn-hide" title="Ocultar">
                <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd"/><path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z"/></svg>
            </button>
        </div>`;
    
    tile.appendChild(overlay);

    // --- Zoom HUD (visible only in native fullscreen) ---
    const hud = buildZoomHud();
    tile.appendChild(hud);

    // --- Wire up buttons ---
    overlay.querySelector('.btn-fullscreen').addEventListener('click', (e) => {
        e.stopPropagation();
        enterNativeFullscreen(tile);
    });

    overlay.querySelector('.btn-hide').addEventListener('click', (e) => {
        e.stopPropagation();
        const stateKey = isLocal ? 'local' : key;
        toggleStreamVisibility(stateKey);
    });

    // Double-click = native fullscreen
    tile.addEventListener('dblclick', () => enterNativeFullscreen(tile));

    // Zoom/pan on the zoom canvas
    initZoomPan(zoomCanvas, hud);

    return tile;
}

function removeVideoTile(key) {
    const isLocal = key === 'local';
    const id = isLocal ? 'tile-local' : `tile-${key}`;
    const tile = document.getElementById(id);
    
    if (tile) {
        // Exit fullscreen if this tile is the fullscreen element
        if (document.fullscreenElement === tile) document.exitFullscreen().catch(() => {});
        tile.querySelectorAll('video').forEach(v => { v.srcObject = null; });
        tile.remove();
    }
    
    streamsMeta.delete(isLocal ? 'local' : key);

    const tiles = ui.videoGrid.querySelectorAll('.video-tile');
    if (tiles.length === 0) ui.videoPlaceholder.classList.remove('hidden');
    
    updateGridLayout();
    renderStreamList();
}

// Toggle visibility
// When hidden: tile gets .tile-hidden (display:none via CSS),
// but the stream meta stays so the sidebar can show it and re-enable it.
function toggleStreamVisibility(key) {
    const meta = streamsMeta.get(key);
    if (!meta) return;

    const tileId = meta.isLocal ? 'tile-local' : `tile-${key}`;
    const tile = document.getElementById(tileId);
    if (!tile) return;

    meta.hidden = !meta.hidden;

    if (meta.hidden) {
        tile.classList.add('tile-hidden');
        // Pause srcObject to save resources
        tile.querySelectorAll('video').forEach(v => { v.srcObject = null; });
    } else {
        tile.classList.remove('tile-hidden');
        // Restore stream
        tile.querySelectorAll('video').forEach(v => { v.srcObject = meta.stream; });
    }

    updateGridLayout();
    renderStreamList();
}

// ==================================================
// GRID LAYOUT
// ==================================================
function updateGridLayout() {
    const visibleCount = Array.from(streamsMeta.values()).filter(m => !m.hidden).length;
    document.body.dataset.streams = visibleCount;
    
    // Show placeholder only when there are no streams at all (hidden or otherwise)
    const totalTiles = ui.videoGrid.querySelectorAll('.video-tile').length;
    if (totalTiles === 0) {
        ui.videoPlaceholder.classList.remove('hidden');
    } else {
        ui.videoPlaceholder.classList.add('hidden');
    }
}

// ==================================================
// SIDEBAR STREAM LIST
// ==================================================
function renderStreamList() {
    ui.streamList.innerHTML = '';
    
    if (streamsMeta.size === 0) {
        const li = document.createElement('li');
        li.className = 'stream-list-empty';
        li.textContent = 'Nenhuma stream ativa';
        ui.streamList.appendChild(li);
        return;
    }

    streamsMeta.forEach((meta) => {
        const li = document.createElement('li');
        li.className = 'stream-list-item' + (meta.hidden ? ' hidden-stream' : '');
        
        const eyeOnSvg = `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 12a2 2 0 100-4 2 2 0 000 4z"/><path fill-rule="evenodd" d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z" clip-rule="evenodd"/></svg>`;
        const eyeOffSvg = `<svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M3.707 2.293a1 1 0 00-1.414 1.414l14 14a1 1 0 001.414-1.414l-1.473-1.473A10.014 10.014 0 0019.542 10C18.268 5.943 14.478 3 10 3a9.958 9.958 0 00-4.512 1.074l-1.78-1.781zm4.261 4.26l1.514 1.515a2.003 2.003 0 012.45 2.45l1.514 1.514a4 4 0 00-5.478-5.478z" clip-rule="evenodd"/><path d="M12.454 16.697L9.75 13.992a4 4 0 01-3.742-3.741L2.335 6.578A9.98 9.98 0 00.458 10c1.274 4.057 5.065 7 9.542 7 .847 0 1.669-.105 2.454-.303z"/></svg>`;
        const fsSvg = `<svg viewBox="0 0 20 20" fill="currentColor"><path d="M3 3h5v2H5v3H3V3zm9 0h5v5h-2V5h-3V3zM3 12h2v3h3v2H3v-5zm12 3h-3v2h5v-5h-2v3z"/></svg>`;
        
        li.innerHTML = `
            <span class="stream-dot"></span>
            <span class="stream-name">${meta.label}</span>
            <div class="stream-actions">
                <button class="stream-btn-toggle" title="${meta.hidden ? 'Mostrar stream' : 'Ocultar stream'}">
                    ${meta.hidden ? eyeOnSvg : eyeOffSvg}
                </button>
                <button class="stream-btn-fs" title="Tela cheia" ${meta.hidden ? 'disabled' : ''}>
                    ${fsSvg}
                </button>
            </div>`;
            
        li.querySelector('.stream-btn-toggle').addEventListener('click', (e) => {
            e.stopPropagation();
            toggleStreamVisibility(meta.id);
        });

        li.querySelector('.stream-btn-fs').addEventListener('click', (e) => {
            e.stopPropagation();
            if (meta.hidden) return;
            const tileEl = document.getElementById(meta.isLocal ? 'tile-local' : `tile-${meta.id}`);
            if (tileEl) enterNativeFullscreen(tileEl);
        });

        ui.streamList.appendChild(li);
    });
}

// ==================================================
// NATIVE FULLSCREEN (Fullscreen API - like YouTube)
// ==================================================
function enterNativeFullscreen(tileEl) {
    const req = tileEl.requestFullscreen?.bind(tileEl) 
        || tileEl.webkitRequestFullscreen?.bind(tileEl) 
        || tileEl.mozRequestFullScreen?.bind(tileEl);
        
    if (req) req().catch(err => log('Fullscreen error', err));
}

// When exiting fullscreen, reset zoom/pan for that tile
document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) {
        // Reset any active zoom state on all tiles
        document.querySelectorAll('.zoom-canvas').forEach(canvas => {
            setTileZoom(canvas, 1, 0, 0, false);
        });
    }
});

// ==================================================
// ZOOM / PAN PER TILE
// ==================================================
const ZOOM_MIN  = 1;
const ZOOM_MAX  = 5;
const ZOOM_STEP = 0.3;

function buildZoomHud() {
    const hud = document.createElement('div');
    hud.className = 'zoom-hud';
    hud.innerHTML = `
        <button class="zoom-hud-btn hud-zoom-out" title="Diminuir zoom (-)">
            <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/><path d="M5 8h6" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>
        </button>
        <span class="zoom-hud-level">100%</span>
        <button class="zoom-hud-btn hud-zoom-in" title="Aumentar zoom (+)">
            <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clip-rule="evenodd"/><path d="M8 5v6M5 8h6" stroke="white" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>
        </button>
        <button class="zoom-hud-btn hud-zoom-reset" title="Resetar zoom (0)">
            <svg viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z" clip-rule="evenodd"/></svg>
        </button>`;
    return hud;
}

function setTileZoom(canvas, scale, px, py, animate) {
    const video = canvas.querySelector('video');
    if (!video) return;

    if (animate) {
        video.style.transition = 'transform 180ms ease';
        setTimeout(() => { video.style.transition = 'none'; }, 190);
    } else {
        video.style.transition = 'none';
    }

    video.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) scale(${scale})`;
    
    // Update cursor
    canvas.classList.toggle('zoomable', scale > 1);
    canvas.classList.remove('grabbing');

    // Update HUD label
    const tile = canvas.closest('.video-tile');
    const hud = tile?.querySelector('.zoom-hud-level');
    if (hud) hud.textContent = Math.round(scale * 100) + '%';
}

function initZoomPan(canvas, hud) {
    let scale = 1, px = 0, py = 0;
    let isDragging = false, startX, startY, startPx, startPy;

    function applyZoom(newScale, animate = true) {
        scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, newScale));
        if (scale === 1) { px = 0; py = 0; }
        setTileZoom(canvas, scale, px, py, animate);
    }

    // Only active when the tile is in fullscreen
    function isInFullscreen() {
        const tile = canvas.closest('.video-tile');
        return document.fullscreenElement === tile;
    }

    // Wheel zoom
    canvas.addEventListener('wheel', (e) => {
        if (!isInFullscreen()) return;
        e.preventDefault();
        applyZoom(scale + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    }, { passive: false });

    // Mouse drag pan
    canvas.addEventListener('mousedown', (e) => {
        if (!isInFullscreen() || scale <= 1) return;
        isDragging = true;
        startX = e.clientX; startY = e.clientY;
        startPx = px; startPy = py;
        canvas.classList.add('grabbing');
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        px = startPx + (e.clientX - startX);
        py = startPy + (e.clientY - startY);
        setTileZoom(canvas, scale, px, py, false);
    });

    document.addEventListener('mouseup', () => {
        isDragging = false;
        canvas.classList.remove('grabbing');
    });

    // Touch pinch-zoom + pan
    let lastDist = null, startTouchPx, startTouchPy;
    
    canvas.addEventListener('touchstart', (e) => {
        if (!isInFullscreen()) return;
        if (e.touches.length === 2) {
            lastDist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX, 
                e.touches[0].clientY - e.touches[1].clientY
            );
            startTouchPx = px; startTouchPy = py;
        } else if (e.touches.length === 1 && scale > 1) {
            isDragging = true;
            startX = e.touches[0].clientX; startY = e.touches[0].clientY;
            startPx = px; startPy = py;
        }
    }, { passive: true });

    canvas.addEventListener('touchmove', (e) => {
        if (!isInFullscreen()) return;
        if (e.touches.length === 2 && lastDist !== null) {
            e.preventDefault();
            const dist = Math.hypot(
                e.touches[0].clientX - e.touches[1].clientX, 
                e.touches[0].clientY - e.touches[1].clientY
            );
            applyZoom(scale + (dist - lastDist) / 150, false);
            lastDist = dist;
        } else if (e.touches.length === 1 && isDragging) {
            px = startPx + (e.touches[0].clientX - startX);
            py = startPy + (e.touches[0].clientY - startY);
            setTileZoom(canvas, scale, px, py, false);
        }
    }, { passive: false });

    canvas.addEventListener('touchend', () => { lastDist = null; isDragging = false; });

    // HUD buttons
    hud.querySelector('.hud-zoom-in').addEventListener('click',    (e) => { e.stopPropagation(); applyZoom(scale + ZOOM_STEP); });
    hud.querySelector('.hud-zoom-out').addEventListener('click',   (e) => { e.stopPropagation(); applyZoom(scale - ZOOM_STEP); });
    hud.querySelector('.hud-zoom-reset').addEventListener('click', (e) => { e.stopPropagation(); scale = 1; px = 0; py = 0; applyZoom(1); });

    // Keyboard shortcuts when in fullscreen
    document.addEventListener('keydown', (e) => {
        const tile = canvas.closest('.video-tile');
        if (document.fullscreenElement !== tile) return;
        
        switch (e.key) {
            case 'Escape': document.exitFullscreen().catch(() => {}); break;
            case '+': case '=': applyZoom(scale + ZOOM_STEP); break;
            case '-':           applyZoom(scale - ZOOM_STEP); break;
            case '0':           scale = 1; px = 0; py = 0; applyZoom(1); break;
        }
    });
}

// ==================================================
// SOCKET PROMISE HELPER
// ==================================================
function requestSocketPromise(event, data) {
    return new Promise((resolve, reject) => {
        socket.emit(event, data, (response) => {
            if (response && response.error) reject(new Error(response.error));
            else resolve(response);
        });
    });
}