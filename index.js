// Preload sharp terlebih dahulu untuk mencegah konflik DLL native Windows
try {
  require('sharp');
} catch (_) {}

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const config = require('./config');
const db = require('./lib/database');
const {
  ensureDirs,
  cleanDirectory,
  formatBytes,
  formatUptime,
  printBanner,
  log
} = require('./utils');
const { checkYtDlpAvailable } = require('./downloader');
const { handleMessage } = require('./handler');
const userDb = require('./database/users');
const { getRealPhoneNumber, normalizePhoneNumber, isValidPhoneNumber } = require('./helpers/userHelper');
const {
  markMessageSent,
  shouldIgnoreMessage,
  isDuplicateGroupEvent
} = require('./helpers/messageDeduplicator');

// Waktu mulai bot untuk kalkulasi uptime
const startTime = Date.now();

// Instance aktif Baileys Socket untuk API & manajemen siklus koneksi tunggal
let currentSock = null;
let activeSock = null;
let apiServer = null;
let reconnectTimer = null;
let isReconnecting = false;
let isStarting = false;

// Pastikan semua folder yang dibutuhkan siap
ensureDirs([config.sessionDir, config.tempDir, config.downloadDir]);

// Bersihkan file sementara dari sesi sebelumnya (jika ada)
cleanDirectory(config.tempDir, 0);
cleanDirectory(config.downloadDir, 0);

/**
 * Fungsi utama untuk menginisialisasi SikanBot
 */
async function startBot() {
  // Cegah pemanggilan startBot ganda secara bersamaan
  if (isStarting) {
    log('WARN', 'startBot() sedang berjalan, mengabaikan inisialisasi tumpang-tindih.');
    return;
  }
  isStarting = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  // Bersihkan socket sebelumnya agar tidak ada multi-instance / zombie socket yang berjalan paralel
  if (activeSock) {
    log('INFO', 'Membersihkan instance socket sebelumnya...');
    try {
      activeSock.ev.removeAllListeners();
    } catch (_) {}
    try {
      if (typeof activeSock.end === 'function') activeSock.end();
    } catch (_) {}
    try {
      if (activeSock.ws && typeof activeSock.ws.close === 'function') activeSock.ws.close();
    } catch (_) {}
    activeSock = null;
    currentSock = null;
  }

  log('INFO', 'Menginisialisasi SikanBot WhatsApp session...');

  // Cek ketersediaan yt-dlp saat startup
  const isYtDlpReady = await checkYtDlpAvailable();
  if (!isYtDlpReady) {
    log('WARN', 'Peringatan: yt-dlp belum terdeteksi di sistem!');
  } else {
    log('SUCCESS', 'yt-dlp & FFmpeg siap digunakan.');
  }

  let sock;
  let saveCreds;
  try {
    // Muat status autentikasi multi-file
    const authState = await useMultiFileAuthState(config.sessionDir);
    const state = authState.state;
    saveCreds = authState.saveCreds;
    const { version, isLatest } = await fetchLatestBaileysVersion();
    log('INFO', `Menggunakan Baileys v${version.join('.')} (Latest: ${isLatest})`);

    sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      generateHighQualityLinkPreview: false,
      browser: ['SikanBot', 'Chrome', '122.0.0']
    });

    activeSock = sock;
  } catch (err) {
    isStarting = false;
    log('ERROR', `Gagal membuat instance WhatsApp socket: ${err.message}`);
    // Jadwalkan reconnect jika pembuatan socket gagal
    if (!isReconnecting) {
      isReconnecting = true;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        isReconnecting = false;
        startBot();
      }, 5000);
    }
    return;
  } finally {
    isStarting = false;
  }

  // Bungkus sendMessage agar setiap pesan yang dikirim oleh bot otomatis tercatat ke cache anti-loop
  const rawSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = async (...args) => {
    try {
      const res = await rawSendMessage(...args);
      if (res?.key?.id) {
        markMessageSent(res.key.id);
      }
      return res;
    } catch (err) {
      throw err;
    }
  };

  // Simpan kredensial setiap ada update auth
  sock.ev.on('creds.update', saveCreds);

  // Simpan pemetaan nomor WhatsApp <-> LID secara otomatis dari sinkronisasi kontak & history
  sock.ev.on('contacts.upsert', (contacts) => {
    try {
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          if (c && c.lid && (c.id || c.jid)) {
            const phone = c.jid || (c.id && !String(c.id).includes('@lid') ? c.id : null);
            if (phone) {
              const cleanPhone = normalizePhoneNumber(phone);
              if (cleanPhone && isValidPhoneNumber(cleanPhone)) {
                userDb.saveLidMapping(c.lid, cleanPhone);
              }
            }
          }
        }
      }
    } catch (_) {}
  });

  sock.ev.on('contacts.update', (updates) => {
    try {
      if (Array.isArray(updates)) {
        for (const c of updates) {
          if (c && c.lid && (c.id || c.jid)) {
            const phone = c.jid || (c.id && !String(c.id).includes('@lid') ? c.id : null);
            if (phone) {
              const cleanPhone = normalizePhoneNumber(phone);
              if (cleanPhone && isValidPhoneNumber(cleanPhone)) {
                userDb.saveLidMapping(c.lid, cleanPhone);
              }
            }
          }
        }
      }
    } catch (_) {}
  });

  sock.ev.on('messaging-history.set', ({ contacts }) => {
    try {
      if (Array.isArray(contacts)) {
        for (const c of contacts) {
          if (c && c.lid && (c.id || c.jid)) {
            const phone = c.jid || (c.id && !String(c.id).includes('@lid') ? c.id : null);
            if (phone) {
              const cleanPhone = normalizePhoneNumber(phone);
              if (cleanPhone && isValidPhoneNumber(cleanPhone)) {
                userDb.saveLidMapping(c.lid, cleanPhone);
              }
            }
          }
        }
      }
    } catch (_) {}
  });

  // Pantau status koneksi
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Tampilkan QR code di terminal jika perlu login
    if (qr) {
      console.log('\n' + '='.repeat(50));
      console.log('    SCAN QR CODE DI BAWAH DENGAN APLIKASI WHATSAPP');
      console.log('='.repeat(50));
      qrcodeTerminal.generate(qr, { small: true });
      console.log('Petunjuk: Buka WA > Titik 3 / Pengaturan > Perangkat Tertaut > Tautkan Perangkat\n');
    }

    // Ketika bot berhasil terhubung
    if (connection === 'open') {
      currentSock = sock;
      activeSock = sock;
      isReconnecting = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      const rawNumber = sock.user?.id || '';
      const botNumber = rawNumber ? '+' + rawNumber.split(':')[0] : 'Unknown';

      printBanner({
        status: 'Online & Connected 🟢',
        number: botNumber,
        mode: 'Multi-Feature Ready'
      });
      log('SUCCESS', `SikanBot berhasil terhubung ke WhatsApp: ${botNumber}`);
    }

    // Ketika koneksi terputus
    if (connection === 'close') {
      currentSock = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log('WARN', `Koneksi terputus (Status: ${statusCode || 'Unknown'}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        // Cegah penjadwalan timeout reconnect berulang jika event close terpicu lebih dari sekali
        if (!isReconnecting) {
          isReconnecting = true;
          log('INFO', 'Menghubungkan kembali dalam 5 detik...');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            isReconnecting = false;
            startBot();
          }, 5000);
        }
      } else {
        log('ERROR', 'Sesi telah keluar (Logged Out / 401). Membersihkan folder sesi lama agar siap scan QR ulang...');
        try {
          fs.rmSync(config.sessionDir, { recursive: true, force: true });
        } catch (_) {}
        if (!isReconnecting) {
          isReconnecting = true;
          log('INFO', 'Menyiapkan QR Code login baru dalam 3 detik...');
          if (reconnectTimer) clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            isReconnecting = false;
            startBot();
          }, 3000);
        }
      }
    }
  });

  // Pantau pesan masuk dengan filter anti-duplikasi & auto-ack
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      // Filter terpadu: abaikan jika pesan sudah pernah diproses, pesan stale/lama, atau pesan echo dari bot sendiri
      if (shouldIgnoreMessage(msg, config.prefixes)) {
        continue;
      }

      // Beritahu WhatsApp bahwa pesan telah diterima (mencegah server WhatsApp melakukan retry pengiriman berulang)
      if (msg.key && !msg.key.fromMe) {
        try {
          await sock.readMessages([msg.key]);
        } catch (_) {}
      }

      try {
        await handleMessage(sock, msg, startTime);
      } catch (err) {
        log('ERROR', `Error menangani pesan: ${err.message}`);
      }
    }
  });

  // Pantau member bergabung / keluar grup (Welcome & Leave) dengan anti-duplikasi event
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id, participants, action } = update;
      const groupConfig = db.getGroup(id);
      if (!groupConfig.welcome) return;

      const groupMetadata = await sock.groupMetadata(id).catch(() => null);
      const groupName = groupMetadata ? groupMetadata.subject : 'Grup';

      if (groupMetadata && Array.isArray(groupMetadata.participants)) {
        for (const p of groupMetadata.participants) {
          if (p.lid && p.id && !p.id.endsWith('@lid')) {
            const clean = normalizePhoneNumber(p.id);
            if (clean && isValidPhoneNumber(clean)) {
              userDb.saveLidMapping(p.lid, clean);
            }
          }
        }
      }

      for (const participant of participants) {
        // Cegah pengiriman pesan welcome/leave ganda akibat re-sync event grup WhatsApp
        if (isDuplicateGroupEvent(id, action, participant)) {
          continue;
        }

        const userNum = getRealPhoneNumber(participant, sock, groupMetadata);
        if (!userNum) {
          // Abaikan jika bukan nomor WhatsApp asli
          continue;
        }

        if (action === 'add') {
          const welcomeText = `👋 *SELAMAT DATANG DI ${groupName.toUpperCase()}!*\n\n` +
            `Halo @${userNum}! Selamat bergabung di grup ini.\n` +
            `Silakan patuhi peraturan grup dan perkenalkan diri Anda.\n\n` +
            `_Ketik *.menu* untuk melihat fitur SikanBot._`;

          // Hanya mention jika participant valid
          const activeMentions = groupMetadata?.participants?.some((p) => p.id?.includes(userNum))
            ? [`${userNum}@s.whatsapp.net`]
            : [];

          await sock.sendMessage(id, {
            text: welcomeText,
            mentions: activeMentions
          });
        } else if (action === 'remove') {
          // KHUSUS EVENT LEAVE/KICK: Jangan masukkan nomor ke mentionedJid karena user sudah bukan participant aktif!
          const leaveText = `👋 Selamat tinggal @${userNum}.\nSemoga harimu menyenangkan di luar grup ini!`;
          await sock.sendMessage(id, {
            text: leaveText
          });
        }
      }
    } catch (e) {
      log('ERROR', `Gagal memproses group update: ${e.message}`);
    }
  });
}

/**
 * Inisialisasi Express API Server untuk menerima trigger pesan dari Web Tugas Kuliah / service eksternal
 */
function initApiServer() {
  if (apiServer) return;

  const app = express();
  app.use(cors());
  app.use(express.json());

  // Health check & status bot
  app.get('/api/status', (req, res) => {
    res.json({
      status: true,
      botReady: !!currentSock,
      uptime: formatUptime(process.uptime()),
      botName: config.botName
    });
  });

  // Endpoint untuk menerima kiriman pesan ke WhatsApp grup atau kontak
  app.post('/api/send-group', async (req, res) => {
    try {
      const { groupId, message } = req.body;

      if (!groupId || !message) {
        return res.status(400).json({
          status: false,
          error: 'Parameter "groupId" dan "message" wajib diisi!'
        });
      }

      if (!currentSock) {
        return res.status(503).json({
          status: false,
          error: 'SikanBot belum terhubung ke WhatsApp. Pastikan bot dalam status Online.'
        });
      }

      // Pastikan suffix jid sesuai format WhatsApp
      let targetJid = String(groupId).trim();
      if (!targetJid.includes('@')) {
        targetJid = targetJid + '@g.us';
      }

      await currentSock.sendMessage(targetJid, { text: message });

      log('SUCCESS', `[API] Berhasil mengirim pesan notifikasi ke: ${targetJid}`);
      return res.json({
        status: true,
        message: 'Pesan berhasil terkirim ke grup!'
      });
    } catch (err) {
      log('ERROR', `[API Error] Gagal mengirim pesan via API: ${err.message}`);
      return res.status(500).json({
        status: false,
        error: err.message
      });
    }
  });

  const port = config.apiPort || 3000;
  apiServer = app.listen(port, '0.0.0.0', () => {
    log('SUCCESS', `[API] Server HTTP SikanBot aktif di port ${port} (http://0.0.0.0:${port})`);
  });
}

// Menangani shutdown graceful
process.on('SIGINT', () => {
  console.log('\n');
  log('INFO', 'Menghentikan SikanBot...');
  if (apiServer) {
    try {
      apiServer.close();
    } catch (_) {}
  }
  cleanDirectory(config.tempDir, 0);
  cleanDirectory(config.downloadDir, 0);
  db.saveNow();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  log('ERROR', `Uncaught Exception: ${err.message}`);
});

process.on('unhandledRejection', (reason) => {
  log('ERROR', `Unhandled Rejection: ${reason}`);
});

// Jalankan HTTP API Server & SikanBot
initApiServer();
startBot();
