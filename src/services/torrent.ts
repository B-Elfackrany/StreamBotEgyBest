import WebTorrent from 'webtorrent-hybrid';
import fs from 'fs';
import path from 'path';
import config from '../config.js';
import logger from '../utils/logger.js';
import { MediaSource } from '../types/index.js';

export class TorrentService {
    private client: WebTorrent.Instance;
    private torrentsDir: string;

    constructor() {
        this.client = new WebTorrent();
        this.torrentsDir = config.torrentsDir;

        // Ensure torrents directory exists
        if (!fs.existsSync(this.torrentsDir)) {
            fs.mkdirSync(this.torrentsDir, { recursive: true });
        }
    }

    /**
     * Adds a torrent and returns a MediaSource with a localhost HTTP URL.
     * @param url Magnet link or .torrent file URL
     */
    public async resolveTorrentSource(url: string): Promise<MediaSource | null> {
        const TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
        const PROGRESS_INTERVAL_MS = 5000; // Log progress every 5 seconds

        return new Promise((resolve) => {
            let resolved = false;
            let progressInterval: ReturnType<typeof setInterval> | null = null;
            let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

            const cleanup = () => {
                if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
                if (timeoutHandle) { clearTimeout(timeoutHandle); timeoutHandle = null; }
            };

            const done = (result: MediaSource | null) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                resolve(result);
            };

            try {
                // Auto-fix malformed magnet links missing the '?' after 'magnet:'
                if (url.startsWith('magnet:') && !url.startsWith('magnet:?')) {
                    url = 'magnet:?' + url.slice('magnet:'.length);
                    logger.info(`[Torrent] Fixed malformed magnet link`);
                }

                // Add reliable fallback trackers (WebSocket & HTTP) to bypass ISP blocking
                if (url.startsWith('magnet:')) {
                    const fallbackTrackers = [
                        // WebSocket trackers (bypasses ISP UDP blocks)
                        'wss://tracker.openwebtorrent.com',
                        'wss://tracker.webtorrent.dev',
                        'wss://tracker.files.fm:7073/announce',
                        'wss://tracker.btorrent.xyz',
                        // Reliable HTTP/UDP fallbacks
                        'http://tracker.opentrackr.org:1337/announce',
                        'udp://tracker.openbittorrent.com:80/announce',
                        'udp://tracker.coppersurfer.tk:6969/announce',
                        'udp://tracker.leechers-paradise.org:6969/announce'
                    ];

                    for (const tracker of fallbackTrackers) {
                        const encodedTracker = encodeURIComponent(tracker);
                        if (!url.includes(encodedTracker)) {
                            url += `&tr=${encodedTracker}`;
                        }
                    }
                }

                logger.info(`[Torrent] Adding torrent: ${url.substring(0, 80)}...`);
                logger.info(`[Torrent] Connecting to peers and fetching metadata...`);

                const torrent = this.client.add(url, { path: this.torrentsDir }, (torrent) => {
                    logger.info(`[Torrent] Metadata ready: "${torrent.name}" | Files: ${torrent.files.length} | Total size: ${(torrent.length / 1024 / 1024).toFixed(1)} MB`);

                    // Find the largest file (main video)
                    const file = torrent.files.reduce((a, b) => (a.length > b.length ? a : b));
                    if (!file) {
                        logger.error(`[Torrent] No files found in torrent: ${torrent.name}`);
                        done(null);
                        return;
                    }

                    logger.info(`[Torrent] Selected file: "${file.name}" (${(file.length / 1024 / 1024).toFixed(1)} MB)`);
                    logger.info(`[Torrent] Starting HTTP stream server...`);

                    const server = torrent.createServer();
                    server.listen(0, () => {
                        const port = (server.address() as any).port;
                        const streamUrl = `http://localhost:${port}/0`;

                        // Calculate buffer target: 50MB or 5% of file size, whichever is smaller
                        const MIN_BUFFER_MB = 50;
                        const BUFFER_PERCENT = 0.05;
                        const fileMb = file.length / 1024 / 1024;
                        const targetBufferMb = Math.min(MIN_BUFFER_MB, fileMb * BUFFER_PERCENT);

                        logger.info(`[Torrent] HTTP stream server started on port ${port}. Waiting for ${(targetBufferMb).toFixed(1)} MB buffer...`);

                        // If file is tiny or already buffered, start immediately
                        if (fileMb <= targetBufferMb || (torrent.downloaded / 1024 / 1024) >= targetBufferMb) {
                            logger.info(`[Torrent] Buffer target reached — ready to stream`);
                            done({
                                url: streamUrl,
                                title: torrent.name || 'Torrent Video',
                                type: 'torrent',
                                torrentId: torrent.infoHash
                            });
                            return;
                        }

                        // Wait for buffer target
                        const checkBuffer = () => {
                            const downloadedMb = torrent.downloaded / 1024 / 1024;
                            if (downloadedMb >= targetBufferMb || torrent.progress === 1) {
                                torrent.removeListener('download', checkBuffer);
                                logger.info(`[Torrent] Buffer target reached (${downloadedMb.toFixed(1)} MB) — ready to stream`);
                                done({
                                    url: streamUrl,
                                    title: torrent.name || 'Torrent Video',
                                    type: 'torrent',
                                    torrentId: torrent.infoHash
                                });
                            }
                        };

                        torrent.on('download', checkBuffer);
                    });
                });

                // --- Progress logging ---
                let metadataReceived = false;
                let isBuffering = false;

                torrent.on('infoHash', () => {
                    logger.info(`[Torrent] InfoHash resolved: ${torrent.infoHash}`);
                });

                torrent.on('metadata', () => {
                    metadataReceived = true;
                    isBuffering = true;
                    logger.info(`[Torrent] Metadata downloaded successfully`);
                });

                torrent.on('ready', () => {
                    logger.info(`[Torrent] Ready: "${torrent.name}" — starting download/buffer`);
                });

                torrent.on('warning', (warn: any) => {
                    logger.warn(`[Torrent] Warning: ${warn}`);
                });

                // Pre-stream progress (while adding & fetching metadata + initial buffer)
                progressInterval = setInterval(() => {
                    const peers = torrent.numPeers;
                    const dlSpeed = (torrent.downloadSpeed / 1024).toFixed(1);
                    const progress = (torrent.progress * 100).toFixed(1);
                    const downloaded = (torrent.downloaded / 1024 / 1024).toFixed(1);
                    const total = (torrent.length / 1024 / 1024).toFixed(1);

                    let status = 'Fetching metadata';
                    if (metadataReceived) {
                        status = resolved ? 'Downloading' : 'Buffering';
                    }

                    logger.info(`[Torrent] [${status}] ${progress}% | ${downloaded}/${total} MB | Speed: ${dlSpeed} KB/s | Peers: ${peers}`);
                }, PROGRESS_INTERVAL_MS);

                // Continue logging download progress after streaming begins (every 10s)
                const DOWNLOAD_LOG_INTERVAL_MS = 10000;
                let downloadInterval: ReturnType<typeof setInterval> | null = null;

                torrent.on('ready', () => {
                    downloadInterval = setInterval(() => {
                        if (torrent.progress >= 1) return; // already complete
                        const peers = torrent.numPeers;
                        const dlSpeed = (torrent.downloadSpeed / 1024).toFixed(1);
                        const upSpeed = (torrent.uploadSpeed / 1024).toFixed(1);
                        const progress = (torrent.progress * 100).toFixed(1);
                        const downloaded = (torrent.downloaded / 1024 / 1024).toFixed(1);
                        const total = (torrent.length / 1024 / 1024).toFixed(1);
                        const remaining = torrent.timeRemaining
                            ? `${(torrent.timeRemaining / 1000).toFixed(0)}s remaining`
                            : 'calculating...';
                        logger.info(`[Torrent] [Streaming] ${progress}% | ${downloaded}/${total} MB | ↓ ${dlSpeed} KB/s | ↑ ${upSpeed} KB/s | Peers: ${peers} | ETA: ${remaining}`);
                    }, DOWNLOAD_LOG_INTERVAL_MS);
                });

                // Log when download completes
                torrent.on('done', () => {
                    logger.info(`[Torrent] Download complete: "${torrent.name}" | Total: ${(torrent.length / 1024 / 1024).toFixed(1)} MB`);
                    if (downloadInterval) { clearInterval(downloadInterval); downloadInterval = null; }
                });

                // --- Timeout ---
                timeoutHandle = setTimeout(() => {
                    if (!resolved) {
                        logger.error(`[Torrent] Timed out after ${TIMEOUT_MS / 1000}s — no metadata received. Peers found: ${torrent.numPeers}`);
                        try { torrent.destroy({ destroyStore: true }); } catch (_) { }
                        if (downloadInterval) { clearInterval(downloadInterval); downloadInterval = null; }
                        done(null);
                    }
                }, TIMEOUT_MS);

                torrent.on('error', (err) => {
                    logger.error(`[Torrent] Error: ${err}`);
                    if (downloadInterval) { clearInterval(downloadInterval); downloadInterval = null; }
                    done(null);
                });

            } catch (err) {
                logger.error(`[Torrent] Failed to add torrent:`, err);
                done(null);
            }
        });
    }

    /**
     * Stops downloading and removes a torrent.
     * @param torrentId The infoHash of the torrent to remove
     */
    public removeTorrent(torrentId: string): void {
        try {
            const torrent = this.client.get(torrentId);
            if (torrent) {
                // Destroy the torrent instance and delete the downloaded files
                torrent.destroy({ destroyStore: true }, (err) => {
                    if (err) {
                        logger.error(`Error destroying torrent ${torrentId}:`, err);
                    } else {
                        logger.info(`Removed torrent and cleaned up files: ${torrentId}`);
                    }
                });
            }
        } catch (error) {
            logger.error(`Failed to remove torrent ${torrentId}:`, error);
        }
    }

    /**
     * Stops torrents and cleanup.
     */
    public destroy(): void {
        this.client.destroy((err) => {
            if (err) {
                logger.error('Error destroying WebTorrent client:', err);
            } else {
                logger.info('WebTorrent client destroyed successfully.');
            }
        });
    }
}
