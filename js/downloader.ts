import { ffmpegNewContainer } from './ffmpeg.js';
import { addMetadataWithTagLib } from './taglib.ts';

const CLIENT_ID = 'txNoH4kkV41MfH25';
const CLIENT_SECRET = 'dQjy0MinCEvxi1O4UmxvxWnDjt4cgHBPw8ll6nYBk98=';
const PROXY = 'https://audio-proxy.binimum.org/proxy-audio?url=';
const LS_KEY = 'monochrome_dl_user_token';

// ─── User auth (device code flow) ────────────────────────────────────────────

interface StoredToken {
    access_token: string;
    refresh_token: string;
    expires_at: number;
}

function loadStoredToken(): StoredToken | null {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? 'null'); } catch { return null; }
}

function saveToken(t: StoredToken): void {
    localStorage.setItem(LS_KEY, JSON.stringify(t));
}

function clearToken(): void {
    localStorage.removeItem(LS_KEY);
}

async function refreshUserToken(refreshToken: string): Promise<StoredToken> {
    const res = await fetch('https://auth.tidal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
        },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    if (!res.ok) { clearToken(); throw new Error(`Token refresh failed: ${res.status}`); }
    const d = await res.json();
    const stored: StoredToken = {
        access_token: d.access_token,
        refresh_token: d.refresh_token ?? refreshToken,
        expires_at: Date.now() + (d.expires_in - 60) * 1000,
    };
    saveToken(stored);
    return stored;
}

async function getUserToken(): Promise<string | null> {
    let stored = loadStoredToken();
    if (!stored) return null;
    if (Date.now() >= stored.expires_at) {
        dbg('User token expired, refreshing…');
        try { stored = await refreshUserToken(stored.refresh_token); }
        catch { return null; }
    }
    return stored.access_token;
}

// Device code login — returns when user completes auth or throws on timeout
export async function startDeviceLogin(
    onCode: (userCode: string, verificationUrl: string) => void
): Promise<void> {
    const res = await fetch('https://auth.tidal.com/v1/oauth2/device_authorization', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
        },
        body: new URLSearchParams({ client_id: CLIENT_ID, scope: 'r_usr w_usr' }),
    });
    if (!res.ok) throw new Error(`Device auth failed: ${res.status}`);
    const d = await res.json();
    dbg(`Device code: ${d.user_code}, expires in ${d.expires_in}s, poll every ${d.interval}s`);
    onCode(d.user_code, d.verification_uri_complete ?? 'https://tidal.com/activate');

    const interval = (d.interval ?? 5) * 1000;
    const deadline = Date.now() + d.expires_in * 1000;

    while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, interval));
        const poll = await fetch('https://auth.tidal.com/v1/oauth2/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
            },
            body: new URLSearchParams({
                grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
                device_code: d.device_code,
                client_id: CLIENT_ID,
            }),
        });
        if (poll.status === 400) continue; // authorization_pending
        if (!poll.ok) throw new Error(`Poll failed: ${poll.status}`);
        const t = await poll.json();
        saveToken({
            access_token: t.access_token,
            refresh_token: t.refresh_token,
            expires_at: Date.now() + (t.expires_in - 60) * 1000,
        });
        dbg('User login complete, token saved');
        return;
    }
    throw new Error('Login timed out — please try again');
}

// ─── Shared token getter (user token preferred, falls back to client creds) ──

let clientToken: string | null = null;
let clientTokenExpiry = 0;

async function getClientToken(): Promise<string> {
    if (clientToken && Date.now() < clientTokenExpiry) return clientToken!;
    dbg('Fetching client credentials token…');
    const res = await fetch('https://auth.tidal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID }),
    });
    if (!res.ok) throw new Error(`Client auth failed: ${res.status}`);
    const d = await res.json();
    clientToken = d.access_token;
    clientTokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
    dbg(`Client token OK (expires in ${d.expires_in}s)`);
    return clientToken!;
}

async function getBestToken(): Promise<{ token: string; isUser: boolean }> {
    const user = await getUserToken();
    if (user) { dbg('Using user token'); return { token: user, isUser: true }; }
    dbg('No user token — using client credentials (metadata only)');
    return { token: await getClientToken(), isUser: false };
}

async function tidalGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const { token } = await getBestToken();
    const url = new URL(path.startsWith('http') ? path : `https://api.tidal.com${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`TIDAL ${res.status}: ${url.pathname}`);
    return res.json();
}

async function getFullPlaybackInfo(id: string, quality = 'LOSSLESS'): Promise<PlaybackInfo> {
    const { token, isUser } = await getBestToken();
    if (!isUser) throw new Error('TIDAL login required for full track access. Please log in first.');
    dbg(`Fetching playback info directly from TIDAL (quality=${quality})…`);
    const url = new URL(`https://api.tidal.com/v1/tracks/${id}/playbackinfo`);
    url.searchParams.set('audioquality', quality);
    url.searchParams.set('playbackmode', 'STREAM');
    url.searchParams.set('assetpresentation', 'FULL');
    url.searchParams.set('countryCode', 'US');
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
        const body = await res.text().catch(() => '');
        dbg(`Playback info ${res.status}: ${body.slice(0, 200)}`);
        throw new Error(`Playback info failed: ${res.status}`);
    }
    const data = await res.json() as PlaybackInfo;
    dbg(`assetPresentation=${data.assetPresentation} audioQuality=${data.audioQuality} bitDepth=${data.bitDepth} sampleRate=${data.sampleRate}`);
    return data;
}

function parseTidalId(input: string): string | null {
    const patterns = [
        /tidal\.com\/browse\/track\/(\d+)/,
        /listen\.tidal\.com\/album\/\d+\/track\/(\d+)/,
        /tidal\.com\/track\/(\d+)/,
        /tidal\.com\/album\/\d+\/track\/(\d+)/,
        /tidal\.com\/.*?\/(\d+)/,
    ];
    for (const p of patterns) {
        const m = input.match(p);
        if (m) return m[1];
    }
    if (/^\d+$/.test(input.trim())) return input.trim();
    return null;
}

function coverUrl(uuid: string, size = 1280): string {
    return `https://resources.tidal.com/images/${uuid.replace(/-/g, '/')}/${size}x${size}.jpg`;
}

async function fetchSegment(url: string, idx: number): Promise<ArrayBuffer> {
    // 1. Direct fetch — CloudFront signed URLs are self-contained; CORS is open for audio CDNs
    dbg(`Seg[${idx}] trying direct: ${url.slice(0, 80)}…`);
    try {
        const res = await fetch(url);
        if (res.ok) { dbg(`Seg[${idx}] direct OK (${res.status})`); return res.arrayBuffer(); }
        dbg(`Seg[${idx}] direct failed: ${res.status}`);
    } catch (e) {
        dbg(`Seg[${idx}] direct threw: ${(e as Error).message}`);
    }

    // 2. Proxy with encodeURIComponent so ?Policy=… stays inside the url= param
    const encodedProxy = `${PROXY}${encodeURIComponent(url)}`;
    dbg(`Seg[${idx}] trying encoded proxy…`);
    try {
        const res = await fetch(encodedProxy);
        if (res.ok) { dbg(`Seg[${idx}] encoded proxy OK`); return res.arrayBuffer(); }
        dbg(`Seg[${idx}] encoded proxy failed: ${res.status}`);
    } catch (e) {
        dbg(`Seg[${idx}] encoded proxy threw: ${(e as Error).message}`);
    }

    // 3. Proxy raw (legacy behaviour, may lose auth params)
    const rawProxy = `${PROXY}${url}`;
    dbg(`Seg[${idx}] trying raw proxy…`);
    const res = await fetch(rawProxy);
    const hdrs: string[] = [];
    res.headers.forEach((v, k) => hdrs.push(`${k}: ${v}`));
    dbg(`Seg[${idx}] raw proxy ${res.status} — headers: ${hdrs.join(' | ')}`);
    if (res.ok) return res.arrayBuffer();
    throw new Error(`Segment ${idx} failed on all strategies (last: ${res.status})`);
}

// ─── Debug log ───────────────────────────────────────────────────────────────
const debugLines: string[] = [];
function dbg(msg: string): void {
    const ts = new Date().toISOString().slice(11, 23);
    const line = `[${ts}] ${msg}`;
    debugLines.push(line);
    console.log(line);
    const el = document.getElementById('debug-log');
    if (el) {
        el.textContent = debugLines.slice(-80).join('\n');
        el.scrollTop = el.scrollHeight;
    }
}

function resolveTemplate(tpl: string, repId: string, num: number, time: number): string {
    return tpl
        .replace('$RepresentationID$', repId)
        .replace(/\$Number(%0(\d+)d)?\$/g, (_, fmt, width) =>
            width ? String(num).padStart(parseInt(width), '0') : String(num)
        )
        .replace(/\$Time\$/g, String(time));
}

function joinUrl(base: string, part: string): string {
    if (!base) return part;
    if (part.startsWith('http')) return part;
    return base.endsWith('/') ? base + part : base + '/' + part;
}

async function downloadDash(manifestXml: string, onProgress: (pct: number) => void): Promise<Blob> {
    const doc = new DOMParser().parseFromString(manifestXml, 'text/xml');
    const mpd = doc.querySelector('MPD');
    if (!mpd) throw new Error('Invalid DASH manifest: no MPD element');

    const period = mpd.querySelector('Period');
    if (!period) throw new Error('Invalid DASH manifest: no Period');

    const adaptationSets = [...period.querySelectorAll('AdaptationSet')];
    const audioSet =
        adaptationSets.find((a) => a.getAttribute('mimeType')?.startsWith('audio')) ?? adaptationSets[0];
    if (!audioSet) throw new Error('No AdaptationSet found');

    const reps = [...audioSet.querySelectorAll('Representation')].sort(
        (a, b) =>
            parseInt(b.getAttribute('bandwidth') ?? '0') - parseInt(a.getAttribute('bandwidth') ?? '0')
    );
    const rep = reps[0];
    if (!rep) throw new Error('No Representation found');

    const segTemplate =
        rep.querySelector('SegmentTemplate') ?? audioSet.querySelector('SegmentTemplate');
    if (!segTemplate) throw new Error('No SegmentTemplate found');

    const baseUrlEl =
        rep.querySelector('BaseURL') ??
        audioSet.querySelector('BaseURL') ??
        period.querySelector('BaseURL') ??
        mpd.querySelector('BaseURL');
    const baseUrl = baseUrlEl?.textContent?.trim() ?? '';

    const initTpl = segTemplate.getAttribute('initialization');
    const mediaTpl = segTemplate.getAttribute('media');
    const startNum = parseInt(segTemplate.getAttribute('startNumber') ?? '1');
    const repId = rep.getAttribute('id') ?? '';

    const timeline = [...segTemplate.querySelectorAll('S')];
    const segments: { number: number; time: number }[] = [];
    let t = parseInt(segTemplate.getAttribute('startTime') ?? '0');
    let num = startNum;
    for (const s of timeline) {
        const st = s.getAttribute('t');
        if (st) t = parseInt(st);
        const r = parseInt(s.getAttribute('r') ?? '0') + 1;
        const d = parseInt(s.getAttribute('d') ?? '0');
        for (let i = 0; i < r; i++) {
            segments.push({ number: num++, time: t });
            t += d;
        }
    }

    const urls: string[] = [];
    if (initTpl) urls.push(joinUrl(baseUrl, resolveTemplate(initTpl, repId, 0, 0)));
    if (mediaTpl) {
        for (const seg of segments) {
            urls.push(joinUrl(baseUrl, resolveTemplate(mediaTpl, repId, seg.number, seg.time)));
        }
    }

    const mimeType = audioSet.getAttribute('mimeType') ?? 'audio/mp4';
    const chunks: ArrayBuffer[] = [];

    dbg(`DASH: ${urls.length} segments, mimeType=${mimeType}`);
    dbg(`DASH seg[0] raw: ${urls[0]}`);
    dbg(`DASH seg[0] encoded-proxy: ${PROXY}${encodeURIComponent(urls[0]).slice(0, 80)}…`);

    for (let i = 0; i < urls.length; i++) {
        onProgress(i / urls.length);
        const buf = await fetchSegment(urls[i], i);
        dbg(`Seg[${i}] received ${buf.byteLength} bytes`);
        chunks.push(buf);
    }
    onProgress(1);

    return new Blob(chunks, { type: mimeType });
}

function triggerDownload(blob: Blob, filename: string): void {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function sanitizeFilename(s: string): string {
    return s.replace(/[/\\:*?"<>|]/g, '_').trim();
}

// ─── UI wiring ───────────────────────────────────────────────────────────────

const loginBtn = document.getElementById('login-btn') as HTMLButtonElement;
const logoutBtn = document.getElementById('logout-btn') as HTMLButtonElement;
const loginStatus = document.getElementById('login-status') as HTMLElement;
const deviceCodeWrap = document.getElementById('device-code-wrap') as HTMLElement;
const deviceCodeEl = document.getElementById('device-code') as HTMLElement;

async function updateLoginUI(): Promise<void> {
    const token = await getUserToken();
    if (token) {
        loginStatus.textContent = 'Logged in to TIDAL ✓';
        loginStatus.style.color = '#4cde80';
        loginBtn.hidden = true;
        logoutBtn.hidden = false;
        deviceCodeWrap.hidden = true;
    } else {
        loginStatus.textContent = 'Not logged in — full track download requires TIDAL login.';
        loginStatus.style.color = '#666';
        loginBtn.hidden = false;
        logoutBtn.hidden = true;
    }
}

loginBtn.addEventListener('click', async () => {
    loginBtn.disabled = true;
    loginBtn.textContent = 'Starting…';
    try {
        await startDeviceLogin((code, url) => {
            deviceCodeWrap.hidden = false;
            deviceCodeEl.textContent = code;
            loginStatus.textContent = 'Waiting for TIDAL login…';
            loginBtn.hidden = true;
        });
        await updateLoginUI();
    } catch (e) {
        loginStatus.textContent = `Login failed: ${(e as Error).message}`;
        loginStatus.style.color = '#e05555';
        deviceCodeWrap.hidden = true;
        loginBtn.disabled = false;
        loginBtn.textContent = 'Login';
    }
});

logoutBtn.addEventListener('click', () => {
    clearToken();
    updateLoginUI();
});

updateLoginUI();

const input = document.getElementById('track-url') as HTMLInputElement;
const fetchBtn = document.getElementById('fetch-btn') as HTMLButtonElement;
const card = document.getElementById('track-card') as HTMLDivElement;
const coverImg = document.getElementById('cover-img') as HTMLImageElement;
const titleEl = document.getElementById('track-title') as HTMLElement;
const artistEl = document.getElementById('track-artist') as HTMLElement;
const albumEl = document.getElementById('track-album') as HTMLElement;
const qualityBadge = document.getElementById('quality-badge') as HTMLElement;
const techEl = document.getElementById('track-tech') as HTMLElement;
const downloadBtn = document.getElementById('download-btn') as HTMLButtonElement;
const progressWrap = document.getElementById('progress-wrap') as HTMLDivElement;
const progressBar = document.getElementById('progress-bar') as HTMLProgressElement;
const statusEl = document.getElementById('status-text') as HTMLElement;
const errorEl = document.getElementById('error-msg') as HTMLElement;

interface TrackMeta {
    id: number;
    title: string;
    version?: string;
    artists: { name: string }[];
    album: { title: string; cover: string };
    duration: number;
    audioQuality: string;
    isrc?: string;
    trackNumber?: number;
}

interface PlaybackInfo {
    bitDepth?: number;
    sampleRate?: number;
    audioQuality: string;
    manifest: string;
    manifestMimeType: string;
}

let currentMeta: TrackMeta | null = null;
let currentPlayback: PlaybackInfo | null = null;

function setStatus(msg: string, pct?: number): void {
    statusEl.textContent = msg;
    if (pct !== undefined) {
        progressBar.value = pct;
        progressBar.style.setProperty('--pct', `${pct}%`);
    }
    progressWrap.hidden = false;
}

function showError(msg: string): void {
    errorEl.textContent = msg;
    errorEl.hidden = false;
}

function clearError(): void {
    errorEl.textContent = '';
    errorEl.hidden = true;
}

fetchBtn.addEventListener('click', async () => {
    clearError();
    card.hidden = true;
    progressWrap.hidden = true;

    const raw = input.value.trim();
    const trackId = parseTidalId(raw);
    if (!trackId) {
        showError('Could not parse a track ID from that URL. Try a link like https://tidal.com/browse/track/12345678');
        return;
    }

    fetchBtn.disabled = true;
    fetchBtn.textContent = 'Fetching…';

    try {
        setStatus('Fetching track info…', 0);
        const [meta, playback] = await Promise.all([
            tidalGet(`/v1/tracks/${trackId}/`, { countryCode: 'US' }) as Promise<TrackMeta>,
            getFullPlaybackInfo(trackId),
        ]);

        currentMeta = meta;
        currentPlayback = playback;

        const artists = meta.artists?.map((a) => a.name).join(', ') ?? 'Unknown Artist';
        const displayTitle = meta.version ? `${meta.title} (${meta.version})` : meta.title;

        coverImg.src = coverUrl(meta.album.cover, 640);
        titleEl.textContent = displayTitle;
        artistEl.textContent = artists;
        albumEl.textContent = meta.album.title;

        const q = playback.audioQuality ?? meta.audioQuality;
        qualityBadge.textContent = q.replace('_', ' ');
        qualityBadge.className = 'quality-badge ' + (q.includes('HI_RES') ? 'hires' : 'lossless');

        const bd = playback.bitDepth ?? '—';
        const sr = playback.sampleRate ? (playback.sampleRate / 1000).toFixed(1) + ' kHz' : '—';
        techEl.textContent = `${bd}-bit · ${sr}`;

        card.hidden = false;
        progressWrap.hidden = true;
    } catch (err) {
        showError(`Failed to fetch track: ${(err as Error).message}`);
    } finally {
        fetchBtn.disabled = false;
        fetchBtn.textContent = 'Fetch';
    }
});

downloadBtn.addEventListener('click', async () => {
    if (!currentMeta || !currentPlayback) return;

    clearError();
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Downloading…';

    try {
        // Decode the Base64 manifest
        setStatus('Decoding manifest…', 2);
        dbg(`Playback: quality=${currentPlayback.audioQuality}, bitDepth=${currentPlayback.bitDepth}, sampleRate=${currentPlayback.sampleRate}`);
        dbg(`Manifest mimeType: ${currentPlayback.manifestMimeType}`);
        const raw = atob(currentPlayback.manifest);
        dbg(`Manifest decoded (first 200 chars): ${raw.slice(0, 200)}`);
        let manifestXml: string;

        if (raw.trimStart().startsWith('<')) {
            dbg('Manifest type: DASH XML (inline)');
            manifestXml = raw;
        } else {
            const parsed = JSON.parse(raw) as { urls?: string[] };
            dbg(`Manifest type: JSON, urls=${JSON.stringify(parsed.urls?.slice(0, 2))}`);
            if (parsed.urls?.[0]) {
                dbg(`Fetching manifest from URL: ${parsed.urls[0]}`);
                const res = await fetch(parsed.urls[0]);
                dbg(`Manifest fetch: HTTP ${res.status}`);
                manifestXml = await res.text();
                dbg(`Manifest XML (first 200 chars): ${manifestXml.slice(0, 200)}`);
            } else {
                throw new Error('Unsupported manifest format');
            }
        }

        // Download DASH segments
        setStatus('Downloading audio segments…', 5);
        const rawBlob = await downloadDash(manifestXml, (pct) => {
            setStatus(`Downloading audio… ${Math.round(pct * 100)}%`, 5 + pct * 60);
        });

        // Remux to FLAC container
        setStatus('Remuxing to FLAC…', 67);
        const flacBlob = await ffmpegNewContainer(rawBlob, 'flac', 'audio/flac', null, null);

        // Fetch cover art for embedding
        setStatus('Embedding metadata…', 80);
        const coverData = await (async () => {
            try {
                const res = await fetch(coverUrl(currentMeta!.album.cover, 1280));
                return new Uint8Array(await res.arrayBuffer());
            } catch {
                return null;
            }
        })();

        const flacArray = new Uint8Array(await flacBlob.arrayBuffer());
        const artists = currentMeta.artists?.map((a) => a.name).join(', ') ?? '';
        const albumArtist = currentMeta.artists?.[0]?.name ?? '';

        const taggedArray = await addMetadataWithTagLib(
            flacArray,
            {
                title: currentMeta.version
                    ? `${currentMeta.title} (${currentMeta.version})`
                    : currentMeta.title,
                artist: artists,
                albumTitle: currentMeta.album.title,
                albumArtist,
                trackNumber: currentMeta.trackNumber,
                isrc: currentMeta.isrc,
                ...(coverData ? { cover: { data: coverData, type: 'image/jpeg' } } : {}),
            },
            'track.flac',
            false,
            false,
            120_000
        );

        setStatus('Saving file…', 97);
        const filename = sanitizeFilename(
            `${artists} - ${currentMeta.version ? `${currentMeta.title} (${currentMeta.version})` : currentMeta.title}.flac`
        );

        const finalBlob = taggedArray instanceof Uint8Array
            ? new Blob([taggedArray], { type: 'audio/flac' })
            : (taggedArray as Blob);

        triggerDownload(finalBlob, filename);
        setStatus('Done!', 100);
    } catch (err) {
        showError(`Download failed: ${(err as Error).message}`);
        setStatus('', 0);
        progressWrap.hidden = true;
    } finally {
        downloadBtn.disabled = false;
        downloadBtn.textContent = 'Download FLAC';
    }
});

// Allow pressing Enter in the input
input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') fetchBtn.click();
});
