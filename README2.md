# 📱 PANDUAN LENGKAP RUNNING DI HP (ANDROID / TERMUX)

Panduan ini dikhususkan bagi Anda yang ingin menjalankan **WhatsApp Video Downloader Bot** langsung di smartphone Android tanpa memerlukan laptop atau komputer yang menyala terus-menerus.

---

## 📋 Persyaratan Awal
- Smartphone Android (RAM minimal 2 GB disarankan).
- Koneksi Internet yang stabil.
- Aplikasi **Termux (Wajib versi F-Droid)**.

> ⚠️ **PENTING:** Jangan download Termux dari Google Play Store karena versinya sudah usang dan paket instalasinya akan error. Download APK Termux resmi dari F-Droid:
> 👉 **[Download Termux APK (F-Droid)](https://f-droid.org/packages/com.termux/)**

---

## 🚀 Langkah Instalasi dari Nol di Termux

Buka aplikasi **Termux**, lalu salin dan jalankan perintah berikut secara berurutan:

### Langkah 1: Update & Upgrade Paket Termux
```bash
pkg update -y && pkg upgrade -y
```
*(Jika muncul pertanyaan `[default=N]`, cukup tekan **Enter** pada keyboard)*

---

### Langkah 2: Berikan Izin Akses Penyimpanan
```bash
termux-setup-storage
```
*(Akan muncul pop-up izin akses file di HP Anda, pilih **Izinkan / Allow**)*

---

### Langkah 3: Install Node.js, Python, FFmpeg, dan Git
```bash
pkg install nodejs-lts python ffmpeg git -y
```

---

### Langkah 4: Pasang yt-dlp di Android
```bash
pip install yt-dlp
```
*Verifikasi instalasi yt-dlp:*
```bash
yt-dlp --version
```

---

## 📂 Memasukkan Script Bot ke HP

Pilih salah satu cara yang paling mudah bagi Anda:

### Opsi A: Salin Folder dari Laptop ke HP (Tanpa Internet Tambahan)
1. Sambungkan HP ke Laptop via kabel data USB.
2. Salin folder `botwa` dari laptop ke memori internal HP (misal diletakkan di folder `Download`).
3. Buka Termux, lalu masuk ke folder tersebut:
   ```bash
   cd /sdcard/Download/botwa
   ```
4. Install dependensi bot:
   ```bash
   npm install
   ```

### Opsi B: Clone Langsung via Git (Jika Project di GitHub)
```bash
git clone <URL_REPO_GITHUB_ANDA>
cd botwa
npm install
```

---

## ▶️ Menjalankan Bot di HP

Di dalam folder project pada Termux, jalankan:

```bash
node index.js
```

Termux akan memunculkan **QR Code** di layar terminal HP Anda.

---

## 📲 Cara Scan QR Code di HP

Jika bot dijalankan di HP yang sama dengan nomor WhatsApp Anda, kamera tidak bisa langsung memotret layar sendiri. Gunakan trik berikut:

1. **Gunakan Bantuan Layar Kedua (Laptop / HP Lain)**:
   - Screenshot QR Code yang muncul di layar Termux.
   - Kirim foto screenshot tersebut ke HP teman, HP keluarga, atau layar laptop Anda.
   - Buka WhatsApp di HP Anda > **Titik 3 / Pengaturan** > **Perangkat Tertaut (Linked Devices)** > **Tautkan Perangkat**.
   - Arahkan kamera HP Anda ke foto QR yang ada di layar kedua tersebut.

2. **Gunakan Nomor WhatsApp di HP Kedua**:
   - Jika nomor bot menggunakan nomor di HP lain, Anda tinggal mengarahkan kamera HP kedua ke layar Termux HP pertama.

Setelah terhubung, terminal Termux akan menampilkan:
```text
====================================
       WHATSAPP VIDEO BOT
====================================
Status : Connected
Number : +62xxxxxxxxxx
Mode   : Ready
====================================
```

---

## 🔋 Tips Agar Bot Tetap Aktif 24 Jam (Tidak Dimatikan Android)

Sistem Android secara otomatis mematikan aplikasi latar belakang untuk menghemat baterai. Agar bot tidak terputus:

1. **Aktifkan Wakelock Termux**:
   - Tarik menu notifikasi atas di HP Anda.
   - Pada notifikasi Termux, klik tombol **Acquire Wakelock**.
2. **Nonaktifkan Optimasi Baterai**:
   - Masuk ke **Pengaturan HP** > **Aplikasi** > **Termux** > **Baterai**.
   - Ubah dari *Dioptimalkan* menjadi **Tidak Dibatasi (Unrestricted / Don't optimize)**.
3. **Kunci Aplikasi di Recent Apps**:
   - Buka tampilan *Recent Apps* (multitasking).
   - Tekan dan tahan ikon Termux, lalu pilih opsi **Kunci / Gembok (Lock)** agar tidak terhapus saat membersihkan RAM.

---

## 🛑 Cara Menghentikan Bot di HP

Untuk mematikan bot, tekan:
```text
Volume Bawah + C
```
atau tekan tombol `Ctrl` lalu huruf `c` pada baris tombol tambahan Termux.
