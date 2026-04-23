import { ffmpeg } from './ffmpeg.js';
import { addMetadataWithTagLib } from './taglib.ts';

const CLIENT_ID = 'txNoH4kkV41MfH25';
const CLIENT_SECRET = 'dQjy0MinCEvxi1O4UmxvxWnDjt4cgHBPw8ll6nYBk98=';
const PROXY = 'https://audio-proxy.binimum.org/proxy-audio?url=';

// ─── Community proxy instances (hold subscriber tokens → assetPresentation=FULL) ─

const UPTIME_URLS = [
    'https://tidal-uptime.jiffy-puffs-1j.workers.dev/',
    'https://tidal-uptime.props-76styles.workers.dev/',
];
const FALLBACK_INSTANCES = [
    'https://eu-central.monochrome.tf',
    'https://us-west.monochrome.tf',
    'https://arran.monochrome.tf',
    'https://triton.squid.wtf',
    'https://api.monochrome.tf',
    'https://monochrome-api.samidy.com',
    'https://maus.qqdl.site',
    'https://vogel.qqdl.site',
    'https://katze.qqdl.site',
    'https://hund.qqdl.site',
    'https://tidal.kinoplus.online',
    'https://wolf.qqdl.site',
];

let cachedInstances: string[] | null = null;

async function getProxyInstances(): Promise<string[]> {
    if (cachedInstances) return cachedInstances;
    const urls = [...UPTIME_URLS].sort(() => Math.random() - 0.5);
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok) continue;
            const data = await res.json() as { api?: ({ url?: string } | string)[] };
            const list = (data.api ?? [])
                .map((i) => typeof i === 'string' ? i : (i.url ?? ''))
                .filter(Boolean);
            if (list.length) { cachedInstances = list; dbg(`Got ${list.length} instances from uptime`); return list; }
        } catch { /* try next uptime URL */ }
    }
    dbg('Uptime fetch failed, using fallback instance list');
    cachedInstances = FALLBACK_INSTANCES;
    return FALLBACK_INSTANCES;
}

async function proxyFetch(path: string): Promise<Response> {
    const instances = await getProxyInstances();
    let lastErr: Error = new Error('No proxy instances available');
    for (const base of instances) {
        const url = base.endsWith('/') ? `${base}${path.slice(1)}` : `${base}${path}`;
        dbg(`Proxy attempt: ${url}`);
        try {
            const res = await fetch(url);
            if (res.ok) { dbg(`Proxy hit: ${url}`); return res; }
            dbg(`Proxy ${url} → ${res.status}`);
            lastErr = new Error(`HTTP ${res.status} from ${base}`);
        } catch (e) {
            dbg(`Proxy ${base} threw: ${(e as Error).message}`);
            lastErr = e as Error;
        }
    }
    throw lastErr;
}

// ─── Auth (client credentials — for metadata only) ───────────────────────────

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiry) { dbg('Auth: using cached token'); return cachedToken!; }
    dbg('Auth: fetching client credentials token…');
    const res = await fetch('https://auth.tidal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID }),
    });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    const d = await res.json();
    cachedToken = d.access_token;
    tokenExpiry = Date.now() + (d.expires_in - 60) * 1000;
    dbg(`Auth: token OK, expires in ${d.expires_in}s`);
    return cachedToken!;
}

async function tidalGet(path: string, params: Record<string, string> = {}): Promise<unknown> {
    const token = await getToken();
    const url = new URL(path.startsWith('http') ? path : `https://api.tidal.com${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`TIDAL ${res.status}: ${url.pathname}`);
    return res.json();
}

// Playback info must go through the community proxy — client_credentials always
// returns assetPresentation=PREVIEW regardless of the assetpresentation param.
// The proxy instances hold subscriber tokens and return FULL manifests.
async function getFullPlaybackInfo(id: string, quality = 'LOSSLESS'): Promise<PlaybackInfo> {
    dbg(`Fetching playback info via proxy (quality=${quality})…`);
    const res = await proxyFetch(`/track/?id=${id}&quality=${quality}`);
    const json = await res.json() as { version?: string; data?: PlaybackInfo } | PlaybackInfo;
    // Proxy may wrap response in { version, data } envelope
    const data = ('data' in json && json.data ? json.data : json) as PlaybackInfo;
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
    assetPresentation?: string;
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
            getFullPlaybackInfo(trackId, 'HI_RES_LOSSLESS'),
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
        const isLossy = q === 'HIGH' || q === 'LOW';
        qualityBadge.textContent = q.replace(/_/g, ' ');
        qualityBadge.className = 'quality-badge ' + (q.includes('HI_RES') ? 'hires' : isLossy ? 'lossy' : 'lossless');

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
        let rawBlob: Blob;

        if (raw.trimStart().startsWith('<')) {
            // Inline DASH XML
            dbg('Manifest type: DASH XML (inline)');
            setStatus('Downloading audio segments…', 5);
            rawBlob = await downloadDash(raw, (pct) => {
                setStatus(`Downloading audio… ${Math.round(pct * 100)}%`, 5 + pct * 60);
            });
        } else {
            const parsed = JSON.parse(raw) as { mimeType?: string; urls?: string[]; codecs?: string };
            dbg(`Manifest type: JSON, mimeType=${parsed.mimeType ?? 'none'}, codecs=${parsed.codecs ?? 'none'}`);
            dbg(`Manifest urls[0]: ${(parsed.urls?.[0] ?? 'none').slice(0, 80)}…`);
            if (!parsed.urls?.[0]) throw new Error('Unsupported manifest format — no urls');

            if (parsed.mimeType?.startsWith('audio/')) {
                // BTS format (application/vnd.tidal.bts): urls[] is the actual audio file, not a manifest
                dbg('Manifest type: BTS (direct audio), downloading…');
                setStatus('Downloading audio…', 5);
                const audioRes = await fetch(parsed.urls[0]);
                if (!audioRes.ok) throw new Error(`Audio fetch failed: ${audioRes.status}`);
                rawBlob = new Blob([await audioRes.arrayBuffer()], { type: parsed.mimeType });
                dbg(`BTS download complete: ${rawBlob.size} bytes, type=${parsed.mimeType}`);
                setStatus('Downloading audio…', 65);
            } else {
                // urls[] points to a remote DASH manifest XML
                dbg(`Fetching remote DASH manifest: ${parsed.urls[0].slice(0, 80)}…`);
                const mRes = await fetch(parsed.urls[0]);
                if (!mRes.ok) throw new Error(`Manifest fetch failed: ${mRes.status}`);
                const manifestXml = await mRes.text();
                dbg(`Remote manifest (first 200): ${manifestXml.slice(0, 200)}`);
                setStatus('Downloading audio segments…', 5);
                rawBlob = await downloadDash(manifestXml, (pct) => {
                    setStatus(`Downloading audio… ${Math.round(pct * 100)}%`, 5 + pct * 60);
                });
            }
        }

        // Re-encode to FLAC — using -c:a flac (not -c copy) resets DASH timestamp offsets to 0
        setStatus('Encoding to FLAC…', 67);
        const flacBlob = await ffmpeg(rawBlob, {
            args: ['-map_metadata', '-1', '-c:a', 'flac'],
            outputName: 'output.flac',
            outputMime: 'audio/flac',
        });

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
