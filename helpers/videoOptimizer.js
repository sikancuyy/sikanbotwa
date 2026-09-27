const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { resolveBinary, deleteFileSafe, log } = require('../utils');

/**
 * Concurrency limiter khusus proses FFmpeg untuk mencegah VPS CPU 100% / OOM.
 * Maksimal 2 proses FFmpeg bersamaan.
 */
class FFmpegQueue {
  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
  }

  enqueue(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.dequeue();
    });
  }

  dequeue() {
    if (this.activeCount >= this.maxConcurrent || this.queue.length === 0) return;
    const { fn, resolve, reject } = this.queue.shift();
    this.activeCount++;

    fn()
      .then(resolve)
      .catch(reject)
      .finally(() => {
        this.activeCount--;
        this.dequeue();
      });
  }
}

const ffmpegQueue = new FFmpegQueue(2);

/**
 * Mencari path ffprobe di sistem.
 */
function resolveFfprobe() {
  const isWindows = process.platform === 'win32';
  const ffmpegPath = resolveBinary(config.ffmpeg);
  if (ffmpegPath && fs.existsSync(ffmpegPath)) {
    const candidateSameDir = path.join(path.dirname(ffmpegPath), isWindows ? 'ffprobe.exe' : 'ffprobe');
    if (fs.existsSync(candidateSameDir)) {
      return candidateSameDir;
    }
  }

  return resolveBinary({
    command: process.env.FFPROBE_PATH || 'ffprobe',
    localCandidates: [
      path.join(__dirname, '..', isWindows ? 'ffprobe.exe' : 'ffprobe'),
      path.join(__dirname, '..', 'bin', isWindows ? 'ffprobe.exe' : 'ffprobe')
    ]
  });
}

/**
 * Memeriksa metadata file video menggunakan ffprobe secara akurat & cepat.
 * @param {string} filePath Path file video
 * @returns {Promise<object|null>} Metadata video
 */
function probeVideo(filePath) {
  return new Promise((resolve) => {
    if (!filePath || !fs.existsSync(filePath)) return resolve(null);

    const ffprobeBin = resolveFfprobe();
    if (!ffprobeBin) return resolve(null);

    const args = [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      filePath
    ];

    let stdout = '';
    const proc = spawn(ffprobeBin, args, { windowsHide: true });

    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch (_) {}
      resolve(null);
    }, 15000);

    proc.stdout.on('data', (d) => { stdout += d.toString(); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      try {
        const parsed = JSON.parse(stdout);
        const format = parsed.format || {};
        const streams = parsed.streams || [];

        const videoStream = streams.find((s) => s.codec_type === 'video');
        const audioStream = streams.find((s) => s.codec_type === 'audio');

        resolve({
          container: (format.format_name || '').toLowerCase(),
          duration: parseFloat(format.duration || videoStream?.duration || 0),
          fileSize: parseInt(format.size || 0, 10) || (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0),
          videoCodec: (videoStream?.codec_name || '').toLowerCase(),
          audioCodec: (audioStream?.codec_name || '').toLowerCase(),
          width: parseInt(videoStream?.width || 0, 10),
          height: parseInt(videoStream?.height || 0, 10),
          pixFmt: videoStream?.pix_fmt || '',
          hasAudio: !!audioStream
        });
      } catch (_) {
        resolve(null);
      }
    });

    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

/**
 * Memeriksa apakah video sudah memenuhi standar kompatibilitas WhatsApp untuk Fast Path:
 * - Kontainer: MP4 / QuickTime
 * - Video Codec: H.264 / AVC
 * - Audio Codec: AAC / MP4A (atau tanpa audio)
 * - Ukuran file aman (<= maxSizeBytes)
 * - Resolusi wajar
 * - Khusus TikTok / Fast Download: Ukuran <= 6 MB dan <= 720p agar penerima WhatsApp dapat mengunduh dalam 1-2 detik.
 * 
 * @param {object} meta Metadata hasil ffprobe
 * @param {number} maxSizeBytes Batas ukuran bytes
 * @param {object} [options={}] Opsi tambahan
 */
function isWhatsAppCompatible(meta, maxSizeBytes, options = {}) {
  if (!meta) return false;

  const validContainers = ['mp4', 'mov', 'm4v'];
  const isMp4Container = validContainers.some((c) => meta.container.includes(c));
  if (!isMp4Container) return false;

  // Video Codec H.264 / AVC
  const isH264 = meta.videoCodec === 'h264' || meta.videoCodec === 'avc1';
  if (!isH264) return false;

  // Format pixel wajib 8-bit yuv420p agar tidak error decoding di pemutar Android / iOS WhatsApp
  if (meta.pixFmt && meta.pixFmt !== 'yuv420p') return false;

  // Audio Codec AAC jika video memiliki track audio
  if (meta.hasAudio) {
    const isAac = meta.audioCodec === 'aac' || meta.audioCodec === 'mp4a';
    if (!isAac) return false;
  }

  const isTikTok = !!(options.isTikTok || options.platform === 'tiktok');

  if (isTikTok) {
    const isPortrait = meta.height > meta.width;
    // Jika TikTok vertikal > 720p atau horizontal > 720p, kompres agar lebih cepat diunduh
    if (isPortrait && (meta.width > 720 || meta.height > 1280)) return false;
    if (!isPortrait && (meta.width > 1280 || meta.height > 720)) return false;

    // Untuk TikTok, batas Fast Path adalah 6 MB.
    // Jika ukuran asli di atas 6 MB, kompres agar menjadi 2-5 MB sehingga download di HP user instan.
    const tiktokFastPathLimit = Math.min(maxSizeBytes, 6 * 1024 * 1024);
    if (meta.fileSize > tiktokFastPathLimit) return false;
  } else {
    // Resolusi standar umum tidak melebihi 1080p
    if (meta.height > 1080 || meta.width > 1920) return false;

    // Ukuran aman untuk pemutaran video in-chat WhatsApp (maks 20 MB)
    const safePlaybackLimit = Math.min(maxSizeBytes, 20 * 1024 * 1024);
    if (meta.fileSize > safePlaybackLimit) return false;
  }

  return true;
}

/**
 * Kompresi adaptif dan konversi video ke standar WhatsApp yang kompatibel secara optimal.
 * Mendukung optimasi khusus TikTok (rasio vertikal 9:16, CRF 27, 720p max, faststart)
 * agar ukuran file menjadi ramping (2-6 MB) dan proses download user di WhatsApp jauh lebih cepat.
 * 
 * @param {string} inputPath Path file asli
 * @param {object} meta Metadata hasil ffprobe
 * @param {number} targetMaxBytes Batas ukuran target
 * @param {string} requestId ID tracking log
 * @param {object} [options={}] Opsi tambahan (isTikTok, fastDownload, dll)
 * @returns {Promise<{ filePath: string, fileSize: number, isConverted: boolean }>}
 */
function executeCompression(inputPath, meta, targetMaxBytes, requestId, options = {}) {
  return ffmpegQueue.enqueue(() => {
    return new Promise((resolve, reject) => {
      const ffmpegBin = resolveBinary(config.ffmpeg);
      if (!ffmpegBin) {
        return reject(new Error('FFmpeg tidak ditemukan di server.'));
      }

      const ext = path.extname(inputPath) || '.mp4';
      const outputPath = path.join(
        config.downloadDir || path.dirname(inputPath),
        `opt_${path.basename(inputPath, ext)}_${Date.now()}.mp4`
      );

      const duration = meta?.duration || 0;
      const isTikTok = !!(options.isTikTok || options.platform === 'tiktok' || (inputPath && /tt_|tiktok/i.test(path.basename(inputPath))));
      const isPortrait = meta && meta.height > meta.width;

      let videoFilter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'; // Pastikan dimensi genap untuk x264

      if (isTikTok) {
        // OPTIMASI KHUSUS TIKTOK:
        // Video TikTok mayoritas vertikal (9:16). Menurunkan lebar ke 720p (720x1280) memangkas pixel >55%,
        // membuat proses encode FFmpeg 2.5x lebih cepat dan ukuran file menyusut ke 2-5 MB.
        if (isPortrait) {
          if (meta?.fileSize > 25 * 1024 * 1024 || duration > 120) {
            videoFilter = "scale='min(576,iw)':-2"; // 576x1024 untuk file besar / durasi panjang
          } else {
            videoFilter = "scale='min(720,iw)':-2"; // 720x1280 untuk kualitas jernih & download cepat
          }
        } else {
          // TikTok horizontal
          videoFilter = "scale='min(1280,iw)':-2";
        }
      } else if (meta && (meta.height > 1080 || meta.width > 1920 || meta.fileSize > targetMaxBytes)) {
        if (isPortrait) {
          videoFilter = meta.fileSize > 35 * 1024 * 1024 ? "scale='min(576,iw)':-2" : "scale='min(720,iw)':-2";
        } else {
          if (meta.height > 720 || meta.fileSize > 20 * 1024 * 1024) {
            videoFilter = "scale='min(1280,iw)':-2"; // Turunkan ke maks 720p
          }
          if (meta.fileSize > 40 * 1024 * 1024 || (duration > 180 && meta.fileSize > targetMaxBytes)) {
            videoFilter = "scale='min(854,iw)':-2"; // Turunkan ke 480p jika file sangat besar
          }
        }
      }

      // Konfigurasi Bitrate & CRF:
      let videoBitrateArgs = ['-crf', '26'];

      if (isTikTok) {
        // Profil TikTok: CRF 27 memberikan ketajaman tinggi di layar HP dengan bitrate ekonomis (~900-1200 kbps),
        // menghasilkan video ringan (2-6 MB) yang terunduh dalam sekejap di WhatsApp.
        videoBitrateArgs = [
          '-crf', '27',
          '-maxrate', '1200k',
          '-bufsize', '2400k'
        ];
      } else if (duration > 0 && meta && meta.fileSize > targetMaxBytes) {
        // Alokasikan 85% dari batas untuk headroom aman
        const targetBytes = Math.floor(targetMaxBytes * 0.85);
        const totalBitrate = Math.floor((targetBytes * 8) / duration);
        const audioBitrate = 96000;
        const calcVideoBitrate = Math.max(250000, totalBitrate - audioBitrate);
        videoBitrateArgs = [
          '-b:v', `${Math.min(calcVideoBitrate, 1500000)}`,
          '-maxrate', `${Math.min(calcVideoBitrate * 1.3, 2000000)}`,
          '-bufsize', `${Math.min(calcVideoBitrate * 2, 3000000)}`
        ];
      }

      const args = [
        '-y',
        '-i', inputPath,
        '-vf', videoFilter,
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-profile:v', 'main',
        '-level', '3.1',
        '-pix_fmt', 'yuv420p',
        ...videoBitrateArgs,
        '-c:a', 'aac',
        '-b:a', '96k',
        '-ar', '44100',
        '-movflags', '+faststart', // moov atom di depan agar WhatsApp dapat memutar secara streaming instan
        '-threads', '2',
        outputPath
      ];

      const profileLabel = isTikTok ? 'TIKTOK-FAST' : 'STANDARD';
      log('INFO', `[${requestId}] [COMPRESS] START FFmpeg encoding (${profileLabel}) -> ${path.basename(outputPath)}`);

      let stderr = '';
      const proc = spawn(ffmpegBin, args, { windowsHide: true });

      const timer = setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch (_) {}
        deleteFileSafe(outputPath);
        reject(new Error('Kompresi video timeout (>180 detik).'));
      }, 180000);

      proc.stderr.on('data', (d) => { stderr += d.toString(); });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && fs.existsSync(outputPath)) {
          const stats = fs.statSync(outputPath);
          log('SUCCESS', `[${requestId}] [COMPRESS] COMPLETE: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
          resolve({
            filePath: outputPath,
            fileSize: stats.size,
            isConverted: true
          });
        } else {
          deleteFileSafe(outputPath);
          log('ERROR', `[${requestId}] [COMPRESS] FAILED (code ${code}): ${stderr.slice(-200)}`);
          reject(new Error(`Konversi FFmpeg gagal (exit code: ${code})`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        deleteFileSafe(outputPath);
        reject(err);
      });
    });
  });
}

/**
 * Pipeline Pemeriksaan dan Optimasi Video untuk WhatsApp (Section C, D, J, M)
 * 1. Cek metadata file video via ffprobe
 * 2. FAST PATH: Jika MP4, H.264, AAC, dan ukuran aman -> langsung kirim original tanpa FFmpeg
 * 3. COMPRESSION / CONVERSION: Jika tidak kompatibel atau terlalu besar -> kompresi adaptif otomatis
 * 
 * @param {string} inputFilePath Path file video hasil download
 * @param {string} [requestId='opt'] ID request untuk logging
 * @param {number} [customMaxMB] Batas ukuran kustom dalam MB
 * @param {object} [options={}] Opsi tambahan (isTikTok, fastDownload, dll)
 * @returns {Promise<{ filePath: string, fileSize: number, isOriginal: boolean, fastPath: boolean, title?: string }>}
 */
async function processVideoForWhatsApp(inputFilePath, requestId = 'media', customMaxMB = null, options = {}) {
  if (!inputFilePath || !fs.existsSync(inputFilePath)) {
    throw new Error('File video tidak ditemukan untuk diproses.');
  }

  const stat = fs.statSync(inputFilePath);
  const isTikTok = !!(options.isTikTok || options.platform === 'tiktok' || (inputFilePath && /tt_|tiktok/i.test(path.basename(inputFilePath))));
  const mergedOptions = { ...options, isTikTok };

  const defaultMaxMB = isTikTok ? 8 : (config.maxFileSizeMB || 65);
  const targetMaxMB = customMaxMB || Math.min(defaultMaxMB, isTikTok ? 8 : 20);
  const maxBytes = targetMaxMB * 1024 * 1024;
  const initialSizeMB = (stat.size / 1024 / 1024).toFixed(2);

  log('INFO', `[${requestId}] [CHECK] Memeriksa kompatibilitas video (${initialSizeMB} MB, isTikTok=${isTikTok})`);

  const meta = await probeVideo(inputFilePath);

  if (meta) {
    const vCodec = (meta.videoCodec || 'unknown').toUpperCase();
    const aCodec = (meta.audioCodec || (meta.hasAudio ? 'unknown' : 'none')).toUpperCase();
    log('INFO', `[${requestId}] [CHECK] codec=${vCodec} audio=${aCodec} size=${initialSizeMB} MB dim=${meta.width}x${meta.height}`);

    // FAST PATH: Jika sudah memenuhi standar dan ukurannya aman (<= 6 MB untuk TikTok)
    if (isWhatsAppCompatible(meta, maxBytes, mergedOptions)) {
      log('INFO', `[${requestId}] [FAST PATH] Video memenuhi standar kompatibilitas WhatsApp (${initialSizeMB} MB). Mengirim file langsung.`);
      return {
        filePath: inputFilePath,
        fileSize: stat.size,
        isOriginal: true,
        fastPath: true
      };
    }
  } else {
    // Jika ffprobe gagal membaca tetapi ekstensi .mp4 dan ukuran sangat kecil (<= 4 MB)
    if (inputFilePath.toLowerCase().endsWith('.mp4') && stat.size <= 4 * 1024 * 1024) {
      log('INFO', `[${requestId}] [FAST PATH] Metadata tidak terbaca tetapi format .mp4 aman. Mengirim file.`);
      return {
        filePath: inputFilePath,
        fileSize: stat.size,
        isOriginal: true,
        fastPath: true
      };
    }
  }

  // Jalankan kompresi adaptif untuk memastikan video cepat diunduh dan diputar di WhatsApp
  log('INFO', `[${requestId}] [COMPRESS] Mengompres video agar ringan & cepat diunduh di WhatsApp...`);
  const result = await executeCompression(inputFilePath, meta, maxBytes, requestId, mergedOptions);

  return {
    filePath: result.filePath,
    fileSize: result.fileSize,
    isOriginal: false,
    fastPath: false
  };
}

module.exports = {
  probeVideo,
  isWhatsAppCompatible,
  processVideoForWhatsApp,
  executeCompression,
  resolveFfprobe
};
