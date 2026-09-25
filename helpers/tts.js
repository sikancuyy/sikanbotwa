const fs = require('fs');
const path = require('path');
const axios = require('axios');
const googleTTS = require('google-tts-api');
const config = require('../config');

// Daftar kode bahasa yang didukung umum
const SUPPORTED_LANGS = {
  'id': 'id',
  'indonesia': 'id',
  'en': 'en',
  'inggris': 'en',
  'english': 'en',
  'ar': 'ar',
  'arab': 'ar',
  'arabic': 'ar',
  'ja': 'ja',
  'jepang': 'ja',
  'japanese': 'ja',
  'ko': 'ko',
  'korea': 'ko',
  'korean': 'ko',
  'es': 'es',
  'fr': 'fr',
  'de': 'de',
  'ru': 'ru',
  'th': 'th',
  'vi': 'vi',
  'jw': 'jw',
  'su': 'su'
};

/**
 * Generate audio MP3 dari teks
 * @param {string} text Teks yang akan diucapkan
 * @param {string} lang Kode bahasa (default: 'id')
 * @returns {Promise<string>} Path file audio MP3 di folder temporary
 */
async function generateTTS(text, lang = 'id') {
  const cleanLang = SUPPORTED_LANGS[lang.toLowerCase()] || 'id';
  const cleanText = String(text || '').trim();

  if (!cleanText) {
    throw new Error('Teks untuk TTS tidak boleh kosong!');
  }

  // Batasi panjang teks wajar untuk WhatsApp voice note (maks 1000 karakter)
  const clippedText = cleanText.slice(0, 1000);
  const tempFile = path.join(
    config.tempDir,
    `tts_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.mp3`
  );

  // Cara 1: Menggunakan google-tts-api (mendukung split multi-kalimat jika panjang)
  try {
    const results = await googleTTS.getAllAudioBase64(clippedText, {
      lang: cleanLang,
      slow: false,
      host: 'https://translate.google.com',
      timeout: 10000
    });

    if (Array.isArray(results) && results.length > 0) {
      const buffers = results.map((r) => Buffer.from(r.base64, 'base64'));
      const combinedBuffer = Buffer.concat(buffers);
      fs.writeFileSync(tempFile, combinedBuffer);
      return tempFile;
    }
  } catch (err) {
    console.warn('[TTS] googleTTS getAllAudioBase64 gagal, mencoba fallback direct:', err.message);
  }

  // Cara 2: Fallback direct Google Translate TTS endpoint via axios stream
  try {
    const directUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${cleanLang}&client=tw-ob&q=${encodeURIComponent(clippedText.slice(0, 200))}`;
    const res = await axios.get(directUrl, {
      responseType: 'arraybuffer',
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });

    if (res.status === 200 && res.data && res.data.length > 0) {
      fs.writeFileSync(tempFile, Buffer.from(res.data));
      return tempFile;
    }
  } catch (err2) {
    console.warn('[TTS] Fallback direct Google TTS gagal:', err2.message);
  }

  // Cara 3: TikTok Voice API fallback jika ada
  try {
    const voiceMap = {
      id: 'id_001',
      en: 'en_us_001',
      ja: 'jp_001',
      ko: 'kr_001'
    };
    const voice = voiceMap[cleanLang] || 'id_001';
    const resTiktok = await axios.post(
      'https://tiktok-tts.weilnet.workers.dev/api/generation',
      { text: clippedText.slice(0, 250), voice },
      { timeout: 10000 }
    );

    if (resTiktok.data && resTiktok.data.data) {
      const audioBuf = Buffer.from(resTiktok.data.data, 'base64');
      fs.writeFileSync(tempFile, audioBuf);
      return tempFile;
    }
  } catch (_) {}

  throw new Error('Layanan Text-To-Speech sedang tidak tersedia.');
}

/**
 * Hapus file temporary audio dengan aman
 * @param {string} filePath
 */
function cleanTempAudio(filePath) {
  if (!filePath) return;
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (_) {}
}

module.exports = {
  SUPPORTED_LANGS,
  generateTTS,
  cleanTempAudio
};
