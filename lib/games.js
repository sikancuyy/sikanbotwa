/**
 * Game Manager untuk WhatsApp Bot SikanBot
 */

class GameManager {
  constructor() {
    // Sesi aktif tictactoe: { [chatId]: { playerO, playerX, board, turn, bet } }
    this.tttSessions = new Map();
    // Sesi aktif tebak-tebakan: { [chatId]: { answer, clue, points, timer, type } }
    this.quizSessions = new Map();
  }

  /* ----------------------------------------------------
   * 1. TIC TAC TOE
   * ---------------------------------------------------- */
  startTTT(chatId, player1, player2 = null) {
    if (this.tttSessions.has(chatId)) {
      return { status: false, message: 'Masih ada game TicTacToe yang sedang berjalan di chat ini! Ketik *.delttt* untuk membatalkan.' };
    }

    const session = {
      playerX: player1,
      playerO: player2, // null berarti menunggu pemain kedua
      turn: player1,
      board: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
      createdAt: Date.now()
    };

    this.tttSessions.set(chatId, session);
    return { status: true, session };
  }

  joinTTT(chatId, player2) {
    const session = this.tttSessions.get(chatId);
    if (!session) return { status: false, message: 'Tidak ada game TicTacToe yang menunggu pemain di chat ini.' };
    if (session.playerO) return { status: false, message: 'Game TicTacToe ini sudah penuh!' };
    if (session.playerX === player2) return { status: false, message: 'Anda tidak bisa bermain melawan diri sendiri!' };

    session.playerO = player2;
    return { status: true, session };
  }

  deleteTTT(chatId) {
    if (this.tttSessions.has(chatId)) {
      this.tttSessions.delete(chatId);
      return true;
    }
    return false;
  }

  renderBoard(board) {
    const icon = (val) => {
      if (val === 'X') return '❌';
      if (val === 'O') return '⭕';
      return `[${val}]`;
    };

    return `
 ${icon(board[0])} ┃ ${icon(board[1])} ┃ ${icon(board[2])}
━━━╋━━━╋━━━
 ${icon(board[3])} ┃ ${icon(board[4])} ┃ ${icon(board[5])}
━━━╋━━━╋━━━
 ${icon(board[6])} ┃ ${icon(board[7])} ┃ ${icon(board[8])}
`;
  }

  checkWin(board) {
    const lines = [
      [0, 1, 2], [3, 4, 5], [6, 7, 8], // baris
      [0, 3, 6], [1, 4, 7], [2, 5, 8], // kolom
      [0, 4, 8], [2, 4, 6]             // diagonal
    ];

    for (const [a, b, c] of lines) {
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return board[a]; // 'X' atau 'O'
      }
    }

    if (board.every((cell) => cell === 'X' || cell === 'O')) {
      return 'TIE';
    }

    return null;
  }

  playTTT(chatId, sender, position) {
    const session = this.tttSessions.get(chatId);
    if (!session) return { status: false, message: 'Tidak ada sesi TicTacToe yang aktif.' };
    if (!session.playerO) return { status: false, message: 'Menunggu pemain ke-2 untuk bergabung! Lawan ketik *.tictactoe join*' };

    if (session.turn !== sender) {
      return { status: false, message: '⏳ Bukan giliran Anda!' };
    }

    const pos = parseInt(position) - 1;
    if (isNaN(pos) || pos < 0 || pos > 8 || session.board[pos] === 'X' || session.board[pos] === 'O') {
      return { status: false, message: '⚠️ Posisi tidak valid atau sudah terisi! Pilih nomor 1-9 yang masih kosong.' };
    }

    const mark = sender === session.playerX ? 'X' : 'O';
    session.board[pos] = mark;

    const winnerMark = this.checkWin(session.board);
    if (winnerMark) {
      this.tttSessions.delete(chatId);
      if (winnerMark === 'TIE') {
        return {
          status: true,
          over: true,
          result: 'SERI',
          boardText: this.renderBoard(session.board),
          message: `🤝 *Permainan Berakhir SERI!* Tidak ada pemenang.`
        };
      } else {
        const winner = winnerMark === 'X' ? session.playerX : session.playerO;
        return {
          status: true,
          over: true,
          result: 'WIN',
          winner,
          boardText: this.renderBoard(session.board),
          message: `🎉 *Selamat!* @${winner.split('@')[0]} memenangkan permainan TicTacToe! 🏆`
        };
      }
    }

    // Ganti giliran
    session.turn = session.turn === session.playerX ? session.playerO : session.playerX;
    return {
      status: true,
      over: false,
      nextTurn: session.turn,
      boardText: this.renderBoard(session.board)
    };
  }

  /* ----------------------------------------------------
   * 2. TEBAK GAMBAR & TEBAK KATA DATA
   * ---------------------------------------------------- */
  getTebakGambarList() {
    return [
      {
        image: 'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar/1.jpg',
        answer: 'TANTANGAN SERU',
        clue: 'T_N_A_G_N  S_R_'
      },
      {
        image: 'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar/2.jpg',
        answer: 'KAPAL SELAM',
        clue: 'K_P_L  S_L_M'
      },
      {
        image: 'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar/3.jpg',
        answer: 'JAM TANGAN',
        clue: 'J_M  T_N_G_N'
      },
      {
        image: 'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar/4.jpg',
        answer: 'PISAU TAJAM',
        clue: 'P_S_U  T_J_M'
      },
      {
        image: 'https://raw.githubusercontent.com/BochilTeam/database/master/games/tebakgambar/5.jpg',
        answer: 'KAMBING GULING',
        clue: 'K_M_B_N_G  G_L_N_G'
      }
    ];
  }

  getTebakKataList() {
    return [
      {
        clue: 'Binatang berkantung dari Australia',
        answer: 'KANGGURU'
      },
      {
        clue: 'Ibukota negara Indonesia yang baru di Kalimantan Timur',
        answer: 'NUSANTARA'
      },
      {
        clue: 'Bahasa pemrograman web yang sangat populer',
        answer: 'JAVASCRIPT'
      },
      {
        clue: 'Planet terdekat dari matahari',
        answer: 'MERKURIUS'
      },
      {
        clue: 'Alat untuk melihat benda langit yang jauh',
        answer: 'TELESKOP'
      },
      {
        clue: 'Gunung tertinggi di pulau Jawa',
        answer: 'SEMERU'
      }
    ];
  }

  /* ----------------------------------------------------
   * 3. MATH GAME
   * ---------------------------------------------------- */
  generateMathProblem() {
    const ops = ['+', '-', '*'];
    const op = ops[Math.floor(Math.random() * ops.length)];
    let num1, num2, answer;

    if (op === '+') {
      num1 = Math.floor(Math.random() * 50) + 1;
      num2 = Math.floor(Math.random() * 50) + 1;
      answer = num1 + num2;
    } else if (op === '-') {
      num1 = Math.floor(Math.random() * 60) + 20;
      num2 = Math.floor(Math.random() * num1) + 1;
      answer = num1 - num2;
    } else {
      num1 = Math.floor(Math.random() * 12) + 2;
      num2 = Math.floor(Math.random() * 12) + 2;
      answer = num1 * num2;
    }

    return {
      question: `${num1} ${op} ${num2}`,
      answer: String(answer)
    };
  }

  /* ----------------------------------------------------
   * 4. CASINO & SLOT
   * ---------------------------------------------------- */
  spinSlot() {
    const items = ['🍒', '🍋', '🍇', '🍉', '⭐', '💎', '7️⃣'];
    const r1 = items[Math.floor(Math.random() * items.length)];
    const r2 = items[Math.floor(Math.random() * items.length)];
    const r3 = items[Math.floor(Math.random() * items.length)];

    let win = false;
    let multiplier = 0;

    if (r1 === r2 && r2 === r3) {
      win = true;
      multiplier = r1 === '7️⃣' ? 10 : (r1 === '💎' ? 7 : 4);
    } else if (r1 === r2 || r2 === r3 || r1 === r3) {
      win = true;
      multiplier = 1.5;
    }

    return {
      reels: [r1, r2, r3],
      win,
      multiplier
    };
  }

  /* ----------------------------------------------------
   * 5. SUIT / PPT (Batu Gunting Kertas)
   * ---------------------------------------------------- */
  playSuit(choice) {
    const options = ['batu', 'gunting', 'kertas'];
    const userChoice = choice.toLowerCase().trim();
    if (!options.includes(userChoice)) {
      return { status: false, message: 'Pilihan tidak valid! Pilih: *batu*, *gunting*, atau *kertas*.' };
    }

    const botChoice = options[Math.floor(Math.random() * options.length)];
    let result = '';

    if (userChoice === botChoice) {
      result = 'SERI';
    } else if (
      (userChoice === 'batu' && botChoice === 'gunting') ||
      (userChoice === 'gunting' && botChoice === 'kertas') ||
      (userChoice === 'kertas' && botChoice === 'batu')
    ) {
      result = 'MENANG';
    } else {
      result = 'KALAH';
    }

    const emojis = { batu: '✊ Batu', gunting: '✌️ Gunting', kertas: '✋ Kertas' };
    return {
      status: true,
      userChoice: emojis[userChoice],
      botChoice: emojis[botChoice],
      result
    };
  }

  /* ----------------------------------------------------
   * 6. JOKES & FUN
   * ---------------------------------------------------- */
  getYourMomJoke() {
    const jokes = [
      'Ibumu begitu baik hati, sampai malaikat pun minta resep masakannya!',
      'Ibumu begitu pintar, waktu buka Google, Google yang minta jawaban ke dia.',
      'Ibumu begitu keren, WiFi di rumah langsung full bar kalau dia lewat!',
      'Ibumu begitu sabar, ngelihat kamu main HP seharian aja masih dibuatin teh hangat.',
      'Ibumu begitu hebat, tahu letak barang hilang tanpa perlu nyari!'
    ];
    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  getCoinFlip() {
    const outcomes = ['🪙 Gambar (Depan)', '🪙 Angka (Belakang)'];
    return outcomes[Math.floor(Math.random() * outcomes.length)];
  }

  getDice() {
    const dice = ['⚀ 1', '⚁ 2', '⚂ 3', '⚃ 4', '⚄ 5', '⚅ 6'];
    return dice[Math.floor(Math.random() * dice.length)];
  }
}

const games = new GameManager();

module.exports = games;
