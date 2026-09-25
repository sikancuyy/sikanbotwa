const axios = require('axios');
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { mediaToWebp } = require('../lib/sticker');

// Helper XML/HTML escape untuk SVG
function escapeXml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Helper word wrap untuk teks di SVG
function wrapTextSvg(text, maxCharsPerLine = 24) {
  const words = String(text || '').trim().split(/\s+/);
  const lines = [];
  let cur = '';

  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if ((cur + ' ' + w).length <= maxCharsPerLine) {
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
 * 1. QUOTE CHAT GENERATOR (QC & QC2)
 * Menghasilkan stiker WhatsApp Quote Chat berkualitas tinggi secara lokal
 * dengan fallback ke API eksternal jika diinginkan
 */
async function generateQuoteChat({
  name = 'User',
  text = 'Quote text',
  avatarUrl = '',
  bgColor = '#1f2c34',
  style = 1,
  timeText = ''
}) {
  const cleanName = escapeXml(name.slice(0, 30));
  const rawText = text.trim();
  const time = timeText || new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });

  // Word wrap teks
  const lines = wrapTextSvg(rawText, style === 2 ? 22 : 25);
  const lineHeight = 32;
  const contentHeight = Math.max(120, 70 + lines.length * lineHeight + 35);
  const bubbleWidth = 420;
  const bubbleX = 80;
  const bubbleY = 40;

  // Siapkan avatar (jika ada avatarUrl, download atau gunakan inisial)
  let avatarBase64 = null;
  if (avatarUrl) {
    try {
      const avRes = await axios.get(avatarUrl, {
        responseType: 'arraybuffer',
        timeout: 5000,
        headers: { 'User-Agent': 'Mozilla/5.0' }
      });
      if (avRes.status === 200 && avRes.data) {
        const avPng = await sharp(avRes.data)
          .resize(80, 80, { fit: 'cover' })
          .png()
          .toBuffer();
        avatarBase64 = `data:image/png;base64,${avPng.toString('base64')}`;
      }
    } catch (_) {}
  }

  const initialLetter = escapeXml((cleanName[0] || 'U').toUpperCase());
  const avatarSvg = avatarBase64
    ? `<clipPath id="avatarClip"><circle cx="40" cy="${bubbleY + 35}" r="28"/></clipPath>
       <image x="12" y="${bubbleY + 7}" width="56" height="56" xlink:href="${avatarBase64}" clip-path="url(#avatarClip)"/>`
    : `<circle cx="40" cy="${bubbleY + 35}" r="28" fill="#4f46e5"/>
       <text x="40" y="${bubbleY + 44}" font-family="Arial, Helvetica, sans-serif" font-size="24" font-weight="bold" fill="#ffffff" text-anchor="middle">${initialLetter}</text>`;

  const nameColors = ['#25D366', '#34B7F1', '#FFA500', '#FF3366', '#9B51E0', '#00C49F'];
  const nameColor = nameColors[Math.abs(cleanName.split('').reduce((a, c) => a + c.charCodeAt(0), 0)) % nameColors.length];

  let textSvgLines = '';
  lines.forEach((l, idx) => {
    const yPos = bubbleY + 68 + idx * lineHeight;
    textSvgLines += `<text x="${bubbleX + 24}" y="${yPos}" font-family="Arial, Segoe UI, sans-serif" font-size="22" fill="#ffffff">${escapeXml(l)}</text>\n`;
  });

  const finalBubbleColor = bgColor || (style === 2 ? '#242a38' : '#1f2c34');

  const svgTemplate = `
  <svg width="512" height="512" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
    <rect width="100%" height="100%" fill="none"/>
    
    <!-- Bubble Chat -->
    <rect x="${bubbleX}" y="${bubbleY}" width="${bubbleWidth}" height="${contentHeight}" rx="20" ry="20" fill="${finalBubbleColor}" stroke="${style === 2 ? '#3b82f6' : 'none'}" stroke-width="${style === 2 ? '2' : '0'}"/>
    
    <!-- Bubble Tail -->
    <polygon points="${bubbleX},${bubbleY + 25} ${bubbleX - 12},${bubbleY + 32} ${bubbleX},${bubbleY + 40}" fill="${finalBubbleColor}"/>

    <!-- Avatar -->
    ${avatarSvg}

    <!-- Pengirim & Konten -->
    <text x="${bubbleX + 24}" y="${bubbleY + 34}" font-family="Arial, Segoe UI, sans-serif" font-size="20" font-weight="bold" fill="${nameColor}">${cleanName}</text>
    ${textSvgLines}

    <!-- Waktu & Centang -->
    <text x="${bubbleX + bubbleWidth - 65}" y="${bubbleY + contentHeight - 12}" font-family="Arial, sans-serif" font-size="14" fill="#8696a0">${escapeXml(time)}</text>
    <path d="M${bubbleX + bubbleWidth - 22} ${bubbleY + contentHeight - 16} l-6 -6 l1.4 -1.4 l4.6 4.6 l10.6 -10.6 l1.4 1.4 z" fill="#53bdeb"/>
  </svg>
  `;

  const webpBuffer = await sharp(Buffer.from(svgTemplate))
    .webp({ quality: 85 })
    .toBuffer();

  return await mediaToWebp(webpBuffer, false, config.sticker.packname, config.sticker.author);
}

/**
 * 2. BRAT STICKER VARIATIONS
 * Kustomisasi warna background & teks, resolusi HD, inverted, Charli XCX lime green
 */
async function generateBratCustom({
  text = 'brat',
  bgColor = '#ffffff',
  textColor = '#000000',
  isHd = false,
  isAnya = false,
  isAnime = false
}) {
  const clean = String(text || 'brat').trim();
  const words = clean.split(/\s+/);
  const lines = [];
  let cur = '';

  for (const w of words) {
    if (!cur) {
      cur = w;
    } else if ((cur + ' ' + w).length <= 14) {
      cur += ' ' + w;
    } else {
      lines.push(cur);
      cur = w;
    }
  }
  if (cur) lines.push(cur);

  const canvasSize = isHd ? 1024 : 512;
  const count = lines.length;
  let fontSize = isHd ? 180 : 95;
  let lineHeight = isHd ? 190 : 100;

  if (count === 1) {
    fontSize = isHd ? 220 : 120;
    lineHeight = fontSize + 10;
  } else if (count >= 5) {
    fontSize = isHd ? 120 : 65;
    lineHeight = fontSize + 10;
  }

  const startY = isAnya || isAnime
    ? (canvasSize / 2) - ((count * lineHeight) / 2) + 40
    : (canvasSize / 2) - ((count * lineHeight) / 2) + (fontSize * 0.75);

  let textSvg = '';
  lines.forEach((l, i) => {
    textSvg += `<text x="${isAnya || isAnime ? canvasSize / 2 : 40}" y="${startY + i * lineHeight}" font-family="Arial Narrow, Arial, sans-serif" font-weight="bold" font-size="${fontSize}" fill="${textColor}" text-anchor="${isAnya || isAnime ? 'middle' : 'start'}">${escapeXml(l.toLowerCase())}</text>\n`;
  });

  let decorationSvg = '';
  if (isAnya) {
    decorationSvg = `
      <g transform="translate(${canvasSize / 2 - 40}, 30) scale(0.8)">
        <circle cx="50" cy="50" r="45" fill="#fbcfe8" stroke="#f472b6" stroke-width="4"/>
        <text x="50" y="60" font-family="Arial" font-size="32" text-anchor="middle">🥜 Heh</text>
      </g>
    `;
  } else if (isAnime) {
    decorationSvg = `
      <g transform="translate(30, 25)">
        <rect width="120" height="32" rx="16" fill="#ec4899"/>
        <text x="60" y="22" font-family="Arial" font-size="16" font-weight="bold" fill="white" text-anchor="middle">★ ANIME</text>
      </g>
    `;
  }

  const svg = `
  <svg width="${canvasSize}" height="${canvasSize}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${bgColor}"/>
    ${decorationSvg}
    ${textSvg}
  </svg>
  `;

  const webpBuffer = await sharp(Buffer.from(svg))
    .resize(512, 512)
    .webp({ quality: isHd ? 90 : 75 })
    .toBuffer();

  return await mediaToWebp(webpBuffer, false, config.sticker.packname, config.sticker.author);
}

/**
 * 3. STICKER MEME GENERATOR (SMEME)
 * Menempelkan teks atas dan teks bawah dengan gaya font impact pada gambar
 */
async function generateStickerMeme(imageBuffer, topText = '', bottomText = '') {
  if (!imageBuffer) throw new Error('Gambar tidak valid untuk membuat meme stiker.');

  const top = escapeXml(String(topText || '').toUpperCase());
  const bottom = escapeXml(String(bottomText || '').toUpperCase());

  // Buat overlay SVG teks meme
  const svgOverlay = `
  <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
    <style>
      .meme-text {
        font-family: Impact, Arial Black, sans-serif;
        font-size: 44px;
        font-weight: bold;
        fill: #ffffff;
        stroke: #000000;
        stroke-width: 5px;
        paint-order: stroke fill;
        text-anchor: middle;
      }
    </style>
    ${top ? `<text x="256" y="65" class="meme-text">${top}</text>` : ''}
    ${bottom ? `<text x="256" y="480" class="meme-text">${bottom}</text>` : ''}
  </svg>
  `;

  const baseImage = await sharp(imageBuffer)
    .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  const finalImage = await sharp(baseImage)
    .composite([{ input: Buffer.from(svgOverlay), top: 0, left: 0 }])
    .webp({ quality: 75 })
    .toBuffer();

  return await mediaToWebp(finalImage, false, config.sticker.packname, config.sticker.author);
}

/**
 * 4. TTP GENERATOR (Text To Picture)
 * Stiker teks transparan dengan teks putih atau pelangi tebal
 */
async function generateTTP(text) {
  const clean = escapeXml(String(text || 'SikanBot').trim().slice(0, 50));
  const words = clean.split(/\s+/);
  const lines = [];
  let cur = '';

  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= 15) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);

  const fontSize = lines.length > 2 ? 55 : 75;
  const startY = 256 - ((lines.length - 1) * fontSize) / 2;

  let textSvg = '';
  lines.forEach((l, idx) => {
    textSvg += `<text x="256" y="${startY + idx * (fontSize + 10)}" font-family="Impact, Arial Black, sans-serif" font-size="${fontSize}" fill="#ffffff" stroke="#000000" stroke-width="4px" paint-order="stroke fill" text-anchor="middle">${l}</text>\n`;
  });

  const svg = `
  <svg width="512" height="512" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="none"/>
    ${textSvg}
  </svg>
  `;

  const webpBuffer = await sharp(Buffer.from(svg))
    .webp({ quality: 80 })
    .toBuffer();

  return await mediaToWebp(webpBuffer, false, config.sticker.packname, config.sticker.author);
}

/**
 * 5. STICKER.LY SEARCH & DOWNLOAD
 */
async function searchStickerly(query) {
  const q = encodeURIComponent(query.trim());
  const url = `https://api.sticker.ly/v4/stickerPack/search?keyword=${q}&page=0&size=10`;

  const res = await axios.get(url, {
    timeout: 10000,
    headers: {
      'User-Agent': 'androidapp.stickerly/2.8.0 (Android; 10; Scale/2.0)',
      'Content-Type': 'application/json'
    }
  });

  if (res.data && res.data.result && Array.isArray(res.data.result.stickerPacks)) {
    return res.data.result.stickerPacks;
  }
  return [];
}

/**
 * 6. TENOR GIF SEARCH
 */
async function searchTenor(query, limit = 1) {
  const q = encodeURIComponent(query.trim());
  // Endpoint public Klip/Tenor
  const url = `https://g.tenor.com/v1/search?q=${q}&key=LIVDSRZULELA&limit=${Math.min(5, Math.max(1, limit))}`;

  const res = await axios.get(url, { timeout: 10000 });
  if (res.data && Array.isArray(res.data.results)) {
    return res.data.results.map((r) => {
      const media = r.media && r.media[0];
      return {
        id: r.id,
        title: r.title || query,
        gifUrl: media?.gif?.url || media?.mediumgif?.url,
        mp4Url: media?.mp4?.url || media?.tinymp4?.url
      };
    }).filter((item) => item.gifUrl || item.mp4Url);
  }
  return [];
}

/**
 * 7. TELEGRAM STICKERS DOWNLOADER
 */
async function getTelegramStickers(telestickUrl) {
  const packName = telestickUrl.split('addstickers/')[1]?.split(/[?#]/)[0] || telestickUrl.trim();
  if (!packName) throw new Error('Format link stiker Telegram tidak valid!');

  // Ambil via public API telegram webp pack scraper
  const apiUrls = [
    `https://api.telegram.org/bot7000000000:AAExample/getStickerSet?name=${packName}`,
    `https://stickers.cloud/api/v1/pack/${packName}`
  ];

  // Alternatif scraping via Telegram web preview
  try {
    const webRes = await axios.get(`https://t.me/addstickers/${packName}`, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const html = webRes.data;
    const stickerUrls = [];
    const regex = /https:\/\/cdn\d*\.telegram-cdn\.org\/file\/[a-zA-Z0-9_-]+\.webp/g;
    let m;
    while ((m = regex.exec(html)) !== null) {
      if (!stickerUrls.includes(m[0])) stickerUrls.push(m[0]);
    }
    if (stickerUrls.length > 0) return stickerUrls;
  } catch (_) {}

  return [];
}

/**
 * 8. RYO ANIME IMAGES & STICKERS
 */
function getRandomRyo() {
  const ryoList = [
    'https://i.pinimg.com/736x/88/3b/b1/883bb17b6dc196b27e408ecbbef3d7c7.jpg',
    'https://i.pinimg.com/736x/1a/0c/33/1a0c33eb3d22b6478d3eb9753c15c2cf.jpg',
    'https://i.pinimg.com/736x/f6/cb/8f/f6cb8f185fe9963e6e3c0eaae33bfa82.jpg',
    'https://i.pinimg.com/736x/c6/3e/eb/c63eebd68026105c31671fc0f8cf896c.jpg',
    'https://i.pinimg.com/736x/ea/d2/d0/ead2d03d0922e92ec4eb11e2fbc38703.jpg'
  ];
  return ryoList[Math.floor(Math.random() * ryoList.length)];
}

module.exports = {
  generateQuoteChat,
  generateBratCustom,
  generateStickerMeme,
  generateTTP,
  searchStickerly,
  searchTenor,
  getTelegramStickers,
  getRandomRyo
};
