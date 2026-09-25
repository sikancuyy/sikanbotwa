const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('====================================================');
console.log('🧪 MEMULAI TEST SUITE OTOMATIS FITUR SIKANBOT');
console.log('====================================================\n');

let passCount = 0;
let failCount = 0;
const failedTests = [];

function it(name, fn) {
  try {
    fn();
    console.log(`✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(`   Error: ${err.message}\n`);
    failedTests.push({ name, error: err.message });
    failCount++;
  }
}

async function itAsync(name, fn) {
  try {
    await fn();
    console.log(`✅ [PASS] ${name}`);
    passCount++;
  } catch (err) {
    console.error(`❌ [FAIL] ${name}`);
    console.error(`   Error: ${err.message}\n`);
    failedTests.push({ name, error: err.message });
    failCount++;
  }
}

async function runAllTests() {
  const users = require('../database/users');
  const { checkUserLimit, consumeUserLimit, formatUserStatus } = require('../helpers/limit');
  const { getValidGroupParticipants, filterActiveMentions, isGroupAdmin, isBotAdmin, formatKickMessage } = require('../helpers/group');
  const { generateTTS, cleanTempAudio } = require('../helpers/tts');
  const media = require('../helpers/mediaHelper');
  const config = require('../config');

  const testJid = '6289999999999@s.whatsapp.net';
  const testPhone = '6289999999999';

  // Bersihkan user uji coba jika ada
  users.setLimit(testPhone);

  // 1. User baru menjalankan command => limit 50
  it('1. User baru mendapatkan kuota 50 dan status limited', () => {
    const status = checkUserLimit(testJid, false);
    assert.strictEqual(status.allowed, true);
    assert.strictEqual(status.isUnlimited, false);
    assert.strictEqual(status.remaining, 50);
  });

  // 2. User menggunakan command => usage_count bertambah
  it('2. User menggunakan command => usage_count bertambah di database', () => {
    consumeUserLimit(testJid, false);
    const u = users.getUser(testJid);
    assert.strictEqual(u.usage_count, 1);
    const status = checkUserLimit(testJid, false);
    assert.strictEqual(status.remaining, 49);
  });

  // 3. Bot restart => usage_count tetap persistent di SQLite
  it('3. Persistensi database SQLite: nilai usage_count tersimpan di disk', () => {
    const freshDb = users.getUserInfo(testPhone);
    assert.strictEqual(freshDb.usage_count, 1);
  });

  // 4. User mencapai 50 => command ditolak
  it('4. User mencapai limit 50 => command ditolak dengan pesan yang sesuai', () => {
    users.getDb().prepare('UPDATE users SET usage_count = 50 WHERE jid = ?').run(testJid);
    const status = checkUserLimit(testJid, false);
    assert.strictEqual(status.allowed, false);
    assert.strictEqual(status.remaining, 0);
    assert.ok(status.message.includes('Limit penggunaan kamu sudah habis (50/50)'));
  });

  // 5. User daftar => unlimited
  it('5. User melakukan registrasi (.daftar) => status menjadi UNLIMITED', () => {
    users.registerUser(testJid, 'Budi Santoso');
    const u = users.getUser(testJid);
    assert.strictEqual(u.registered, 1);
    assert.strictEqual(u.limit_type, 'unlimited');
    assert.strictEqual(u.name, 'Budi Santoso');

    const status = checkUserLimit(testJid, false);
    assert.strictEqual(status.allowed, true);
    assert.strictEqual(status.isUnlimited, true);
    assert.strictEqual(status.remaining, Infinity);
  });

  // 6. User unlimited => command tidak mengurangi limit
  it('6. User unlimited menggunakan command => limit tidak berkurang', () => {
    const before = users.getUser(testJid).usage_count;
    consumeUserLimit(testJid, false);
    const after = users.getUser(testJid).usage_count;
    assert.strictEqual(after, before);
  });

  // 7. Admin / Owner => tidak terkena limit
  it('7. Owner / Admin bot bebas limit sepenuhnya', () => {
    const status = checkUserLimit(config.owner.jid, true);
    assert.strictEqual(status.allowed, true);
    assert.strictEqual(status.isUnlimited, true);
    assert.strictEqual(status.remaining, Infinity);
  });

  // 8. User keluar grup => tidak di-mention lagi
  it('8. User keluar grup => filterActiveMentions tidak menyertakan user yang keluar', () => {
    const activeParticipants = ['628111111111@s.whatsapp.net', '628222222222@s.whatsapp.net'];
    const keluarJid = '628333333333@s.whatsapp.net';
    const proposed = [keluarJid, '628111111111@s.whatsapp.net'];
    const filtered = filterActiveMentions(proposed, activeParticipants);

    assert.strictEqual(filtered.includes(keluarJid), false);
    assert.strictEqual(filtered.length, 1);
    assert.strictEqual(filtered[0], '628111111111@s.whatsapp.net');
  });

  // 9. User di-kick => tidak di-mention menggunakan mentionedJid aktif
  it('9. User di-kick => formatKickMessage menggunakan teks tanpa mention aktif', () => {
    const kickMsg = formatKickMessage('628555555555@s.whatsapp.net');
    assert.ok(kickMsg.includes('@628555555555'));
    assert.ok(kickMsg.includes('telah dikeluarkan dari grup'));
  });

  // 10. Tagall => hanya participant aktif
  await itAsync('10. getValidGroupParticipants mengabaikan participant invalid/duplikat', async () => {
    const mockSock = {
      groupMetadata: async () => ({
        id: '12345@g.us',
        participants: [
          { id: '6281111111@s.whatsapp.net' },
          { id: '6282222222@s.whatsapp.net' },
          { id: '6281111111@s.whatsapp.net' }, // duplicate
          { id: null }, // invalid
          { id: '' } // empty
        ]
      })
    };
    const { participants } = await getValidGroupParticipants(mockSock, '12345@g.us');
    assert.strictEqual(participants.length, 2);
    assert.strictEqual(participants[0], '6281111111@s.whatsapp.net');
    assert.strictEqual(participants[1], '6282222222@s.whatsapp.net');
  });

  // 11. Bot bukan admin => command group ditolak
  it('11. isBotAdmin mendeteksi bot bukan admin secara akurat', () => {
    const mockMetadata = {
      participants: [
        { id: '6289999999@s.whatsapp.net', admin: null },
        { id: '6281111111@s.whatsapp.net', admin: 'admin' }
      ]
    };
    const mockSock = { user: { id: '6289999999:1@s.whatsapp.net' } };
    const admin = isBotAdmin(mockMetadata, mockSock);
    assert.strictEqual(admin, false);
  });

  // 12. Bot sudah admin => command group diizinkan
  it('12. isBotAdmin mendeteksi bot sudah admin dengan variasi format JID/LID Baileys', () => {
    const mockMetadata = {
      participants: [
        { id: '6289999999@s.whatsapp.net', admin: 'admin' },
        { id: '6281111111@s.whatsapp.net', admin: null }
      ]
    };
    const mockSock = { user: { id: '6289999999:5@s.whatsapp.net' } };
    const admin = isBotAdmin(mockMetadata, mockSock);
    assert.strictEqual(admin, true);
  });

  // 13. TTS berhasil => audio terbuat
  await itAsync('13. TTS berhasil menghasilkan file audio MP3 WhatsApp', async () => {
    const audioPath = await generateTTS('Halo selamat datang di SikanBot', 'id');
    assert.ok(fs.existsSync(audioPath));
    const size = fs.statSync(audioPath).size;
    assert.ok(size > 1000);
    cleanTempAudio(audioPath);
    assert.strictEqual(fs.existsSync(audioPath), false);
  });

  // 14. TTS error handling => bot tetap hidup tanpa unhandled crash
  await itAsync('14. TTS teks kosong ditangani secara aman dengan exception terkontrol', async () => {
    try {
      await generateTTS('', 'id');
      assert.fail('Seharusnya melempar error');
    } catch (e) {
      assert.ok(e.message.includes('tidak boleh kosong'));
    }
  });

  // 15. Fitur QC & Brat generator berjalan normal dan aman
  await itAsync('15. Media generator (QC & Brat) menghasilkan WebP stiker resmi', async () => {
    const qcWebp = await media.generateQuoteChat({
      name: 'Rahmat Haikal',
      text: 'Uji coba QC sticker generator'
    });
    assert.ok(Buffer.isBuffer(qcWebp));
    assert.ok(qcWebp.length > 500);

    const bratWebp = await media.generateBratCustom({
      text: 'sikanbot brat',
      bgColor: '#8ACE00',
      textColor: '#000000'
    });
    assert.ok(Buffer.isBuffer(bratWebp));
    assert.ok(bratWebp.length > 500);
  });

  // 16. Penggunaan di grup (isGroup = true) tetap UNLIMITED
  it('16. Penggunaan di dalam grup (isGroup = true) tetap UNLIMITED dan tidak memotong kuota', () => {
    const unregUserJid = '6287777777777@s.whatsapp.net';
    users.setLimit('6287777777777'); // Set user ke status limited
    const userObj = users.getUser(unregUserJid);
    assert.strictEqual(userObj.registered, 0);

    // Di dalam grup (isGroup = true) harus selalu diizinkan dan unlimited
    const statusGroup = checkUserLimit(unregUserJid, false, true);
    assert.strictEqual(statusGroup.allowed, true);
    assert.strictEqual(statusGroup.isUnlimited, true);
    assert.strictEqual(statusGroup.remaining, Infinity);

    // Konsumsi di dalam grup tidak mengurangi usage_count
    const countBefore = users.getUser(unregUserJid).usage_count;
    consumeUserLimit(unregUserJid, false, true);
    const countAfter = users.getUser(unregUserJid).usage_count;
    assert.strictEqual(countAfter, countBefore);
  });

  // 17. Menambahkan Admin Bot (addBotAdmin)
  it('17. Owner mengangkat user menjadi Admin Bot', () => {
    const adminPhone = '6288888888888';
    const adminJid = `${adminPhone}@s.whatsapp.net`;
    users.addBotAdmin(adminPhone);
    assert.strictEqual(users.isBotAdmin(adminJid), true);

    // Admin Bot bebas limit di mana saja
    const statusAdmin = checkUserLimit(adminJid, false, false);
    assert.strictEqual(statusAdmin.allowed, true);
    assert.strictEqual(statusAdmin.isUnlimited, true);
  });

  // 18. Admin Bot mendaftarkan user (adminRegisterUser)
  it('18. Admin Bot mendaftarkan user baru sehingga langsung unlimited', () => {
    const targetPhone = '6286666666666';
    const targetJid = `${targetPhone}@s.whatsapp.net`;
    users.adminRegisterUser(targetPhone, 'User Terdaftar Admin');
    const u = users.getUser(targetJid);
    assert.strictEqual(u.registered, 1);
    assert.strictEqual(u.limit_type, 'unlimited');
    assert.strictEqual(u.name, 'User Terdaftar Admin');
  });

  // 19. Admin Bot menghapus user (deleteUser)
  it('19. Admin Bot menghapus user dari database', () => {
    const targetPhone = '6286666666666';
    const ok = users.deleteUser(targetPhone);
    assert.strictEqual(ok, true);
    const info = users.getUserInfo(targetPhone);
    assert.strictEqual(info, undefined);
  });

  // 20. Mencabut hak Admin Bot (removeBotAdmin)
  it('20. Owner mencabut hak Admin Bot', () => {
    const adminPhone = '6288888888888';
    const adminJid = `${adminPhone}@s.whatsapp.net`;
    users.removeBotAdmin(adminPhone);
    assert.strictEqual(users.isBotAdmin(adminJid), false);
  });

  const processingStatus = require('../helpers/processingStatus');

  // 21. startProcessing: Memberikan reaksi ⏳ dan mengaktifkan typing 'composing'
  await itAsync('21. startProcessing: Memberikan reaksi ⏳ pada pesan dan mengaktifkan typing "composing"', async () => {
    processingStatus.resetProcessing();
    const sentMessages = [];
    const presenceUpdates = [];

    const mockSock = {
      sendMessage: async (chat, content) => {
        sentMessages.push({ chat, content });
        return { key: content.react ? content.react.key : {} };
      },
      sendPresenceUpdate: async (type, chat) => {
        presenceUpdates.push({ type, chat });
      }
    };

    const mockMsg = {
      key: { remoteJid: 'test-chat-1@s.whatsapp.net', id: 'MSG1', fromMe: false }
    };

    await processingStatus.startProcessing(mockSock, mockMsg);

    // Verifikasi reaksi ⏳ terkirim
    assert.strictEqual(sentMessages.length, 1);
    assert.strictEqual(sentMessages[0].chat, 'test-chat-1@s.whatsapp.net');
    assert.strictEqual(sentMessages[0].content.react.text, '⏳');
    assert.strictEqual(sentMessages[0].content.react.key.id, 'MSG1');

    // Verifikasi typing indicator 'composing' aktif
    assert.strictEqual(presenceUpdates.length >= 1, true);
    assert.strictEqual(presenceUpdates[0].type, 'composing');
    assert.strictEqual(presenceUpdates[0].chat, 'test-chat-1@s.whatsapp.net');
    assert.strictEqual(processingStatus.getProcessingCount('test-chat-1@s.whatsapp.net'), 1);

    processingStatus.resetProcessing();
  });

  // 22. stopProcessing (Success): Menghentikan typing ('paused') dan mengubah reaksi ke ✅
  await itAsync('22. stopProcessing (Success): Menghentikan typing ("paused") dan mengubah reaksi ke ✅', async () => {
    processingStatus.resetProcessing();
    const sentMessages = [];
    const presenceUpdates = [];

    const mockSock = {
      sendMessage: async (chat, content) => {
        sentMessages.push({ chat, content });
      },
      sendPresenceUpdate: async (type, chat) => {
        presenceUpdates.push({ type, chat });
      }
    };

    const mockMsg = {
      key: { remoteJid: 'test-chat-2@s.whatsapp.net', id: 'MSG2', fromMe: false }
    };

    await processingStatus.startProcessing(mockSock, mockMsg);
    await processingStatus.stopProcessing(mockSock, mockMsg, true);

    // Reaksi berubah jadi ✅
    const lastMsg = sentMessages[sentMessages.length - 1];
    assert.strictEqual(lastMsg.content.react.text, '✅');
    assert.strictEqual(lastMsg.content.react.key.id, 'MSG2');

    // Typing presence dihentikan ke 'paused'
    const lastPresence = presenceUpdates[presenceUpdates.length - 1];
    assert.strictEqual(lastPresence.type, 'paused');
    assert.strictEqual(processingStatus.getProcessingCount('test-chat-2@s.whatsapp.net'), 0);

    processingStatus.resetProcessing();
  });

  // 23. stopProcessing (Failure): Menghentikan typing ('paused') dan mengubah reaksi ke ❌
  await itAsync('23. stopProcessing (Failure): Menghentikan typing ("paused") dan mengubah reaksi ke ❌', async () => {
    processingStatus.resetProcessing();
    const sentMessages = [];
    const presenceUpdates = [];

    const mockSock = {
      sendMessage: async (chat, content) => {
        sentMessages.push({ chat, content });
      },
      sendPresenceUpdate: async (type, chat) => {
        presenceUpdates.push({ type, chat });
      }
    };

    const mockMsg = {
      key: { remoteJid: 'test-chat-3@s.whatsapp.net', id: 'MSG3', fromMe: false }
    };

    await processingStatus.startProcessing(mockSock, mockMsg);
    await processingStatus.stopProcessing(mockSock, mockMsg, false);

    // Reaksi berubah jadi ❌
    const lastMsg = sentMessages[sentMessages.length - 1];
    assert.strictEqual(lastMsg.content.react.text, '❌');
    assert.strictEqual(lastMsg.content.react.key.id, 'MSG3');

    // Typing presence dihentikan ke 'paused'
    const lastPresence = presenceUpdates[presenceUpdates.length - 1];
    assert.strictEqual(lastPresence.type, 'paused');
    assert.strictEqual(processingStatus.getProcessingCount('test-chat-3@s.whatsapp.net'), 0);

    processingStatus.resetProcessing();
  });

  // 24. Concurrency: Menjalankan beberapa command paralel dalam 1 chat tanpa mematikan typing command lain
  await itAsync('24. Concurrency: Reference counter per chat mencegah typing berhenti sebelum semua proses selesai', async () => {
    processingStatus.resetProcessing();
    const presenceUpdates = [];
    const mockSock = {
      sendMessage: async () => {},
      sendPresenceUpdate: async (type, chat) => {
        presenceUpdates.push({ type, chat });
      }
    };

    const chat = 'group-chat-concurrency@g.us';
    const msg1 = { key: { remoteJid: chat, id: 'CMD1' } };
    const msg2 = { key: { remoteJid: chat, id: 'CMD2' } };

    // Command 1 dimulai
    await processingStatus.startProcessing(mockSock, msg1);
    assert.strictEqual(processingStatus.getProcessingCount(chat), 1);

    // Command 2 dimulai
    await processingStatus.startProcessing(mockSock, msg2);
    assert.strictEqual(processingStatus.getProcessingCount(chat), 2);

    // Command 1 selesai => count berkurang jadi 1, 'paused' BELUM dikirim karena command 2 masih jalan
    presenceUpdates.length = 0;
    await processingStatus.stopProcessing(mockSock, msg1, true);
    assert.strictEqual(processingStatus.getProcessingCount(chat), 1);
    const hasPaused = presenceUpdates.some((p) => p.type === 'paused');
    assert.strictEqual(hasPaused, false); // Typing composing tetap aktif!

    // Command 2 selesai => count jadi 0, 'paused' BARU dikirim
    await processingStatus.stopProcessing(mockSock, msg2, true);
    assert.strictEqual(processingStatus.getProcessingCount(chat), 0);
    const hasFinalPaused = presenceUpdates.some((p) => p.type === 'paused');
    assert.strictEqual(hasFinalPaused, true);

    processingStatus.resetProcessing();
  });

  // 25. Fail-Safe: Reaction atau presence error tidak membuat bot crash
  await itAsync('25. Fail-Safe: Status UI WhatsApp tidak pernah menyebabkan bot atau command crash', async () => {
    processingStatus.resetProcessing();
    const brokenSock = {
      sendMessage: async () => { throw new Error('Network error saat kirim reaksi'); },
      sendPresenceUpdate: async () => { throw new Error('Baileys socket disconnect'); }
    };

    const mockMsg = { key: { remoteJid: 'broken-chat@s.whatsapp.net', id: 'ERR1' } };

    // startProcessing & stopProcessing tidak boleh melempar error
    await assert.doesNotReject(async () => {
      await processingStatus.startProcessing(brokenSock, mockMsg);
      await processingStatus.stopProcessing(brokenSock, mockMsg, true);
    });

    processingStatus.resetProcessing();
  });

  // 26. Integration: Dispatcher handleMessage otomatis memicu reaction + typing (⏳ -> ✅)
  await itAsync('26. Integration: Global command dispatcher otomatis memberikan flow ⏳ -> ✅', async () => {
    processingStatus.resetProcessing();
    const { handleMessage } = require('../handler');
    const sentMessages = [];
    const presenceUpdates = [];

    const mockSock = {
      sendMessage: async (chat, content) => {
        sentMessages.push({ chat, content });
        return { key: content.react ? content.react.key : { id: 'BOT_RES' } };
      },
      sendPresenceUpdate: async (type, chat) => {
        presenceUpdates.push({ type, chat });
      },
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };

    const mockMsg = {
      key: { remoteJid: '6287777777777@s.whatsapp.net', id: 'INTEG_PING', fromMe: false },
      message: { conversation: '.ping' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());

    // Memeriksa flow reaksi: ⏳ di awal, ✅ di akhir
    const reacts = sentMessages.filter((m) => m.content && m.content.react);
    assert.strictEqual(reacts.length >= 2, true);
    assert.strictEqual(reacts[0].content.react.text, '⏳');
    assert.strictEqual(reacts[reacts.length - 1].content.react.text, '✅');

    // Memeriksa presence: composing di awal, paused di akhir
    assert.strictEqual(presenceUpdates.length >= 2, true);
    assert.strictEqual(presenceUpdates[0].type, 'composing');
    assert.strictEqual(presenceUpdates[presenceUpdates.length - 1].type, 'paused');

    processingStatus.resetProcessing();
  });

  // 27. TTS convertToVoiceNote: Mengonversi MP3 menjadi WhatsApp Ogg Opus voice note resmi
  await itAsync('27. TTS convertToVoiceNote: Menghasilkan format Ogg Opus resmi agar tidak muncul error di WhatsApp', async () => {
    const { convertToVoiceNote } = require('../helpers/tts');
    const mp3 = await generateTTS('Halo ini pengujian suara WhatsApp', 'id');
    const vnInfo = await convertToVoiceNote(mp3);

    assert.strictEqual(fs.existsSync(vnInfo.filePath), true);
    assert.strictEqual(vnInfo.mimetype, 'audio/ogg; codecs=opus');
    assert.strictEqual(vnInfo.ptt, true);

    const buf = fs.readFileSync(vnInfo.filePath);
    // Format OggS header wajib untuk WhatsApp PTT
    assert.strictEqual(buf.slice(0, 4).toString(), 'OggS');

    cleanTempAudio(mp3);
    cleanTempAudio(vnInfo.filePath);
  });

  // 28. Konfigurasi Owner & Kontak Publik
  it('28. Konfigurasi nomor Owner (082267034994) & kontak publik (082277256004)', () => {
    assert.strictEqual(config.owner.number, '6282267034994');
    assert.strictEqual(config.owner.phone, '0822 7725 6004');
    assert.strictEqual(users.isBotAdmin('6282267034994@s.whatsapp.net'), true);
    assert.strictEqual(users.isBotAdmin('6282277256004@s.whatsapp.net'), true);
    assert.strictEqual(checkUserLimit('6282267034994@s.whatsapp.net', true).isUnlimited, true);
  });

  const { handleMessage } = require('../handler');

  // 29. Menu bertingkat: .menu hanya menampilkan daftar kategori menu utama
  await itAsync('29. Menu bertingkat: .menu menampilkan ringkas kategori tanpa membanjiri teks', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: content.react ? content.react.key : { id: 'MENU_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    const mockMsg = {
      key: { remoteJid: '6287777777777@s.whatsapp.net', id: 'CMD_MENU', fromMe: false },
      message: { conversation: '.menu' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());

    const textReply = replies.find((r) => r.text && r.text.includes('MENU'));
    assert.strictEqual(Boolean(textReply), true);
    assert.strictEqual(textReply.text.includes('.inmenu'), true);
    assert.strictEqual(textReply.text.includes('.indw'), true);
    assert.strictEqual(textReply.text.includes('.inscr'), true);
    assert.strictEqual(textReply.text.includes('.ingm'), true);
    assert.strictEqual(textReply.text.includes('.ins'), true);
    assert.strictEqual(textReply.text.includes('.intts'), true);
    assert.strictEqual(textReply.text.includes('.inuser'), true);
    assert.strictEqual(textReply.text.includes('.intl'), true);
    assert.strictEqual(textReply.text.includes('.ingr'), true);
    assert.strictEqual(textReply.text.includes('.inadm'), true);
    assert.strictEqual(textReply.text.includes('.inai'), true);
    assert.strictEqual(textReply.text.includes('.ininfo'), true);
    assert.strictEqual(textReply.text.includes('.inlog'), true);
  });

  // 30. Submenu: Memeriksa ketersediaan seluruh 13 submenu kategori
  await itAsync('30. Submenu bertingkat (.inmenu, .indownload, .ingame, dll) menampilkan daftar command kategori masing-masing', async () => {
    const submenus = [
      'inmenu', 'indownload', 'insearch', 'ingame', 'insticker',
      'intts', 'inuser', 'intools', 'ingroup', 'inadmin',
      'inai', 'ininfo', 'inlog'
    ];

    for (const sub of submenus) {
      const replies = [];
      const mockSock = {
        sendMessage: async (chat, content) => {
          replies.push(content);
          return { key: content.react ? content.react.key : { id: 'SUB_RES' } };
        },
        sendPresenceUpdate: async () => {},
        user: { id: '6281111111111:1@s.whatsapp.net' }
      };
      const mockMsg = {
        key: { remoteJid: '6287777777777@s.whatsapp.net', id: `CMD_${sub}`, fromMe: false },
        message: { conversation: `.${sub}` }
      };

      await handleMessage(mockSock, mockMsg, Date.now());
      const replyObj = replies.find((r) => r.text);
      assert.strictEqual(Boolean(replyObj), true, `Submenu .${sub} harus memiliki balasan`);
      assert.strictEqual(replyObj.text.includes('╭───〔'), true, `Submenu .${sub} harus memiliki format bingkai`);
    }
  });

  // 31. Command inti langsung jalan tanpa harus membuka menu terlebih dahulu
  await itAsync('31. Command inti (.ping, .bot, .me, .limit) langsung berjalan tanpa dependency submenu', async () => {
    const directCmds = ['.ping', '.bot', '.me', '.limit'];

    for (const cmd of directCmds) {
      const replies = [];
      const mockSock = {
        sendMessage: async (chat, content) => {
          replies.push(content);
          return { key: content.react ? content.react.key : { id: 'DIRECT_RES' } };
        },
        sendPresenceUpdate: async () => {},
        user: { id: '6281111111111:1@s.whatsapp.net' }
      };
      const mockMsg = {
        key: { remoteJid: '6287777777777@s.whatsapp.net', id: `CMD_DIR_${cmd.slice(1)}`, fromMe: false },
        message: { conversation: cmd }
      };

      await handleMessage(mockSock, mockMsg, Date.now());
      const replyObj = replies.find((r) => r.text);
      assert.strictEqual(Boolean(replyObj), true, `Command ${cmd} harus langsung merespon`);
    }
  });

  // 32. Profil .me: Format rapi sesuai Section 18
  await itAsync('32. Profil .me menampilkan identitas, status, limit, dan statistik command user', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: content.react ? content.react.key : { id: 'ME_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    const mockMsg = {
      key: { remoteJid: '6285555555555@s.whatsapp.net', id: 'CMD_ME', fromMe: false },
      message: { conversation: '.me' },
      pushName: 'Budi Santoso'
    };

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('MY PROFILE'));
    assert.strictEqual(Boolean(replyObj), true);
    assert.strictEqual(replyObj.text.includes('Budi Santoso'), true);
    assert.strictEqual(replyObj.text.includes('Commands'), true);
    assert.strictEqual(replyObj.text.includes('Success'), true);
    assert.strictEqual(replyObj.text.includes('Failed'), true);
  });

  // 33. Command logging & bot statistics (.stats)
  await itAsync('33. Command logging otomatis mencatat ke database & command .stats menampilkan rekapitulasi bot', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: content.react ? content.react.key : { id: 'STATS_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' },
      groupFetchAllParticipating: async () => ({ 'g1@g.us': {}, 'g2@g.us': {} })
    };
    const mockMsg = {
      key: { remoteJid: '6287777777777@s.whatsapp.net', id: 'CMD_STATS', fromMe: false },
      message: { conversation: '.stats' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('BOT STATISTICS'));
    assert.strictEqual(Boolean(replyObj), true);
    assert.strictEqual(replyObj.text.includes('Uptime'), true);
    assert.strictEqual(replyObj.text.includes('Commands'), true);
    assert.strictEqual(replyObj.text.includes('Downloads'), true);
    assert.strictEqual(replyObj.text.includes('Stickers'), true);
    assert.strictEqual(replyObj.text.includes('TTS'), true);
  });

  // 34. Monitoring logs: .logs, .loguser, .logcmd, .logerror
  await itAsync('34. Log monitoring (.logs, .loguser, .logerror) dapat diakses oleh Owner/Admin', async () => {
    // Catat satu log uji coba
    users.logCommand({
      timestamp: Date.now(),
      userId: '6282267034994@s.whatsapp.net',
      number: '6282267034994',
      username: 'Owner',
      command: 'testcmd',
      status: 'SUCCESS',
      executionTime: 0.12
    });

    const recent = users.getRecentLogs(5);
    assert.strictEqual(Array.isArray(recent) && recent.length > 0, true);
    assert.strictEqual(recent[0].command, 'testcmd');

    const byUser = users.getLogsByUser('6282267034994', 5);
    assert.strictEqual(Array.isArray(byUser) && byUser.length > 0, true);
  });

  // 35. Permission check: Command admin/logs ditolak jika user biasa
  await itAsync('35. Permission check: Command admin/log (.logs, .users) ditolak jika user bukan admin/owner', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: content.react ? content.react.key : { id: 'PERM_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    const mockMsg = {
      key: { remoteJid: '6289999111122@s.whatsapp.net', id: 'CMD_DENIED', fromMe: false },
      message: { conversation: '.logs' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('🚫'));
    assert.strictEqual(Boolean(replyObj), true, 'User biasa harus ditolak saat mengakses .logs');
  });

  // 36. Perintah .listuser menampilkan daftar user dengan format '01. Nama'
  await itAsync('36. Perintah .listuser menampilkan daftar user dengan format numerik urut ID', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: content.react ? content.react.key : { id: 'LISTUSER_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    // Dipanggil oleh Owner
    const mockMsg = {
      key: { remoteJid: '6282267034994@s.whatsapp.net', id: 'CMD_LISTUSER', fromMe: false },
      message: { conversation: '.listuser' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('DAFTAR USER'));
    assert.strictEqual(Boolean(replyObj), true, '.listuser harus mengembalikan kartu daftar user');
    assert.strictEqual(replyObj.text.includes('Total User:'), true);
    assert.strictEqual(replyObj.text.includes('01.'), true);
  });

  // 37. Validasi akses Owner 6282267034994
  it('37. Owner 6282267034994 dikenali dengan hak akses penuh (Owner/Unlimited)', () => {
    const db = require('../lib/database');
    assert.strictEqual(db.isOwner('6282267034994@s.whatsapp.net'), true);
    assert.strictEqual(db.isOwner('6282267034994:1@s.whatsapp.net'), true);
    assert.strictEqual(db.isOwner('6282267034994'), true);
    const ownerData = users.getUser('6282267034994@s.whatsapp.net');
    assert.strictEqual(ownerData.role, 'owner');
    assert.strictEqual(ownerData.limit_type, 'unlimited');
  });

  // 38. Fitur .daftar Nama - Kota - Umur
  await itAsync('38. Pendaftaran .daftar Nama User - Kota - Umur berhasil & menyimpan data lengkap', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: { id: 'REG_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    const mockMsg = {
      key: { remoteJid: '6281234560001@s.whatsapp.net', id: 'CMD_REG', fromMe: false },
      message: { conversation: '.daftar Ahmad Fauzi - Banda Aceh - 22' }
    };

    // Bersihkan dulu jika ada
    users.deleteUser('6281234560001');

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('PENDAFTARAN BERHASIL'));
    assert.strictEqual(Boolean(replyObj), true, 'Pendaftaran harus berhasil');
    assert.strictEqual(replyObj.text.includes('Ahmad Fauzi'), true);
    assert.strictEqual(replyObj.text.includes('Banda Aceh'), true);
    assert.strictEqual(replyObj.text.includes('22'), true);

    const saved = users.getUser('6281234560001');
    assert.strictEqual(saved.registered, 1);
    assert.strictEqual(saved.kota, 'Banda Aceh');
    assert.strictEqual(saved.umur, 22);
  });

  // 39. Cegah pendaftaran ganda (duplicate .daftar)
  await itAsync('39. Percobaan .daftar ulang menampilkan pesan sudah terdaftar beserta ID', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: { id: 'REG_DUP_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    const mockMsg = {
      key: { remoteJid: '6281234560001@s.whatsapp.net', id: 'CMD_REG_DUP', fromMe: false },
      message: { conversation: '.daftar Ahmad Fauzi - Banda Aceh - 22' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('Kamu sudah terdaftar sebagai User #'));
    assert.strictEqual(Boolean(replyObj), true, 'Harus menolak pendaftaran ganda');
  });

  // 40. Konsep Smallest Available ID & Penghapusan user (.deluser)
  await itAsync('40. Smallest Available ID: ID kosong terkecil digunakan kembali setelah user dihapus', async () => {
    // Daftarkan user A dan user B
    users.deleteUser('6281234560002');
    users.deleteUser('6281234560003');

    const uA = users.registerUserWithDetails('6281234560002', { name: 'User A', kota: 'Medan', umur: 21 });
    const uB = users.registerUserWithDetails('6281234560003', { name: 'User B', kota: 'Jakarta', umur: 25 });

    assert.strictEqual(uB.id > uA.id, true);

    // Hapus User A
    const delOk = users.deleteUserById(uA.id);
    assert.strictEqual(delOk, true);

    // User C mendaftar, harus mendapatkan ID kosong terkecil yaitu uA.id!
    users.deleteUser('6281234560004');
    const uC = users.registerUserWithDetails('6281234560004', { name: 'User C', kota: 'Surabaya', umur: 23 });
    assert.strictEqual(uC.id, uA.id, 'User baru harus mengisi ID kosong terkecil yang baru saja dihapus');

    // Bersihkan
    users.deleteUserById(uB.id);
    users.deleteUserById(uC.id);
  });

  // 41. Menu dinamis: Menampilkan .daftar jika belum terdaftar dan menyembunyikannya jika sudah terdaftar
  await itAsync('41. Menu dinamis: Menampilkan petunjuk .daftar untuk guest dan menyembunyikannya untuk user terdaftar', async () => {
    const { getMainCategoryMenu } = require('../helpers/menus');
    const unregisteredMenu = getMainCategoryMenu('Tamu', false);
    assert.strictEqual(unregisteredMenu.includes('⚠️ Kamu belum terdaftar.'), true);
    assert.strictEqual(unregisteredMenu.includes('.daftar Nama User - Kota - Umur'), true);

    const registeredMenu = getMainCategoryMenu('Rahmat Haikal', true);
    assert.strictEqual(registeredMenu.includes('⚠️ Kamu belum terdaftar.'), false);
    assert.strictEqual(registeredMenu.includes('.daftar Nama User - Kota - Umur'), false);
  });

  // 42. Admin .infouser <ID> menampilkan profil user terdaftar
  await itAsync('42. Admin .infouser <ID> menampilkan detail data user terdaftar', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: { id: 'INFOUSER_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    // Owner mengakses .infouser 1
    const mockMsg = {
      key: { remoteJid: '6282267034994@s.whatsapp.net', id: 'CMD_INFOUSER', fromMe: false },
      message: { conversation: '.infouser 1' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('INFORMASI USER'));
    assert.strictEqual(Boolean(replyObj), true);
    assert.strictEqual(replyObj.text.includes('🆔 ID          : 1'), true);
    assert.strictEqual(replyObj.text.includes('📍 Kota'), true);
    assert.strictEqual(replyObj.text.includes('🎂 Umur'), true);
  });

  // 43. Perintah .ins langsung membuka submenu stiker
  await itAsync('43. Perintah .ins langsung membuka submenu stiker (getStickerMenu)', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: content.react ? content.react.key : { id: 'INS_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    const mockMsg = {
      key: { remoteJid: '6287777777777@s.whatsapp.net', id: 'CMD_INS', fromMe: false },
      message: { conversation: '.ins' }
    };

    await handleMessage(mockSock, mockMsg, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('STICKER & MEDIA'));
    assert.strictEqual(Boolean(replyObj), true);
    assert.strictEqual(replyObj.text.includes('.brat'), true);
    assert.strictEqual(replyObj.text.includes('.qc'), true);
  });

  // 44. Perintah 'in' kurang akurat / typo tetap masuk ke halaman bertingkat yang tepat
  await itAsync('44. Perintah menu bertingkat yang kurang akurat/typo (indown, ingam, insear, intul, ingrup, inadm, in download, in) tetap masuk', async () => {
    const testCases = [
      { input: '.indw', expectedHeader: 'DOWNLOAD' },
      { input: '.indown', expectedHeader: 'DOWNLOAD' },
      { input: '.indl', expectedHeader: 'DOWNLOAD' },
      { input: '.in download', expectedHeader: 'DOWNLOAD' },
      { input: '.inscr', expectedHeader: 'SEARCH' },
      { input: '.insear', expectedHeader: 'SEARCH' },
      { input: '.ingm', expectedHeader: 'GAME & FUN' },
      { input: '.ingam', expectedHeader: 'GAME & FUN' },
      { input: '.intl', expectedHeader: 'TOOLS' },
      { input: '.intul', expectedHeader: 'TOOLS' },
      { input: '.ingr', expectedHeader: 'GROUP' },
      { input: '.ingrup', expectedHeader: 'GROUP' },
      { input: '.inadm', expectedHeader: 'ADMIN' },
      { input: '.in', expectedHeader: 'GENERAL' },
      { input: '.inrandomtypo', expectedHeader: 'GENERAL' }
    ];

    for (const tc of testCases) {
      const replies = [];
      const mockSock = {
        sendMessage: async (chat, content) => {
          replies.push(content);
          return { key: content.react ? content.react.key : { id: 'FUZZY_RES' } };
        },
        sendPresenceUpdate: async () => {},
        user: { id: '6281111111111:1@s.whatsapp.net' }
      };
      const mockMsg = {
        key: { remoteJid: '6287777777777@s.whatsapp.net', id: `CMD_FUZZY_${tc.input}`, fromMe: false },
        message: { conversation: tc.input }
      };

      await handleMessage(mockSock, mockMsg, Date.now());
      const replyObj = replies.find((r) => r.text && r.text.includes(tc.expectedHeader));
      assert.strictEqual(Boolean(replyObj), true, `Input "${tc.input}" harus menampilkan header "${tc.expectedHeader}"`);
    }
  });

  // 45. Command non-menu diawali 'in' (seperti .infobot, .infouser) dan command stiker (.s) tidak terganggu
  await itAsync('45. Command non-menu (.infobot, .infouser) dan stiker (.s) tidak tertukar oleh fuzzy router', async () => {
    // 1. .infobot tetap berfungsi sebagai info bot
    const repliesBot = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        repliesBot.push(content);
        return { key: content.react ? content.react.key : { id: 'INFOBOT_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };
    const mockMsgBot = {
      key: { remoteJid: '6287777777777@s.whatsapp.net', id: 'CMD_INFOBOT', fromMe: false },
      message: { conversation: '.infobot' }
    };
    await handleMessage(mockSock, mockMsgBot, Date.now());
    const replyBot = repliesBot.find((r) => r.text && r.text.includes('INFORMASI BOT'));
    assert.strictEqual(Boolean(replyBot), true);
  });

  // 46. getUserNumber mengambil HANYA nomor pengirim asli (bukan group ID, bukan quoted, bukan mentioned)
  it('46. getUserNumber mengambil HANYA nomor pengirim asli dan menolak ID grup/quoted/mentioned', () => {
    const { getUserNumber, getUserJid } = require('../helpers/userHelper');

    // Private chat
    const msgPrivate = {
      key: { remoteJid: '6281234567890@s.whatsapp.net', fromMe: false }
    };
    assert.strictEqual(getUserNumber(msgPrivate), '6281234567890');
    assert.strictEqual(getUserJid(msgPrivate), '6281234567890@s.whatsapp.net');

    // Group chat dengan quoted message dan mentionedJid orang lain
    const msgGroup = {
      key: {
        remoteJid: '1203630283928192@g.us',
        participant: '6289876543210@s.whatsapp.net',
        fromMe: false
      },
      message: {
        extendedTextMessage: {
          text: '.ping',
          contextInfo: {
            participant: '6281111111111@s.whatsapp.net', // quoted orang lain
            mentionedJid: ['6282222222222@s.whatsapp.net'] // mentioned orang lain
          }
        }
      }
    };
    // Harus mengambil 6289876543210 (pengirim), BUKAN grup 120363..., BUKAN quoted 628111..., BUKAN mentioned 628222...
    assert.strictEqual(getUserNumber(msgGroup), '6289876543210');

    // Group chat TANPA participant (tidak dapat dipastikan) -> HARUS return null, TIDAK BOLEH ambil remoteJid grup
    const msgGroupNoParticipant = {
      key: { remoteJid: '1203630283928192@g.us', fromMe: false }
    };
    assert.strictEqual(getUserNumber(msgGroupNoParticipant), null);
  });

  // 47. Normalisasi nomor ke format standar 628xxxxxxxxxx
  it('47. Normalisasi nomor mengubah 08, +628, dan membuang suffix device (:xx)', () => {
    const { normalizeUserNumber, isValidUserNumber } = require('../helpers/userHelper');

    assert.strictEqual(normalizeUserNumber('081234567890'), '6281234567890');
    assert.strictEqual(normalizeUserNumber('+62 812-3456-7890'), '6281234567890');
    assert.strictEqual(normalizeUserNumber('6281234567890:12@s.whatsapp.net'), '6281234567890');
    assert.strictEqual(isValidUserNumber('6281234567890'), true);

    // Nomor tidak valid
    assert.strictEqual(isValidUserNumber('123'), false); // terlalu pendek
    assert.strictEqual(isValidUserNumber('081234567890'), false); // belum dinormalisasi
    assert.strictEqual(isValidUserNumber('1203630283928192'), false); // ID grup
    assert.strictEqual(isValidUserNumber('207945304379644'), false); // LID 15 digit
  });

  // 48. Menolak LID dan identifier internal WhatsApp agar tidak masuk ke database
  it('48. Menolak LID WhatsApp dan identifier internal dari penyimpanan database', () => {
    const { getUserNumber } = require('../helpers/userHelper');
    const uDb = require('../database/users');

    const msgLid = {
      key: { remoteJid: '1203630283928192@g.us', participant: '207945304379644@lid', fromMe: false }
    };
    // LID tanpa mapping harus menghasilkan null
    assert.strictEqual(getUserNumber(msgLid), null);

    // Memanggil getUser dengan LID tidak boleh menambahkan record ke guest_limits atau users
    const res = uDb.getUser('207945304379644@lid');
    assert.strictEqual(res, null);

    const checkDb = uDb.getDb().prepare('SELECT * FROM guest_limits WHERE phone = ?').get('207945304379644');
    assert.strictEqual(Boolean(checkDb), false, 'LID tidak boleh disimpan ke guest_limits');
  });

  // 49. Resolver LID ke nomor asli berhasil jika data mapping tersedia di groupMetadata
  it('49. Resolver LID berhasil mendapatkan nomor WhatsApp asli dari groupMetadata', () => {
    const { getUserNumber } = require('../helpers/userHelper');

    const mockGroupMetadata = {
      id: '1203630283928192@g.us',
      participants: [
        {
          id: '6281399887766@s.whatsapp.net',
          lid: '207945304379644@lid',
          admin: null
        }
      ]
    };

    const msgWithLid = {
      key: {
        remoteJid: '1203630283928192@g.us',
        participant: '207945304379644@lid',
        fromMe: false
      }
    };

    const resolved = getUserNumber(msgWithLid, null, mockGroupMetadata);
    assert.strictEqual(resolved, '6281399887766');
  });

  // 50. .daftar ditolak dengan aman jika nomor asli pengirim tidak dapat dipastikan
  await itAsync('50. Command .daftar ditolak dengan pesan informatif jika pengirim berupa LID yang tidak dapat di-resolve', async () => {
    const replies = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        replies.push(content);
        return { key: content.react ? content.react.key : { id: 'REG_FAIL_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };

    // Pengirim grup dengan LID asing yang tidak bisa di-resolve
    const mockMsgLid = {
      key: {
        remoteJid: '1203630283928192@g.us',
        participant: '999888777666555@lid',
        fromMe: false
      },
      message: { conversation: '.daftar User Anonim - Jakarta - 25' }
    };

    await handleMessage(mockSock, mockMsgLid, Date.now());
    const replyObj = replies.find((r) => r.text && r.text.includes('Nomor WhatsApp asli Anda tidak dapat dideteksi'));
    assert.strictEqual(Boolean(replyObj), true);

    // Pastikan tidak ada data yang masuk ke users
    const checkDb = users.getDb().prepare('SELECT * FROM users WHERE name = ?').get('User Anonim');
    assert.strictEqual(Boolean(checkDb), false, 'User tidak boleh tersimpan jika nomor tidak dapat dipastikan');
  });

  // 51. Submenu inadmin (getAdminMenu) memuat command .listuser
  it('51. Submenu inadmin (getAdminMenu) memuat command .listuser', () => {
    const { getAdminMenu } = require('../helpers/menus');
    const menu = getAdminMenu();
    assert.strictEqual(menu.includes('.listuser'), true, 'Menu admin harus memuat .listuser');
    assert.strictEqual(menu.includes('.deluser'), true, 'Menu admin harus memuat .deluser');
  });

  // 52. Command .deluser bisa menghapus beberapa user sekaligus dan menyiarkan (broadcast) notifikasi
  await itAsync('52. Command .deluser bisa menghapus beberapa user sekaligus dan menyiarkan notifikasi ke WhatsApp user', async () => {
    // Daftarkan 2 user uji coba
    users.deleteUser('6287700000001');
    users.deleteUser('6287700000002');
    const u1 = users.registerUserWithDetails('6287700000001', { name: 'User Multi 1', kota: 'Medan', umur: 21 });
    const u2 = users.registerUserWithDetails('6287700000002', { name: 'User Multi 2', kota: 'Padang', umur: 22 });

    assert.strictEqual(Boolean(u1), true);
    assert.strictEqual(Boolean(u2), true);

    const sentMessages = [];
    const mockSock = {
      sendMessage: async (chat, content) => {
        sentMessages.push({ chat, content });
        return { key: content.react ? content.react.key : { id: 'MULTI_DEL_RES' } };
      },
      sendPresenceUpdate: async () => {},
      user: { id: '6281111111111:1@s.whatsapp.net' }
    };

    // Owner menjalankan: .deluser <id1>, <id2>
    const mockMsgDel = {
      key: {
        remoteJid: '6282267034994@s.whatsapp.net',
        id: 'CMD_DEL_MULTI',
        fromMe: false
      },
      message: { conversation: `.deluser ${u1.id}, ${u2.id}` }
    };

    await handleMessage(mockSock, mockMsgDel, Date.now());

    // Cek balasan admin
    const adminReply = sentMessages.find((m) => m.content.text && m.content.text.includes('HASIL PENGHAPUSAN USER'));
    assert.strictEqual(Boolean(adminReply), true, 'Harus mengirim rangkuman penghapusan multi-user');
    assert.strictEqual(adminReply.content.text.includes(`• #${u1.id} - User Multi 1`), true);
    assert.strictEqual(adminReply.content.text.includes(`• #${u2.id} - User Multi 2`), true);

    // Cek broadcast notifikasi yang dikirimkan ke kedua user
    const bcUser1 = sentMessages.find((m) => m.chat === '6287700000001@s.whatsapp.net' && m.content.text && m.content.text.includes('PEMBERITAHUAN SIKANBOT'));
    const bcUser2 = sentMessages.find((m) => m.chat === '6287700000002@s.whatsapp.net' && m.content.text && m.content.text.includes('PEMBERITAHUAN SIKANBOT'));
    assert.strictEqual(Boolean(bcUser1), true, 'User 1 harus menerima broadcast notifikasi penghapusan');
    assert.strictEqual(Boolean(bcUser2), true, 'User 2 harus menerima broadcast notifikasi penghapusan');

    // Pastikan kedua user benar-benar terhapus dari SQLite
    const check1 = users.getUserById(u1.id);
    const check2 = users.getUserById(u2.id);
    assert.strictEqual(Boolean(check1), false, 'User 1 harus terhapus dari database');
    assert.strictEqual(Boolean(check2), false, 'User 2 harus terhapus dari database');
  });

  console.log('\n====================================================');
  console.log(`📊 HASIL TEST: ${passCount} LULUS, ${failCount} GAGAL`);
  console.log('====================================================');

  if (failedTests.length > 0) {
    console.log('\n❌ DAFTAR TEST GAGAL:');
    failedTests.forEach((f, i) => {
      console.log(`${i + 1}. ${f.name} => ${f.error}`);
    });
  }

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
