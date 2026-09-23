const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const axios = require('axios');
let Sticker = null;
let StickerTypes = null;
try {
  const ws = require('wa-sticker-formatter');
  Sticker = ws.Sticker;
  StickerTypes = ws.StickerTypes;
} catch (err) {
  // sharp / wa-sticker-formatter tidak didukung di environment ini (misal Termux Android)
  // Bot akan fallback otomatis ke FFmpeg murni
}
const config = require('../config');
const { resolveBinary } = require('../utils');

function getFfmpeg() {
  return resolveBinary(config.ffmpeg) || 'ffmpeg';
}

/**
 * Helper untuk embed metadata stiker (exif) tanpa ketergantungan pada sharp
 */
async function addExifSafe(webpBuffer, packname = '', author = '') {
  if (Sticker) {
    try {
      const sticker = new Sticker(webpBuffer, {
        pack: packname || config.sticker.packname,
        author: author || config.sticker.author,
        type: StickerTypes?.FULL || 'full'
      });
      return await sticker.toBuffer();
    } catch (_) {}
  }

  // Fallback: coba gunakan node-webpmux jika tersedia
  try {
    const webpmux = require('node-webpmux');
    const img = new webpmux.Image();
    await img.load(webpBuffer);

    const json = {
      'sticker-pack-id': 'https://github.com/sikancuyy/sikanbotwa',
      'sticker-pack-name': packname || config.sticker.packname,
      'sticker-pack-publisher': author || config.sticker.author,
      'emojis': ['🤖']
    };
    const jsonBuff = Buffer.from(JSON.stringify(json), 'utf-8');
    const exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
    const exifBuff = Buffer.concat([exifAttr, jsonBuff]);
    exifBuff.writeUIntLE(jsonBuff.length, 14, 4);

    img.exif = exifBuff;
    return await img.save(null);
  } catch (_) {
    // Jika webpmux juga tidak ada, kembalikan webp mentah (tetap valid sebagai stiker WA)
    return webpBuffer;
  }
}

/**
 * Konversi media buffer (gambar/video/gif) ke WebP stiker resmi WhatsApp
 */
async function mediaToWebp(mediaBuffer, isVideo = false, packname = '', author = '') {
  if (Sticker && !isVideo) {
    try {
      const sticker = new Sticker(mediaBuffer, {
        pack: packname || config.sticker.packname,
        author: author || config.sticker.author,
        type: StickerTypes.FULL,
        quality: 70
      });
      return await sticker.toBuffer();
    } catch (err) {
      // Fallback ke ffmpeg
    }
  }
  return await mediaToWebpFfmpeg(mediaBuffer, isVideo, packname, author);
}

/**
 * Fallback konversi FFmpeg
 */
function mediaToWebpFfmpeg(mediaBuffer, isVideo = false, packname = '', author = '') {
  return new Promise((resolve, reject) => {
    const tmpInput = path.join(config.tempDir, `stk_in_${Date.now()}_${Math.random().toString(36).slice(2)}.${isVideo ? 'mp4' : 'jpg'}`);
    const tmpOutput = path.join(config.tempDir, `stk_out_${Date.now()}_${Math.random().toString(36).slice(2)}.webp`);

    fs.writeFileSync(tmpInput, mediaBuffer);

    let ffmpegArgs = [];
    if (isVideo) {
      ffmpegArgs = [
        '-y',
        '-i', tmpInput,
        '-t', '7',
        '-vf', "scale='if(gt(a,1),512,-1)':'if(gt(a,1),-1,512)',fps=15,pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000",
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', '50',
        '-loop', '0',
        '-preset', 'picture',
        '-an',
        tmpOutput
      ];
    } else {
      ffmpegArgs = [
        '-y',
        '-i', tmpInput,
        '-vf', "scale='if(gt(a,1),512,-1)':'if(gt(a,1),-1,512)',pad=512:512:(512-iw)/2:(512-ih)/2:color=0x00000000",
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', '70',
        tmpOutput
      ];
    }

    const proc = spawn(getFfmpeg(), ffmpegArgs);
    proc.on('close', async (code) => {
      try { if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput); } catch (_) { }
      if (code === 0 && fs.existsSync(tmpOutput)) {
        try {
          const webpData = fs.readFileSync(tmpOutput);
          fs.unlinkSync(tmpOutput);
          const finalBuffer = await addExifSafe(webpData, packname, author);
          resolve(finalBuffer);
        } catch (e) {
          reject(e);
        }
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

/**
 * Konversi WebP stiker ke gambar JPEG
 */
function webpToImage(webpBuffer) {
  return new Promise((resolve, reject) => {
    const tmpInput = path.join(config.tempDir, `webp_in_${Date.now()}_${Math.random().toString(36).slice(2)}.webp`);
    const tmpOutput = path.join(config.tempDir, `img_out_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);

    fs.writeFileSync(tmpInput, webpBuffer);

    const ffmpegArgs = ['-y', '-i', tmpInput, tmpOutput];
    const ffmpegProc = spawn(getFfmpeg(), ffmpegArgs);

    ffmpegProc.on('close', (code) => {
      try { if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput); } catch (_) { }
      if (code === 0 && fs.existsSync(tmpOutput)) {
        try {
          const imgData = fs.readFileSync(tmpOutput);
          fs.unlinkSync(tmpOutput);
          resolve(imgData);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`Konversi WebP ke Image gagal (code: ${code})`));
      }
    });

    ffmpegProc.on('error', reject);
  });
}

/**
 * Konversi WebP stiker animasi ke MP4
 */
function webpToVideo(webpBuffer) {
  return new Promise((resolve, reject) => {
    const tmpInput = path.join(config.tempDir, `webp_vid_${Date.now()}_${Math.random().toString(36).slice(2)}.webp`);
    const tmpOutput = path.join(config.tempDir, `vid_out_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);

    fs.writeFileSync(tmpInput, webpBuffer);

    const ffmpegArgs = [
      '-y',
      '-i', tmpInput,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      tmpOutput
    ];
    const ffmpegProc = spawn(getFfmpeg(), ffmpegArgs);

    ffmpegProc.on('close', (code) => {
      try { if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput); } catch (_) { }
      if (code === 0 && fs.existsSync(tmpOutput)) {
        try {
          const vidData = fs.readFileSync(tmpOutput);
          fs.unlinkSync(tmpOutput);
          resolve(vidData);
        } catch (err) {
          reject(err);
        }
      } else {
        reject(new Error(`Konversi WebP ke Video gagal (code: ${code})`));
      }
    });

    ffmpegProc.on('error', reject);
  });
}

/**
 * Buat Stiker Teks Animasi Berkelip Warna-Warni (ATTP)
 */
async function createAttpSticker(text, packname = '', author = '') {
  const content = (text || 'SikanBot').trim().slice(0, 35);
  const colors = ['red', 'yellow', 'lime', 'cyan', 'magenta', 'orange'];
  const frames = [];
  const tempPrefix = `attp_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const textFile = path.join(config.tempDir, `${tempPrefix}.txt`);
  fs.writeFileSync(textFile, content, 'utf8');
  const escapedTextFile = escapeFfmpegFilterPath(textFile);

  try {
    for (let i = 0; i < colors.length; i++) {
      const framePath = path.join(config.tempDir, `${tempPrefix}_${i}.png`);
      frames.push(framePath);

      await new Promise((resolve, reject) => {
        const p = spawn(getFfmpeg(), [
          '-f', 'lavfi',
          '-i', 'color=c=black@0.0:s=512x512',
          '-vf', `drawtext=textfile='${escapedTextFile}':expansion=none:fontsize=52:fontcolor=${colors[i]}:x=(w-text_w)/2:y=(h-text_h)/2`,
          '-frames:v', '1',
          '-update', '1',
          '-y', framePath
        ]);
        p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg frame error code ${code}`))));
        p.on('error', reject);
      });
    }

    const outWebp = path.join(config.tempDir, `${tempPrefix}_out.webp`);

    await new Promise((resolve, reject) => {
      const p = spawn(getFfmpeg(), [
        '-framerate', '4',
        '-i', path.join(config.tempDir, `${tempPrefix}_%d.png`),
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', '60',
        '-loop', '0',
        '-preset', 'picture',
        '-an',
        '-y', outWebp
      ]);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg webp compile error code ${code}`))));
      p.on('error', reject);
    });

    const webpBuffer = fs.readFileSync(outWebp);
    try { if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp); } catch (_) { }

    return await addExifSafe(webpBuffer, packname, author);
  } finally {
    try { if (fs.existsSync(textFile)) fs.unlinkSync(textFile); } catch (_) { }
    for (const f of frames) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { }
    }
  }
}

/**
 * Buat Stiker Teks Statis (.smaker)
 */
async function createTextSticker(text, packname = '', author = '') {
  const content = (text || 'SikanBot').trim().slice(0, 60);
  const tempPrefix = `txtstk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const textFile = path.join(config.tempDir, `${tempPrefix}.txt`);
  fs.writeFileSync(textFile, content, 'utf8');
  const escapedTextFile = escapeFfmpegFilterPath(textFile);
  const outWebp = path.join(config.tempDir, `${tempPrefix}.webp`);

  try {
    await new Promise((resolve, reject) => {
      const p = spawn(getFfmpeg(), [
        '-f', 'lavfi',
        '-i', 'color=c=black@0.0:s=512x512',
        '-vf', `drawtext=textfile='${escapedTextFile}':expansion=none:fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-q:v', '70',
        '-frames:v', '1',
        '-y', outWebp
      ]);
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg text sticker code ${code}`))));
      p.on('error', reject);
    });

    const webpBuffer = fs.readFileSync(outWebp);
    try { if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp); } catch (_) { }

    return await addExifSafe(webpBuffer, packname, author);
  } finally {
    try { if (fs.existsSync(textFile)) fs.unlinkSync(textFile); } catch (_) { }
  }
}

function prepareBratLines(text) {
  if (text.includes('\n')) {
    return text.split('\n').map((s) => s.trim()).filter(Boolean);
  }
  const words = text.trim().split(/\s+/);
  if (words.length <= 4 && words.every((w) => w.length <= 10)) {
    return words;
  }
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if ((cur + ' ' + w).length <= 12) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

function escapeFfmpegFilterPath(filePath) {
  return filePath.split(path.sep).join('/').replace(/:/g, '\\:');
}

/**
 * Buat Stiker Teks Gaya Brat Lokal via FFmpeg (Latar putih, teks hitam Arial/Arial Narrow sedikit blur khas Brat)
 */
async function createBratStickerLocal(text, isAnimated = false, packname = '', author = '') {
  const localFont = path.join(config.tempDir, 'arialn.ttf');
  if (!fs.existsSync(localFont)) {
    if (fs.existsSync('C:/Windows/Fonts/arialn.ttf')) {
      try { fs.copyFileSync('C:/Windows/Fonts/arialn.ttf', localFont); } catch (_) {}
    } else if (fs.existsSync('C:/Windows/Fonts/arial.ttf')) {
      try { fs.copyFileSync('C:/Windows/Fonts/arial.ttf', localFont); } catch (_) {}
    }
  }

  const fontParam = fs.existsSync(localFont)
    ? `fontfile='${escapeFfmpegFilterPath(localFont)}':`
    : '';

  const renderFrame = (txt, outPngPath) => {
    const lines = prepareBratLines(txt || 'brat');
    const count = lines.length;
    let fontSize = 105;
    let lineSpacing = 5;
    let x = 40;
    let y = 45;

    if (count === 1) {
      fontSize = 130;
      y = 190;
      x = 45;
    } else if (count === 2) {
      fontSize = 115;
      lineSpacing = 8;
      y = 130;
      x = 45;
    } else if (count === 3) {
      fontSize = 105;
      lineSpacing = 5;
      y = 45;
      x = 40;
    } else if (count === 4) {
      fontSize = 88;
      lineSpacing = 5;
      y = 35;
      x = 35;
    } else if (count <= 6) {
      fontSize = 70;
      lineSpacing = 4;
      y = 30;
      x = 30;
    } else {
      fontSize = 55;
      lineSpacing = 3;
      y = 25;
      x = 25;
    }

    const tempTxt = path.join(config.tempDir, `brat_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(tempTxt, lines.join('\n'), 'utf8');
    const escapedTxt = escapeFfmpegFilterPath(tempTxt);

    return new Promise((resolve, reject) => {
      const proc = spawn(getFfmpeg(), [
        '-f', 'lavfi',
        '-i', 'color=c=white:s=512x512',
        '-vf', `drawtext=textfile='${escapedTxt}':expansion=none:${fontParam}fontsize=${fontSize}:fontcolor=black:line_spacing=${lineSpacing}:x=${x}:y=${y}`,
        '-frames:v', '1',
        '-update', '1',
        '-y', outPngPath
      ]);
      proc.on('close', (code) => {
        try { if (fs.existsSync(tempTxt)) fs.unlinkSync(tempTxt); } catch (_) {}
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg brat frame error code ${code}`));
      });
      proc.on('error', (err) => {
        try { if (fs.existsSync(tempTxt)) fs.unlinkSync(tempTxt); } catch (_) {}
        reject(err);
      });
    });
  };

  if (!isAnimated) {
    const tempPng = path.join(config.tempDir, `brat_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
    try {
      await renderFrame(text, tempPng);
      const pngData = fs.readFileSync(tempPng);
      return await addExifSafe(pngData, packname, author);
    } finally {
      try { if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng); } catch (_) {}
    }
  }

  // Jika animasi lokal: buat urutan kata bertahap
  const words = (text || 'brat').trim().split(/\s+/);
  const frames = [];
  const tempPrefix = `bratvid_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outWebp = path.join(config.tempDir, `${tempPrefix}_out.webp`);

  try {
    for (let i = 0; i < words.length; i++) {
      const stepText = words.slice(0, i + 1).join(' ');
      const framePath = path.join(config.tempDir, `${tempPrefix}_${i}.png`);
      frames.push(framePath);
      await renderFrame(stepText, framePath);
    }

    await new Promise((resolve, reject) => {
      const proc = spawn(getFfmpeg(), [
        '-framerate', '2',
        '-i', path.join(config.tempDir, `${tempPrefix}_%d.png`),
        '-c:v', 'libwebp',
        '-lossless', '0',
        '-compression_level', '6',
        '-q:v', '60',
        '-loop', '0',
        '-preset', 'picture',
        '-an',
        '-y', outWebp
      ]);
      proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg brat compile error ${code}`))));
      proc.on('error', reject);
    });

    const webpBuffer = fs.readFileSync(outWebp);
    return await addExifSafe(webpBuffer, packname, author);
  } finally {
    for (const f of frames) {
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) {}
    }
    try { if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp); } catch (_) {}
  }
}

/**
 * Buat Stiker Teks Gaya Brat (.brat dan .bratvid)
 * Prioritas 1 (.brat statis): aqul-brat API (font Arial Narrow otentik, tajam dan rapi persis seperti album Charli XCX Brat)
 * Prioritas 2 (.bratvid animasi / fallback): SiputZX Brat API
 * Prioritas 3: Fallback rendering lokal FFmpeg
 */
async function createBratSticker(text, isAnimated = false, packname = '', author = '') {
  const cleanText = (text || 'brat').trim();

  // 1. Coba generator asli aqul-brat untuk stiker statis (.brat)
  if (!isAnimated) {
    try {
      const url = `https://aqul-brat.hf.space/api/brat?text=${encodeURIComponent(cleanText)}`;
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });

      if (res.status === 200 && res.data && res.data.length > 0) {
        return await mediaToWebp(res.data, false, packname, author);
      }
    } catch (_) {
      // Lanjut ke fallback jika gagal
    }
  }

  // 2. Coba online API SiputZX (untuk animasi .bratvid atau fallback)
  try {
    const url = `https://api.siputzx.my.id/api/m/brat?text=${encodeURIComponent(cleanText)}${isAnimated ? '&isAnimated=true' : ''}`;
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (res.status === 200 && res.data && res.data.length > 0) {
      return await mediaToWebp(res.data, isAnimated, packname, author);
    }
  } catch (_) {
    // API gagal atau timeout, fallback ke render lokal FFmpeg
  }

  // 3. Fallback render lokal via FFmpeg
  return await createBratStickerLocal(cleanText, isAnimated, packname, author);
}

/**
 * Buat Stiker Teks Gaya Brat Animasi / Bergerak (.bratvid)
 */
async function createBratVideoSticker(text, packname = '', author = '') {
  return await createBratSticker(text, true, packname, author);
}

module.exports = {
  mediaToWebp,
  webpToImage,
  webpToVideo,
  createAttpSticker,
  createTextSticker,
  createBratSticker,
  createBratVideoSticker
};

