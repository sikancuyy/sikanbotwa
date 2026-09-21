const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Sticker, StickerTypes } = require('wa-sticker-formatter');
const config = require('../config');

/**
 * Konversi media buffer (gambar/video/gif) ke WebP stiker resmi WhatsApp
 */
async function mediaToWebp(mediaBuffer, isVideo = false, packname = '', author = '') {
  try {
    const sticker = new Sticker(mediaBuffer, {
      pack: packname || config.sticker.packname,
      author: author || config.sticker.author,
      type: StickerTypes.FULL,
      quality: isVideo ? 40 : 70
    });
    return await sticker.toBuffer();
  } catch (err) {
    // Fallback manual via ffmpeg jika wa-sticker-formatter menemui kendala
    return await mediaToWebpFfmpeg(mediaBuffer, isVideo, packname, author);
  }
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

    const proc = spawn('ffmpeg', ffmpegArgs);
    proc.on('close', async (code) => {
      try { if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput); } catch (_) { }
      if (code === 0 && fs.existsSync(tmpOutput)) {
        try {
          const webpData = fs.readFileSync(tmpOutput);
          fs.unlinkSync(tmpOutput);
          const sticker = new Sticker(webpData, {
            pack: packname || config.sticker.packname,
            author: author || config.sticker.author,
            type: StickerTypes.FULL
          });
          resolve(await sticker.toBuffer());
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
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);

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
    const ffmpegProc = spawn('ffmpeg', ffmpegArgs);

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
  const safeText = (text || 'SikanBot').replace(/'/g, "\\'").replace(/:/g, '\\:').slice(0, 30);
  const colors = ['red', 'yellow', 'lime', 'cyan', 'magenta', 'orange'];
  const frames = [];
  const tempPrefix = `attp_${Date.now()}_${Math.random().toString(36).slice(2)}`;

  for (let i = 0; i < colors.length; i++) {
    const framePath = path.join(config.tempDir, `${tempPrefix}_${i}.png`);
    frames.push(framePath);

    await new Promise((resolve, reject) => {
      const p = spawn('ffmpeg', [
        '-f', 'lavfi',
        '-i', 'color=c=black@0.0:s=512x512',
        '-vf', `drawtext=text='${safeText}':fontsize=52:fontcolor=${colors[i]}:x=(w-text_w)/2:y=(h-text_h)/2`,
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
    const p = spawn('ffmpeg', [
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

  for (const f of frames) {
    try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { }
  }

  const webpBuffer = fs.readFileSync(outWebp);
  try { if (fs.existsSync(outWebp)) fs.unlinkSync(outWebp); } catch (_) { }

  const sticker = new Sticker(webpBuffer, {
    pack: packname || config.sticker.packname,
    author: author || config.sticker.author,
    type: StickerTypes.FULL
  });
  return await sticker.toBuffer();
}

/**
 * Buat Stiker Teks Statis (.smaker)
 */
async function createTextSticker(text, packname = '', author = '') {
  const safeText = (text || 'SikanBot').replace(/'/g, "\\'").replace(/:/g, '\\:').slice(0, 50);
  const tempPrefix = `txtstk_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const outWebp = path.join(config.tempDir, `${tempPrefix}.webp`);

  await new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'color=c=black@0.0:s=512x512',
      '-vf', `drawtext=text='${safeText}':fontsize=48:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2`,
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

  const sticker = new Sticker(webpBuffer, {
    pack: packname || config.sticker.packname,
    author: author || config.sticker.author,
    type: StickerTypes.FULL
  });
  return await sticker.toBuffer();
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

/**
 * Buat Stiker Teks Gaya Brat (.brat) persis seperti referensi (Latar putih, teks hitam Arial Narrow rata kiri)
 */
async function createBratSticker(text, packname = '', author = '') {
  const lines = prepareBratLines(text || 'ih gombal bgt');
  const formattedText = lines.join('\n');
  const tempTxt = path.join(config.tempDir, `brat_${Date.now()}_${Math.random().toString(36).slice(2)}.txt`);
  const tempPng = path.join(config.tempDir, `brat_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);

  fs.writeFileSync(tempTxt, formattedText, 'utf8');

  let fontSize = 105;
  let lineSpacing = 5;
  let x = 40;
  let y = 45;

  const count = lines.length;
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

  const localFont = path.join(config.tempDir, 'arialn.ttf');
  if (!fs.existsSync(localFont)) {
    if (fs.existsSync('C:/Windows/Fonts/arialn.ttf')) {
      try { fs.copyFileSync('C:/Windows/Fonts/arialn.ttf', localFont); } catch (_) {}
    } else if (fs.existsSync('C:/Windows/Fonts/arial.ttf')) {
      try { fs.copyFileSync('C:/Windows/Fonts/arial.ttf', localFont); } catch (_) {}
    }
  }

  const relFont = fs.existsSync(localFont)
    ? path.relative(process.cwd(), localFont).split(path.sep).join('/')
    : 'Arial';
  const relTxt = path.relative(process.cwd(), tempTxt).split(path.sep).join('/');
  const relPng = path.relative(process.cwd(), tempPng).split(path.sep).join('/');

  await new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', [
      '-f', 'lavfi',
      '-i', 'color=c=white:s=512x512',
      '-vf', `drawtext=textfile=${relTxt}:fontfile=${relFont}:fontsize=${fontSize}:fontcolor=black:line_spacing=${lineSpacing}:x=${x}:y=${y}`,
      '-frames:v', '1',
      '-update', '1',
      '-y', relPng
    ]);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg brat error code ${code}`))));
    proc.on('error', reject);
  });

  try { if (fs.existsSync(tempTxt)) fs.unlinkSync(tempTxt); } catch (_) { }

  const pngData = fs.readFileSync(tempPng);
  try { if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng); } catch (_) { }

  const sticker = new Sticker(pngData, {
    pack: packname || config.sticker.packname,
    author: author || config.sticker.author,
    type: StickerTypes.FULL,
    quality: 80
  });
  return await sticker.toBuffer();
}

module.exports = {
  mediaToWebp,
  webpToImage,
  webpToVideo,
  createAttpSticker,
  createTextSticker,
  createBratSticker
};

