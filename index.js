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

// Waktu mulai bot untuk kalkulasi uptime
const startTime = Date.now();

// Pastikan semua folder yang dibutuhkan siap
ensureDirs([config.sessionDir, config.tempDir, config.downloadDir]);

// Bersihkan file sementara dari sesi sebelumnya (jika ada)
cleanDirectory(config.tempDir, 0);
cleanDirectory(config.downloadDir, 0);

/**
 * Fungsi utama untuk menginisialisasi SikanBot
 */
async function startBot() {
  log('INFO', 'Menginisialisasi SikanBot WhatsApp session...');

  // Cek ketersediaan yt-dlp saat startup
  const isYtDlpReady = await checkYtDlpAvailable();
  if (!isYtDlpReady) {
    log('WARN', 'Peringatan: yt-dlp belum terdeteksi di sistem!');
  } else {
    log('SUCCESS', 'yt-dlp & FFmpeg siap digunakan.');
  }

  // Muat status autentikasi multi-file
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionDir);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  log('INFO', `Menggunakan Baileys v${version.join('.')} (Latest: ${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: false,
    browser: ['SikanBot', 'Chrome', '122.0.0']
  });

  // Simpan kredensial setiap ada update auth
  sock.ev.on('creds.update', saveCreds);

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
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log('WARN', `Koneksi terputus (Status: ${statusCode || 'Unknown'}). Reconnect: ${shouldReconnect}`);

      if (shouldReconnect) {
        log('INFO', 'Menghubungkan kembali dalam 5 detik...');
        setTimeout(startBot, 5000);
      } else {
        log('ERROR', 'Sesi telah keluar (Logged Out). Hapus folder "session" lalu scan ulang.');
      }
    }
  });

  // Pantau pesan masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        await handleMessage(sock, msg, startTime);
      } catch (err) {
        log('ERROR', `Error menangani pesan: ${err.message}`);
      }
    }
  });

  // Pantau member bergabung / keluar grup (Welcome & Leave)
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id, participants, action } = update;
      const groupConfig = db.getGroup(id);
      if (!groupConfig.welcome) return;

      const groupMetadata = await sock.groupMetadata(id).catch(() => null);
      const groupName = groupMetadata ? groupMetadata.subject : 'Grup';

      for (const participant of participants) {
        const userNum = participant.split('@')[0];

        if (action === 'add') {
          const welcomeText = `👋 *SELAMAT DATANG DI ${groupName.toUpperCase()}!*\n\n` +
            `Halo @${userNum}! Selamat bergabung di grup ini.\n` +
            `Silakan patuhi peraturan grup dan perkenalkan diri Anda.\n\n` +
            `_Ketik *.menu* untuk melihat fitur SikanBot._`;

          await sock.sendMessage(id, {
            text: welcomeText,
            mentions: [participant]
          });
        } else if (action === 'remove') {
          const leaveText = `👋 Selamat tinggal @${userNum}.\nSemoga harimu menyenangkan di luar grup ini!`;
          await sock.sendMessage(id, {
            text: leaveText,
            mentions: [participant]
          });
        }
      }
    } catch (e) {
      log('ERROR', `Gagal memproses group update: ${e.message}`);
    }
  });
}

// Menangani shutdown graceful
process.on('SIGINT', () => {
  console.log('\n');
  log('INFO', 'Menghentikan SikanBot...');
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

// Jalankan SikanBot
startBot();
