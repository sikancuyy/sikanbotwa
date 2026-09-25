const path = require('path');

module.exports = {
  // Informasi Dasar Bot
  botName: 'SikanBot',
  botVersion: '2.0.0',
  prefix: '.',
  prefixes: ['.', '/', '!'],

  // Profil Lengkap Pemilik (Owner)
  owner: {
    name: 'Rahmat Haikal',
    role: 'Owner & Developer',
    status: 'Owner / Developer',
    education: 'Mahasiswa',
    campus: 'Politeknik Negeri Lhokseumawe',
    major: 'Teknologi Rekayasa Jaringan Telekomunikasi',
    // Nomor yang tampil di publik (profil / kontak bot)
    phone: '0822 7725 6004',
    publicPhone: '0822 7725 6004',
    publicNumber: '6282277256004',
    // Nomor akun utama Owner untuk akses & kontrol bot
    number: '6282267034994',
    jid: '6282267034994@s.whatsapp.net',
    numbers: ['6282267034994', '6282277256004'],
    instagram: 'rahmathaikal.05',
    email: 'rahmathaikal0506@gmail.com',
    github: 'sikancuyy'
  },

  // Lokasi Folder Penyimpanan
  sessionDir: path.join(__dirname, 'session'),
  tempDir: path.join(__dirname, 'temp'),
  downloadDir: path.join(__dirname, 'downloads'),
  databasePath: path.join(__dirname, 'database.json'),

  // Konfigurasi Binary Eksternal
  ytdlp: {
    command: process.env.YTDLP_PATH || 'yt-dlp',
    localCandidates: [
      path.join(__dirname, 'yt-dlp.exe'),
      path.join(__dirname, 'bin', 'yt-dlp.exe')
    ]
  },
  ffmpeg: {
    command: process.env.FFMPEG_PATH || 'ffmpeg',
    localCandidates: [
      path.join(__dirname, 'ffmpeg.exe'),
      path.join(__dirname, 'bin', 'ffmpeg.exe')
    ]
  },

  // Metadata Stiker Default
  sticker: {
    packname: 'SikanBot',
    author: 'Rahmat Haikal'
  },

  // Batasan Download & Sistem
  maxFileSizeMB: 70,
  downloadTimeoutMs: 3 * 60 * 1000,
  maxConcurrentDownloads: 2,

  // Konfigurasi API Server
  apiPort: process.env.PORT || 3000,

  // Donasi
  donate: {
    name: 'RAHMAT HAIKAL',
    dana: '082267034994',
    gopay: '082267034994',
    saweria: 'https://saweria.co/sikancuyy'
  }
};
