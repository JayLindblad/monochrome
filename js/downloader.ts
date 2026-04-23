import { ffmpegNewContainer } from './ffmpeg.js';
import { addMetadataWithTagLib } from './taglib.ts';

const CLIENT_ID = 'txNoH4kkV41MfH25';
const CLIENT_SECRET = 'dQjy0MinCEvxi1O4UmxvxWnDjt4cgHBPw8ll6nYBk98=';
const PROXY = 'https://audio-proxy.binimum.org/proxy-audio?url=';

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken!;
    const res = await fetch('https://auth.tidal.com/v1/oauth2/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + btoa(`${CLIENT_ID}:${CLIENT_SECRET}`),
        },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID }),
    });
    if (!res.ok) throw new Error(`Auth failed: ${res.status}`);
    const data = await res.json();
    cachedToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
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

function proxyUrlFn(url: string): string {
    if (url.startsWith('blob:')) return url;
    return `${PROXY}${encodeURIComponent(url)}`;
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

    for (let i = 0; i < urls.length; i++) {
        onProgress(i / urls.length);
        const res = await fetch(proxyUrlFn(urls[i]));
        if (!res.ok) throw new Error(`Segment ${i} fetch failed: ${res.status}`);
        chunks.push(await res.arrayBuffer());
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
        setStatus('Authenticating…', 0);
        const [meta, playback] = await Promise.all([
            tidalGet(`/v1/tracks/${trackId}/`, { countryCode: 'US' }) as Promise<TrackMeta>,
            tidalGet(`/v1/tracks/${trackId}/playbackinfo`, {
                audioquality: 'LOSSLESS',
                playbackmode: 'STREAM',
                assetpresentation: 'FULL',
                countryCode: 'US',
            }) as Promise<PlaybackInfo>,
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
        const raw = atob(currentPlayback.manifest);
        let manifestXml: string;

        if (raw.trimStart().startsWith('<')) {
            manifestXml = raw;
        } else {
            // JSON manifest with urls array
            const parsed = JSON.parse(raw) as { urls?: string[] };
            if (parsed.urls?.[0]) {
                const res = await fetch(proxyUrlFn(parsed.urls[0]));
                manifestXml = await res.text();
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
