const fs = require('fs');
const config = require('../config');

class Database {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = {
      groups: {},
      users: {},
      settings: {}
    };
    this.saveTimeout = null;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        this.data = JSON.parse(raw) || { groups: {}, users: {}, settings: {} };
        if (!this.data.settings) {
          this.data.settings = {};
        }
        if (typeof this.data.settings.totalHits !== 'number') {
          this.data.settings.totalHits = 0;
        }
      } else {
        this.saveNow();
      }
    } catch (err) {
      console.error('[DB] Gagal memuat database.json, menggunakan data baru:', err.message);
      this.data = { groups: {}, users: {}, settings: {} };
    }
  }

  save() {
    if (this.saveTimeout) return;
    this.saveTimeout = setTimeout(() => {
      this.saveNow();
      this.saveTimeout = null;
    }, 1000);
  }

  saveNow() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[DB] Gagal menyimpan database.json:', err.message);
    }
  }

  getGroup(groupId) {
    if (!this.data.groups[groupId]) {
      this.data.groups[groupId] = {
        antilink: false,
        antispam: false,
        welcome: true,
        mute: false
      };
      this.save();
    }
    return this.data.groups[groupId];
  }

  updateGroup(groupId, updateFn) {
    const group = this.getGroup(groupId);
    if (typeof updateFn === 'function') {
      updateFn(group);
    } else if (typeof updateFn === 'object') {
      Object.assign(group, updateFn);
    }
    this.save();
    return group;
  }

  getUser(userId) {
    const cleanId = userId.replace(/[^0-9]/g, '');
    if (!this.data.users[cleanId]) {
      this.data.users[cleanId] = {
        name: '',
        premium: false,
        banned: false,
        warns: 0,
        balance: 1000,
        registeredAt: Date.now()
      };
      this.save();
    }
    return this.data.users[cleanId];
  }

  updateUser(userId, updateFn) {
    const user = this.getUser(userId);
    if (typeof updateFn === 'function') {
      updateFn(user);
    } else if (typeof updateFn === 'object') {
      Object.assign(user, updateFn);
    }
    this.save();
    return user;
  }

  isOwner(jid) {
    if (!jid) return false;
    const clean = jid.replace(/[^0-9]/g, '');
    const ownerClean = config.owner.number.replace(/[^0-9]/g, '');
    return clean === ownerClean;
  }

  isPremium(jid) {
    if (this.isOwner(jid)) return true;
    const user = this.getUser(jid);
    return Boolean(user.premium);
  }

  isBanned(jid) {
    if (this.isOwner(jid)) return false;
    const user = this.getUser(jid);
    return Boolean(user.banned);
  }

  getHits() {
    if (!this.data.settings) this.data.settings = {};
    return this.data.settings.totalHits || 0;
  }

  incrementHit() {
    if (!this.data.settings) this.data.settings = {};
    this.data.settings.totalHits = (this.data.settings.totalHits || 0) + 1;
    this.save();
    return this.data.settings.totalHits;
  }
}

const db = new Database(config.databasePath);

module.exports = db;
