/**
 * QRIS Helper Module untuk SikanBot WhatsApp
 * Porting fitur dari sikanqris:
 * 1. Mode GOPAY_STATIC: Konversi QRIS Statis GoPay Merchant (GoBiz) menjadi QRIS Dinamis ber-nominal resmi (EMVCo Bank Indonesia / ASPI).
 * 2. Mode MIDTRANS_GOPAY: Menggunakan API resmi Midtrans Core API.
 * 3. Mode GENERIC_API: Menggunakan REST API eksternal.
 * 4. Image rendering menggunakan Sharp & QRCode dengan template bingkai bqr.png.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const sharp = require('sharp');
const QRCode = require('qrcode');
const config = require('../config');

// Helper untuk membaca nilai env dari sikanqris/.env jika belum diset di environment
function getEnvConfig(key, fallback = '') {
  if (process.env[key]) return process.env[key];
  try {
    const envPath = path.join(__dirname, '..', 'sikanqris', '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const [k, ...v] = trimmed.split('=');
        if (k && k.trim() === key) {
          return v.join('=').trim();
        }
      }
    }
  } catch (_) {}
  return fallback;
}

/**
 * Format angka nominal ke format Rupiah standar Indonesia (contoh: Rp10.000)
 */
function formatRupiah(nominal) {
  const num = Math.round(Number(nominal) || 0);
  return 'Rp' + num.toLocaleString('id-ID');
}

/**
 * Parsing teks nominal fleksibel dari user:
 * Contoh yang didukung:
 * - 10000 -> 10000
 * - 10.000 / 10,000 -> 10000
 * - 10k / 10K -> 10000
 * - 25.5k / 25,5k -> 25500
 * - 50rb / 50ribu -> 50000
 * - 1jt / 1juta -> 1000000
 * - Rp 20.000 -> 20000
 */
function parseNominal(input) {
  if (typeof input === 'number') {
    return input > 0 ? Math.round(input) : null;
  }
  if (!input || typeof input !== 'string') return null;

  let str = input.trim().toLowerCase();
  str = str.replace(/^rp\s*/i, '').trim();

  // Pola k / rb / ribu (ribuan)
  const kMatch = str.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(k|rb|ribu)$/i);
  if (kMatch) {
    const val = parseFloat(kMatch[1].replace(',', '.'));
    if (!isNaN(val) && val > 0) {
      return Math.round(val * 1000);
    }
  }

  // Pola jt / juta (jutaan)
  const jtMatch = str.match(/^([0-9]+(?:[.,][0-9]+)?)\s*(jt|juta)$/i);
  if (jtMatch) {
    const val = parseFloat(jtMatch[1].replace(',', '.'));
    if (!isNaN(val) && val > 0) {
      return Math.round(val * 1000000);
    }
  }

  // Pola angka murni atau bertitik (contoh: 10.000 atau 10000)
  const cleanNum = str.replace(/[.,\s]/g, '');
  if (/^[0-9]+$/.test(cleanNum)) {
    const val = parseInt(cleanNum, 10);
    return val > 0 ? val : null;
  }

  return null;
}

/**
 * Menghitung checksum CRC-16 (CCITT-FALSE) standar EMVCo Bank Indonesia.
 * Polynomial: 0x1021, Initial: 0xFFFF
 */
function calculateCRC16(data) {
  let crc = 0xFFFF;
  const buf = Buffer.from(data, 'utf-8');
  for (let i = 0; i < buf.length; i++) {
    crc ^= (buf[i] << 8);
    for (let j = 0; j < 8; j++) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Mengonversi string QRIS Statis (misalnya dari GoPay Merchant / GoBiz)
 * menjadi QRIS Dinamis ber-nominal dengan menyuntikkan Tag 54 (Nominal)
 * dan menghitung ulang Tag 63 (CRC-16) standar EMVCo Bank Indonesia & ASPI.
 */
function convertStaticToDynamic(staticQris, nominal) {
  let clean = String(staticQris || '').trim();
  if (!clean) {
    throw new Error('String QRIS Statis GoPay belum diisi di konfigurasi');
  }

  if (!clean.startsWith('000201')) {
    throw new Error('Format string QRIS tidak valid (harus diawali 000201)');
  }

  // Hapus checksum lama jika ada di akhir (Tag 63)
  const idx63 = clean.lastIndexOf('6304');
  if (idx63 !== -1 && (clean.length - idx63) <= 8) {
    clean = clean.slice(0, idx63);
  }

  // Parsing TLV sekuensial tingkat root
  let idx = 0;
  const tags = [];
  while (idx < clean.length) {
    if (idx + 4 > clean.length) break;
    const tag = clean.slice(idx, idx + 2);
    const lengthStr = clean.slice(idx + 2, idx + 4);
    if (!/^\d+$/.test(lengthStr)) break;
    const length = parseInt(lengthStr, 10);
    const val = clean.slice(idx + 4, idx + 4 + length);
    tags.push([tag, val]);
    idx += 4 + length;
  }

  // Bangun kembali tag dengan Tag 01 (Dynamic) dan Tag 54 (Transaction Amount)
  const newTags = [];
  const nominalStr = String(nominal);
  let tag54Inserted = false;

  for (const [tag, val] of tags) {
    if (tag === '01') {
      newTags.push(['01', '12']); // Ubah dari 11 (Statis) ke 12 (Dinamis)
    } else if (tag === '54') {
      continue; // Hapus tag nominal lama jika ada
    } else if (['58', '59', '60', '61', '62'].includes(tag)) {
      // Sisipkan Tag 54 sebelum Tag 58 (Country Code)
      if (!tag54Inserted) {
        newTags.push(['54', nominalStr]);
        tag54Inserted = true;
      }
      newTags.push([tag, val]);
    } else {
      newTags.push([tag, val]);
    }
  }

  if (!tag54Inserted) {
    newTags.push(['54', nominalStr]);
  }

  // Gabungkan semua tag
  let payload = '';
  for (const [tag, val] of newTags) {
    payload += tag + String(val.length).padStart(2, '0') + val;
  }

  // Tambahkan Tag 63 identifier (6304) lalu hitung CRC-16
  const payloadForCrc = payload + '6304';
  const crc = calculateCRC16(payloadForCrc);

  return payloadForCrc + crc;
}

/**
 * Render QR Code dan sematkan ke dalam template bingkai resmi (bqr.png)
 */
async function renderQrisImage(payload, nominal = null, customFramePath = null) {
  // Lokasi kandidat bingkai
  const candidateFrames = [
    customFramePath,
    config.qris?.framePath,
    path.join(__dirname, '..', 'assets', 'bqr.png'),
    path.join(__dirname, '..', 'sikanqris', 'bqr.png'),
    path.join(__dirname, '..', 'assets', '2bqr.png'),
    path.join(__dirname, '..', 'sikanqris', '2bqr.png')
  ].filter(Boolean);

  let framePath = null;
  for (const p of candidateFrames) {
    if (fs.existsSync(p)) {
      framePath = p;
      break;
    }
  }

  if (framePath) {
    try {
      const frameMeta = await sharp(framePath).metadata();
      const fw = frameMeta.width || 1792;
      const fh = frameMeta.height || 2400;

      // Mode 1: Template bqr.png (Rasio tinggi ~1792x2400)
      if (fh > fw * 1.2) {
        const qrSize = 920;
        const qrBuf = await QRCode.toBuffer(payload, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: qrSize,
          color: { dark: '#000000', light: '#ffffff' }
        });

        const qrX = Math.round(895 - qrSize / 2); // 435
        const qrY = Math.round(988 - qrSize / 2); // 528

        const overlays = [{ input: qrBuf, left: qrX, top: qrY }];

        // Tambahkan nominal di shape warna dongker (navy blue) di bawah QRIS
        if (nominal !== null && nominal !== undefined) {
          const nominalText = formatRupiah(nominal);
          // Hitung ukuran font adaptif jika teks panjang
          let fontSize = 72;
          if (nominalText.length > 14) {
            fontSize = Math.max(48, Math.floor(72 * (14 / nominalText.length)));
          }

          const textSvg = Buffer.from(
            `<svg width="${fw}" height="${fh}">` +
            `<text x="896" y="1575" font-family="Arial, 'Segoe UI', Helvetica, sans-serif" font-size="${fontSize}" font-weight="bold" fill="#ffffff" text-anchor="middle">${nominalText}</text>` +
            `</svg>`
          );
          overlays.push({ input: textSvg, left: 0, top: 0 });
        }

        return await sharp(framePath)
          .composite(overlays)
          .png({ quality: 90 })
          .toBuffer();
      } else {
        // Mode 2: Persegi 1000x1000
        const qrSize = 760;
        const qrBuf = await QRCode.toBuffer(payload, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: qrSize,
          color: { dark: '#000000', light: '#ffffff' }
        });

        const qrX = Math.round((fw - qrSize) / 2);
        const qrY = Math.round((fh - qrSize) / 2);

        return await sharp(framePath)
          .composite([{ input: qrBuf, left: qrX, top: qrY }])
          .png({ quality: 90 })
          .toBuffer();
      }
    } catch (err) {
      console.warn('[QRIS] Gagal render bingkai QRIS, menggunakan QR standar:', err.message);
    }
  }

  // Fallback: QR Code standar berkualitas tinggi
  return await QRCode.toBuffer(payload, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 800,
    color: { dark: '#000000', light: '#ffffff' }
  });
}

/**
 * Membuat QRIS melalui Midtrans Core API
 */
async function generateQrisMidtrans(nominal, serverKey, isProduction = false) {
  const baseUrl = isProduction ? 'https://api.midtrans.com' : 'https://api.sandbox.midtrans.com';
  const endpoint = `${baseUrl}/v2/charge`;
  const orderId = `QRIS-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const res = await axios.post(
    endpoint,
    {
      payment_type: 'qris',
      transaction_details: {
        order_id: orderId,
        gross_amount: nominal
      },
      qris: {
        acquirer: 'gopay'
      }
    },
    {
      auth: { username: serverKey, password: '' },
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      timeout: 30000
    }
  );

  const data = res.data;
  const qrString = data.qr_string;
  if (qrString) {
    const imageBytes = await renderQrisImage(qrString, nominal);
    return { nominal, qrString, imageBytes, orderId };
  }

  const actions = data.actions || [];
  for (const act of actions) {
    if (act.name === 'generate-qr-code' && act.url) {
      const imgRes = await axios.get(act.url, { responseType: 'arraybuffer', timeout: 30000 });
      return { nominal, qrString: act.url, imageBytes: Buffer.from(imgRes.data), orderId };
    }
  }

  throw new Error('Midtrans tidak mengembalikan data QRIS yang valid');
}

/**
 * Membuat QRIS melalui Generic REST API
 */
async function generateQrisGenericApi(nominal, apiUrl, apiKey) {
  const res = await axios.post(
    apiUrl,
    { nominal },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json'
      },
      timeout: 30000
    }
  );

  const data = res.data;
  const qrString = data.qr_string || data.payload || data.data?.qr_string;
  if (qrString) {
    const imageBytes = await renderQrisImage(qrString, nominal);
    return { nominal, qrString, imageBytes };
  }

  const qrImageUrl = data.qr_image || data.data?.qr_image;
  if (qrImageUrl) {
    const imgRes = await axios.get(qrImageUrl, { responseType: 'arraybuffer', timeout: 30000 });
    return { nominal, qrString: qrImageUrl, imageBytes: Buffer.from(imgRes.data) };
  }

  throw new Error('API QRIS tidak mengembalikan string atau URL gambar yang valid');
}

/**
 * Fungsi utama generate QRIS berdasarkan nominal
 */
async function generateQris(nominal, options = {}) {
  const parsedNominal = parseNominal(nominal);
  if (!parsedNominal || parsedNominal <= 0) {
    throw new Error('Nominal QRIS harus berupa angka lebih besar dari 0');
  }

  const mode = (
    options.mode ||
    config.qris?.mode ||
    getEnvConfig('QRIS_MODE', 'GOPAY_STATIC')
  ).trim().toUpperCase();

  if (mode === 'GOPAY_STATIC') {
    const staticString = (
      options.staticString ||
      config.qris?.staticString ||
      getEnvConfig('GOPAY_QRIS_STATIC_STRING', '')
    ).trim();

    if (!staticString) {
      throw new Error(
        'String QRIS Statis GoPay belum disetel. ' +
        'Silakan masukkan string QRIS GoPay Merchant Anda pada config.js atau sikanqris/.env (GOPAY_QRIS_STATIC_STRING).'
      );
    }

    const dynamicQris = convertStaticToDynamic(staticString, parsedNominal);
    const imageBytes = await renderQrisImage(dynamicQris, parsedNominal, options.framePath);

    return {
      nominal: parsedNominal,
      qrString: dynamicQris,
      imageBytes,
      mode: 'GOPAY_STATIC'
    };
  } else if (mode === 'MIDTRANS_GOPAY') {
    const serverKey = (
      options.serverKey ||
      config.qris?.midtransServerKey ||
      getEnvConfig('MIDTRANS_SERVER_KEY', '')
    ).trim();

    if (!serverKey) {
      throw new Error('MIDTRANS_SERVER_KEY belum diisi');
    }

    const isProduction = options.isProduction ?? (
      config.qris?.midtransIsProduction ??
      (getEnvConfig('MIDTRANS_IS_PRODUCTION', 'false').toLowerCase() === 'true')
    );

    const res = await generateQrisMidtrans(parsedNominal, serverKey, isProduction);
    return { ...res, mode: 'MIDTRANS_GOPAY' };
  } else if (mode === 'GENERIC_API') {
    const apiUrl = (
      options.apiUrl ||
      config.qris?.apiUrl ||
      getEnvConfig('QRIS_API_URL', '')
    ).trim();
    const apiKey = (
      options.apiKey ||
      config.qris?.apiKey ||
      getEnvConfig('QRIS_API_KEY', '')
    ).trim();

    if (!apiUrl) throw new Error('QRIS_API_URL belum diisi');
    const res = await generateQrisGenericApi(parsedNominal, apiUrl, apiKey);
    return { ...res, mode: 'GENERIC_API' };
  } else {
    throw new Error(`Mode QRIS '${mode}' tidak dikenali. Pilih GOPAY_STATIC atau MIDTRANS_GOPAY.`);
  }
}

module.exports = {
  calculateCRC16,
  convertStaticToDynamic,
  formatRupiah,
  parseNominal,
  renderQrisImage,
  generateQrisMidtrans,
  generateQrisGenericApi,
  generateQris
};
