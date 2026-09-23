# 🤖 SikanBot - WhatsApp Multi-Device Bot

Bot WhatsApp serbaguna, lengkap, dan modular yang dibangun dengan Node.js, Baileys Multi-Device, yt-dlp, dan FFmpeg. Dikembangkan oleh **Rahmat Haikal**.

---

## 👑 Profil Owner & Developer

```text
👑 OWNER — SikanBot

╭───〔 👑 OWNER BOT 〕
│
├ Nama      : Rahmat Haikal
├ Status    : Owner / Developer
├ Pendidikan: Mahasiswa
├ Kampus    : Politeknik Negeri Lhokseumawe
├ Jurusan   : Teknologi Rekayasa Jaringan Telekomunikasi
│
├ WhatsApp  : [0822 7725 6004]
├ Instagram : [rahmathaikal.05]
├ Email     : [rahmathaikal0506@gmail.com]
│
├ Bot       : SikanBot
├ Prefix    : .
│
╰──────────────
```

---

## 📋 Daftar Menu & Perintah Bot

```text
╭───〔 🤖 BOT MENU 〕
│
├ .menu (.start)
├ .help
├ .ping
├ .alive
├ .uptime
├ .runtime
├ .bot
├ .owner
├ .script
├ .infobot
├ .donate
├ .groups
├ .blocklist
╰──────────────

╭───〔 📥 DOWNLOAD 〕
│
├ .play
├ .play2
├ .yts
├ .tt / .tiktok (video & slide foto)
├ .ttfoto / .tiktokfoto
├ .tiktokstalk
├ .ig / .reel (video, foto, carousel)
├ .igstory / .story (unduh story IG)
├ .facebook
├ .twitter
├ .spotify
├ .mediafire
├ .gdrive
├ .gitclone
├ .pinterest
├ .img
╰──────────────

╭───〔 🔎 SEARCH 〕
│
├ .google
├ .yts
├ .img
├ .pinterest
╰──────────────

╭───〔 🎮 GAME & FUN 〕
│
├ .tictactoe
├ .delttt
├ .math
├ .ppt
├ .slot
├ .casino
├ .yourmom
├ .teri
├ .tebakgambar
├ .tebakkata
├ .suit
├ .coinflip
├ .dadu
╰──────────────

╭───〔 🧩 STICKER 〕
│
├ .sticker
├ .take
├ .smaker
├ .getsticker
├ .emix
├ .toimg
├ .tovid
├ .attp
├ .brat
╰──────────────

╭───〔 🛠️ TOOLS 〕
│
├ .calc
├ .pdf
├ .qrcode
├ .shorturl
├ .translate
├ .ssweb
├ .ocr
├ .weather
╰──────────────

╭───〔 👥 GROUP 〕
│
├ .add
├ .kick
├ .promote
├ .demote
├ .tagall
├ .hidetag
├ .groupinfo
├ .linkgroup
├ .revoke
├ .open
├ .close
├ .warn
├ .antilink
├ .antispam
├ .welcome
╰──────────────

╭───〔 👑 OWNER 〕
│
├ .addprem
├ .delprem
├ .listprem
├ .ban
├ .unban
├ .block
├ .unblock
├ .broadcast
├ .join
├ .leave
├ .restart
├ .shutdown
╰──────────────

╭───〔 🤖 AI 〕
│
├ .ai
├ .ask
├ .imagine
├ .translate
├ .summarize
╰──────────────
```

---

## 📁 Struktur File Project

```text
d:\botwa\
├── index.js          # Entry point Baileys, koneksi QR, dan event listener
├── handler.js        # Message dispatcher dan seluruh eksekutor perintah
├── config.js         # Konfigurasi bot, data owner, batas ukuran media, path
├── downloader.js     # Engine downloader yt-dlp & antrean video
├── utils.js          # Helper fungsi umum (format bytes, uptime, logger, banner)
├── lib/
│   ├── database.js   # Database JSON lokal (pengaturan grup, banned, premium, koin)
│   ├── games.js      # Game Engine (TicTacToe, Math Quiz, Tebak Gambar, Slot, dll.)
│   ├── scraper.js    # API Scraper & Fetcher (TikTok, YouTube, AI, Google, Cuaca, QR, PDF)
│   └── sticker.js    # Modul konversi WebP Stiker, EXIF metadata, toimg & tovid
├── downloads/        # Folder penampung video sementara
├── temp/             # Folder file sementara konversi stiker & audio
├── session/          # Folder autentikasi sesi WhatsApp
├── yt-dlp.exe        # Binary executable yt-dlp untuk Windows
└── package.json      # Dependensi Node.js (@whiskeysockets/baileys, axios, qrcode, pdfkit)
```

---

## 🚀 Cara Menjalankan Bot

1. Pastikan dependensi sudah terinstal:
   ```powershell
   npm.cmd install
   ```

2. Jalankan bot:
   ```powershell
   npm.cmd start
   ```
   atau
   ```powershell
   node index.js
   ```

3. Scan QR Code yang muncul di terminal menggunakan aplikasi WhatsApp di ponsel Anda (**WhatsApp > Perangkat Tertaut > Tautkan Perangkat**).
4. Setelah terhubung, bot langsung siap menerima perintah dengan prefix `.` (titik).
