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
 * - Resolusi wajar (<= 1080p)
 */
function isWhatsAppCompatible(meta, maxSizeBytes) {
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

  // Resolusi tidak melebihi 1080p
  if (meta.height > 1080 || meta.width > 1920) return false;

  // Ukuran aman untuk pemutaran video in-chat WhatsApp di Android & iOS (maksimal 20 MB agar tidak ditolak pemutar HP)
  const safePlaybackLimit = Math.min(maxSizeBytes, 20 * 1024 * 1024);
  if (meta.fileSize > safePlaybackLimit) return false;

  return true;
}

/**
 * Kompresi adaptif dan konversi video ke standar WhatsApp yang kompatibel secara optimal.
 * @param {string} inputPath Path file asli
 * @param {object} meta Metadata hasil ffprobe
 * @param {number} targetMaxBytes Batas ukuran target
 * @param {string} requestId ID tracking log
 * @returns {Promise<{ filePath: string, fileSize: number, isConverted: boolean }>}
 */
function executeCompression(inputPath, meta, targetMaxBytes, requestId) {
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
      let videoFilter = 'scale=trunc(iw/2)*2:trunc(ih/2)*2'; // Pastikan dimensi genap untuk x264

      // Smart Resolution: Turunkan dimensi jika video besar atau resolusi tinggi
      if (meta && (meta.height > 1080 || meta.fileSize > targetMaxBytes)) {
        if (meta.height > 720 || meta.fileSize > 20 * 1024 * 1024) {
          videoFilter = "scale='min(1280,iw)':-2"; // Turunkan ke maks 720p
        }
        if (meta.fileSize > 40 * 1024 * 1024 || (duration > 180 && meta.fileSize > targetMaxBytes)) {
          videoFilter = "scale='min(854,iw)':-2"; // Turunkan ke 480p jika file sangat besar / durasi panjang
        }
      }

      // Smart Bitrate: Hitung target bitrate agar muat dalam targetMaxBytes
      let videoBitrateArgs = ['-crf', '26'];
      if (duration > 0 && meta && meta.fileSize > targetMaxBytes) {
        // Alokasikan 80% dari batas untuk headroom aman
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
        '-movflags', '+faststart',
        '-threads', '2',
        outputPath
      ];

      log('INFO', `[${requestId}] [COMPRESS] START FFmpeg encoding -> ${path.basename(outputPath)}`);

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
 * 3. COMPRESSION / CONVERSION: Jika tidak kompatibel atau terlalu besar -> proses otomatis
 * 
 * @param {string} inputFilePath Path file video hasil download
 * @param {string} [requestId='opt'] ID request untuk logging
 * @param {number} [customMaxMB] Batas ukuran kustom dalam MB
 * @returns {Promise<{ filePath: string, fileSize: number, isOriginal: boolean, fastPath: boolean, title?: string }>}
 */
async function processVideoForWhatsApp(inputFilePath, requestId = 'media', customMaxMB = null) {
  if (!inputFilePath || !fs.existsSync(inputFilePath)) {
    throw new Error('File video tidak ditemukan untuk diproses.');
  }

  const stat = fs.statSync(inputFilePath);
  const targetMaxMB = customMaxMB || Math.min(config.maxFileSizeMB || 65, 20);
  const maxBytes = targetMaxMB * 1024 * 1024;
  const initialSizeMB = (stat.size / 1024 / 1024).toFixed(2);

  log('INFO', `[${requestId}] [CHECK] Memeriksa kompatibilitas video (${initialSizeMB} MB)`);

  const meta = await probeVideo(inputFilePath);

  if (meta) {
    const vCodec = (meta.videoCodec || 'unknown').toUpperCase();
    const aCodec = (meta.audioCodec || (meta.hasAudio ? 'unknown' : 'none')).toUpperCase();
    log('INFO', `[${requestId}] [CHECK] codec=${vCodec} audio=${aCodec} size=${initialSizeMB} MB container=${meta.container}`);

    // FAST PATH: Jika sudah MP4 + H.264 + AAC dan ukurannya aman, lewati FFmpeg sepenuhnya!
    if (isWhatsAppCompatible(meta, maxBytes)) {
      log('INFO', `[${requestId}] [FAST PATH] Video sepenuhnya kompatibel dengan WhatsApp. Mengirim file original.`);
      return {
        filePath: inputFilePath,
        fileSize: stat.size,
        isOriginal: true,
        fastPath: true
      };
    }
  } else {
    // Jika ffprobe gagal membaca tetapi ekstensi .mp4 dan ukuran aman, coba FAST PATH
    if (inputFilePath.toLowerCase().endsWith('.mp4') && stat.size <= maxBytes) {
      log('INFO', `[${requestId}] [FAST PATH] Metadata tidak terbaca tetapi format .mp4 aman. Mengirim file.`);
      return {
        filePath: inputFilePath,
        fileSize: stat.size,
        isOriginal: true,
        fastPath: true
      };
    }
  }

  // Jika tidak kompatibel atau ukuran terlalu besar, jalankan kompresi adaptif
  log('INFO', `[${requestId}] [COMPRESS] Diperlukan konversi/kompresi agar dapat diputar di WhatsApp`);
  const result = await executeCompression(inputFilePath, meta, maxBytes, requestId);

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
  resolveFfprobe
};
