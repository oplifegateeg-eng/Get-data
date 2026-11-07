/* WhatsApp Groups Exporter - engine that runs INSIDE the WhatsApp Web page of the Android app.
   The page functions and the export logic are the same ones used by the PC program. */
(function () {
  if (window.__waExporter) return;
  const A = window.Android;

  // ---------------- adapters (replace what the PC program gets from Node/Electron) ----------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const log = m => { try { A.log(String(m)); } catch (e) {} };
  const status = m => { try { A.status(String(m)); } catch (e) {} };
  const send = (ch, d) => { try { if (ch === 'progress') A.progress(String(d)); } catch (e) {} };
  const errText = e => (e && (e.stack || e.message)) || String(e);
  const short = e => String((e && e.message) || e).replace(/\s+/g, ' ').slice(0, 160);
  let mode = 'android', inviteChecked = false, serverListUsed = false, reconnectCount = 0, retryCount = 0;
  const client = null;
  const events = [];
  const note = m => events.push(new Date().toISOString().slice(11, 19) + ' ' + m);

  async function ensureInit() {
    const has = () => !!(window.__wx && window.__wx.Chat && typeof window.__wx.Chat.getModelsArray === 'function' && window.__wx.Contact);
    if (has()) return;
    for (let k = 0; k < 45; k++) {
      try { const r = PAGE_INIT(); if (r.ok) return; } catch (e) {}
      await sleep(2000);
    }
    throw new Error('WhatsApp page did not become ready (internals not found)');
  }
  const pageCall = async (fn, ...args) => {
    let lastErr;
    for (let a = 1; a <= 4; a++) {
      try { await ensureInit(); return await fn(...args); }
      catch (e) { lastErr = e; retryCount++; if (a < 4) { log(`Problem (attempt ${a}/4): ${short(e)}`); await sleep(2000 * a); } }
    }
    throw lastErr;
  };
  const getPage = () => ({
    reload: async () => {},
    keyboard: { press: async () => { try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })); } catch (e) {} } }
  });
  const loadCkpt = () => { try { const s = A.loadState(); return s ? JSON.parse(s) : null; } catch (e) { return null; } };
  const saveCkpt = data => { try { A.saveState(JSON.stringify(data)); } catch (e) {} };


// ---------------- runs INSIDE the WhatsApp page ----------------
// 0) build one helper object from WhatsApp's own modules (works in WhatsApp Desktop and in Chrome/WhatsApp Web)
const PAGE_INIT = () => {
  const st = window.Store || {};
  const req = n => { try { return window.require(n); } catch (e) { return null; } };
  const pick = (...a) => a.find(x => x);
  const col = req('WAWebCollections') || {};
  const S = {
    Chat: pick(st.Chat, col.Chat),
    Contact: pick(st.Contact, col.Contact),
    GroupMetadata: pick(st.GroupMetadata, col.GroupMetadata),
    WidFactory: pick(st.WidFactory, req('WAWebWidFactory')),
    LidUtils: pick(st.LidUtils, req('WAWebLidMigrationUtils'), req('WAWebLidUtils')),
    User: pick(req('WAWebUserPrefsMeUser'), st.User),
    Cmd: pick(st.Cmd, (req('WAWebCmd') || {}).Cmd),
    Drawer: pick(st.DrawerManager, (req('WAWebDrawerManager') || {}).DrawerManager),
    ConversationMsgs: pick(st.ConversationMsgs, req('WAWebChatLoadMessages')),
    GroupInvite: st.GroupInvite || null
  };
  const ok = !!(S.Chat && typeof S.Chat.getModelsArray === 'function' && S.Contact);
  window.__wx = ok ? S : null;            // only keep it when WhatsApp is really ready
  return { ok, chats: ok ? S.Chat.getModelsArray().length : 0 };
};

// 0a) how much of the account has actually been synced to this WhatsApp window
const PAGE_DIAG = () => {
  const S = window.__wx;
  const chats = S.Chat.getModelsArray();
  const groupChats = chats.filter(c => c.id && c.id.server === 'g.us');
  const mdOf = new Map();
  try { for (const m of (S.GroupMetadata?.getModelsArray?.() || [])) if (m.id) mdOf.set(m.id._serialized, m); } catch (e) {}
  const ids = new Set([...groupChats.map(c => c.id._serialized), ...[...mdOf.keys()].filter(k => k.endsWith('@g.us'))]);
  const chatOf = new Map(groupChats.map(c => [c.id._serialized, c]));
  let loaded = 0, incomplete = 0, empty = 0;
  for (const id of ids) {
    const c = chatOf.get(id);
    const md = (c && c.groupMetadata) || mdOf.get(id);
    const n = (md?.participants?.getModelsArray?.() || []).length;
    const size = Number(md?.size) || 0;
    if (!n) empty++; else { loaded++; if (size && n < size) incomplete++; }
  }
  const all = S.Contact.getModelsArray();
  const saved = all.filter(c => !c.isMe && (c.isMyContact || c.isAddressBookContact));
  const savedWithNum = saved.filter(c => (c.id && c.id.server === 'c.us') || c.phoneNumber?.user).length;
  const lidContacts = all.filter(c => c.id && c.id.server === 'lid').length;
  return { chats: chats.length, groupChats: groupChats.length, groupsTotal: ids.size, loaded, incomplete, empty,
    saved: saved.length, savedWithNum, lidContacts };
};

// 0b) all saved contacts (address book)
const PAGE_CONTACTS = () => {
  const S = window.__wx;
  const out = [];
  for (const c of S.Contact.getModelsArray()) {
    const id = c.id;
    if (!id || c.isMe || !(c.isMyContact || c.isAddressBookContact)) continue;
    out.push({
      user: id.user,
      number: id.server === 'c.us' ? id.user : (c.phoneNumber?.user || ''),
      lid: id.server === 'lid' ? id.user : (c.lid?.user || ''),
      name: c.name || '', push: c.pushname || ''
    });
  }
  return out;
};

// 0c) open a group's info panel / close the side panel (used once to load the invite-link code)
const PAGE_OPEN_GROUP_INFO = async gid => {
  const S = window.__wx;
  let chat = S.Chat.getModelsArray().find(x => x.id._serialized === gid);
  if (!chat) { try { const w = S.WidFactory.createWid(gid); chat = S.Chat.get(w) || await S.Chat.find(w); } catch (e) {} }
  if (!chat) return 'chat not found';
  const steps = [];
  const attempt = async (label, fn, forms) => {
    if (typeof fn !== 'function') { steps.push(label + ':missing'); return; }
    let lastErr = '';
    for (const f of forms) {
      try { await fn(f); steps.push(label + ':ok'); return; }
      catch (e) { lastErr = String((e && e.message) || e).slice(0, 50); }
    }
    steps.push(label + ':' + lastErr);
  };
  const C = S.Cmd || {};
  await attempt('chat', C.openChatBottom && C.openChatBottom.bind(C), [{ chat }, chat]);
  await new Promise(r => setTimeout(r, 1500));
  await attempt('info', C.openDrawerMid && C.openDrawerMid.bind(C), [chat, { chat }]);
  return steps.join(',');
};
const PAGE_CLOSE_DRAWER = async () => {
  const S = window.__wx;
  try { if (S.Drawer && S.Drawer.closeDrawerRight) await S.Drawer.closeDrawerRight(); } catch (e) {}
};

// 1) list all groups (chats + group metadata, so groups without a loaded chat are included too)
const PAGE_LIST_GROUPS = () => {
  const S = window.__wx;
  if (!S || !S.Chat) throw new Error('WhatsApp internals not found. Update whatsapp-web.js to the latest version.');
  const SKIP = new Set(['gp2', 'e2e_notification', 'notification_template', 'protocol', 'call_log']);
  const lastReal = c => {
    try {
      const arr = c.msgs?.getModelsArray?.() || [];
      for (let k = arr.length - 1; k >= 0; k--) { const m = arr[k]; if (m?.t && !SKIP.has(m.type)) return Number(m.t); }
    } catch (e) {}
    return 0;
  };
  const map = new Map();
  for (const c of S.Chat.getModelsArray()) {
    if (!c.id || c.id.server !== 'g.us') continue;
    map.set(c.id._serialized, {
      id: c.id._serialized,
      name: c.formattedTitle || c.name || '',
      t: Math.max(Number(c.t) || 0, lastReal(c)),
      creation: Number(c.groupMetadata?.creation) || 0
    });
  }
  try {
    for (const m of (S.GroupMetadata?.getModelsArray?.() || [])) {
      const id = m.id;
      if (!id || id.server !== 'g.us' || map.has(id._serialized)) continue;
      map.set(id._serialized, { id: id._serialized, name: m.subject || '', t: 0, creation: Number(m.creation) || 0 });
    }
  } catch (e) {}
  try {
    if (window.__srv) for (const rec of window.__srv.values()) {
      if (!map.has(rec.id)) map.set(rec.id, { id: rec.id, name: rec.name || '', t: 0, creation: rec.creation || 0 });
    }
  } catch (e) {}
  return [...map.values()];
};

// 2) read one group: members (LID <-> phone), my admin status, invite link
const PAGE_READ_GROUP = async (gid, getLinks, refresh) => {
  const S = window.__wx;
  let chat = S.Chat.getModelsArray().find(x => x.id._serialized === gid);
  if (!chat) {
    let m0 = null;
    try { m0 = (S.GroupMetadata?.getModelsArray?.() || []).find(x => x.id._serialized === gid); } catch (e) {}
    if (m0) chat = { id: m0.id, groupMetadata: m0 };
  }
  if (!chat) {
    const rec = window.__srv && window.__srv.get(gid);
    if (rec && rec.parts && rec.parts.length) {
      let wid = null;
      try { wid = S.WidFactory.createWid(gid); } catch (e) {}
      if (wid) {
        const plist = rec.parts.map(p => {
          let pw = null;
          try { pw = S.WidFactory.createWid(p.user + '@' + p.server); } catch (e) {}
          return pw ? { id: pw, isAdmin: p.admin, isSuperAdmin: p.superAdmin } : null;
        }).filter(Boolean);
        chat = { id: wid, __srv: true, groupMetadata: { size: rec.size || plist.length, creation: rec.creation, participants: { getModelsArray: () => plist } } };
      }
    }
  }
  if (!chat) return { parts: [], amAdmin: false, link: 'Not found', loaded: false };

  let md = chat.groupMetadata || (S.GroupMetadata && S.GroupMetadata.get(chat.id));
  let list = md?.participants?.getModelsArray?.() || [];
  let fetched = false, refreshed = false;
  if (refresh && S.GroupMetadata && typeof S.GroupMetadata.update === 'function') {
    try {
      await S.GroupMetadata.update(chat.id);
      refreshed = true;
      md = S.GroupMetadata.get(chat.id) || chat.groupMetadata || md;
      list = md?.participants?.getModelsArray?.() || list;
    } catch (e) {}
  }
  for (let a = 0; a < 3 && !list.length && S.GroupMetadata && S.GroupMetadata.find; a++) {
    try { md = await S.GroupMetadata.find(chat.id); list = md?.participants?.getModelsArray?.() || []; fetched = true; } catch (e) {}
    if (!list.length) await new Promise(r => setTimeout(r, 1500));
  }

  let usedServerMembers = false;
  if (!list.length) {
    const rec0 = window.__srv && window.__srv.get(gid);
    if (rec0 && rec0.parts && rec0.parts.length) {
      const pl = rec0.parts.map(p => {
        let pw = null;
        try { pw = S.WidFactory.createWid(p.user + '@' + p.server); } catch (e) {}
        return pw ? { id: pw, isAdmin: p.admin, isSuperAdmin: p.superAdmin } : null;
      }).filter(Boolean);
      if (pl.length) { list = pl; md = { size: rec0.size || pl.length, creation: rec0.creation, participants: { getModelsArray: () => pl } }; usedServerMembers = true; }
    }
  }

  const me = new Set();
  try {
    const U = S.User || window.require('WAWebUserPrefsMeUser');
    const pn = U.getMaybeMePnUser?.() || U.getMeUser?.();
    const lid = U.getMaybeMeLidUser?.();
    if (pn?.user) me.add(pn.user);
    if (lid?.user) me.add(lid.user);
  } catch (e) {}

  const mk = str => { try { return S.WidFactory.createWid(str); } catch (e) { return null; } };
  const getContact = id => { try { return id ? S.Contact.get(id) : null; } catch (e) { return null; } };

  const parts = list.map(p => {
    const id = p.id;
    const c = getContact(id);
    let phone = id.server === 'c.us' ? id.user : '';
    let lid = id.server === 'lid' ? id.user : '';
    if (!phone) { try { const pn = S.LidUtils?.getPhoneNumber?.(id); if (pn?.user) phone = pn.user; } catch (e) {} }
    if (!phone && c?.phoneNumber?.user) phone = c.phoneNumber.user;
    if (!lid) { try { const l = S.LidUtils?.getCurrentLid?.(id); if (l?.user) lid = l.user; } catch (e) {} }
    if (!lid && c?.lid?.user) lid = c.lid.user;
    const pc = phone && id.server !== 'c.us' ? getContact(mk(phone + '@c.us')) : null;
    const saved = !!(c?.isMyContact || pc?.isMyContact || c?.isAddressBookContact || pc?.isAddressBookContact);
    return {
      user: id.user, server: id.server, phone, lid,
      saved,
      savedName: saved ? (pc?.name || c?.name || '') : '',
      pushName: pc?.pushname || c?.pushname || '',
      admin: !!(p.isAdmin || p.isSuperAdmin),
      isMe: me.has(id.user) || (phone && me.has(phone)) || (lid && me.has(lid))
    };
  });

  let amAdmin = parts.some(x => x.isMe && x.admin);
  try { if (!amAdmin && typeof md?.participants?.iAmAdmin === 'function') amAdmin = !!md.participants.iAmAdmin(); } catch (e) {}

  let link = '', dbgOut = '';
  if (getLinks) {
    if (!amAdmin) link = 'Not admin';
    else {
      const idStr = chat.id._serialized;
      const fns = [], seen = new Set();
      // only read-only "get invite code" functions; never reset/revoke
      const SAFE = /^(fetchMex|query|fetch|get)[A-Za-z]*InviteCode$/;
      const BAD = /(reset|revoke|set|delete|accept|join|send)/i;
      const add = (name, fn, ctx) => { if (typeof fn === 'function' && !seen.has(name)) { seen.add(name); fns.push([name, fn.bind(ctx)]); } };
      const scan = (label, obj) => {
        if (!obj) return;
        for (const k of Object.keys(obj)) { if (SAFE.test(k) && !BAD.test(k) && typeof obj[k] === 'function') add(label + '.' + k, obj[k], obj); }
      };
      scan('Store.GroupInvite', S.GroupInvite);
      let modNames = [];
      try {
        const dm = window.require('__debug');
        const mm = dm.modulesMap || dm.modules || {};
        modNames = Object.keys(mm).filter(n => /invite/i.test(n));
      } catch (e) {}
      for (const n of ['WAWebMexFetchGroupInviteCodeJob', 'WAWebGroupInviteJob', 'WAWebGroupQueryJob', ...modNames]) {
        try { scan(n, window.require(n)); } catch (e) {}
      }
      const modsInfo = modNames.map(n => { try { return n + '{' + Object.keys(window.require(n) || {}).join('|') + '}'; } catch (e) { return n + '{?}'; } });
      dbgOut = 'functions=[' + fns.map(f => f[0]).join(',') + '] (' + modNames.length + ' invite-related modules)' + (fns.length ? '' : ' modules=[' + modsInfo.join(',').slice(0, 1500) + ']');
      const ed = e => {
        let j = '';
        try { j = JSON.stringify(e, Object.getOwnPropertyNames(Object(e))); } catch (x) {}
        return (String((e && e.message) || '') + ' ' + j).slice(0, 150);
      };
      const errs = [];
      outer: for (const [name, fn] of fns) {
        for (const arg of [chat.id, idStr]) {
          try {
            const r = await fn(arg);
            const code = typeof r === 'string' ? r : (r?.code || r?.inviteCode || r?.invite_code);
            if (code) { link = 'https://chat.whatsapp.com/' + code; break outer; }
            errs.push(name + ': empty');
          } catch (e) { errs.push(name + ': ' + ed(e)); }
        }
      }
      if (!link) link = 'Error: ' + (errs.join(' || ') || 'no invite function found');
    }
  }
  return { parts, amAdmin, link, dbg: dbgOut, loaded: list.length > 0, fetched, refreshed, declared: Number(md?.size) || 0, fromServer: !!chat.__srv, membersFromServer: usedServerMembers };
};

// 2b) last activity of one group (loads the chat / newest messages when WhatsApp has not loaded them yet)
const PAGE_LAST_MSG = async (gid, deep) => {
  const S = window.__wx;
  if (!S || !S.Chat) return { t: 0, msgTs: 0 };
  let chat = S.Chat.getModelsArray().find(x => x.id._serialized === gid) || null;
  if (!chat) { try { const wid = S.WidFactory.createWid(gid); chat = S.Chat.get(wid) || await S.Chat.find(wid); } catch (e) {} }
  if (!chat) return { t: 0, msgTs: 0 };
  const SKIP = ['gp2', 'e2e_notification', 'notification_template', 'protocol', 'call_log'];
  const real = () => (chat.msgs?.getModelsArray?.() || []).filter(m => m && m.t && !m.isNotification && !SKIP.includes(m.type));
  let arr = real();
  for (let a = 0; a < (deep ? 4 : 2) && !arr.length && S.ConversationMsgs?.loadEarlierMsgs; a++) {
    try { await S.ConversationMsgs.loadEarlierMsgs(chat); } catch (e) { break; }
    arr = real();
  }
  if (!arr.length && deep && S.Cmd && S.Cmd.openChatBottom) {   // open the chat like a user would, so WhatsApp loads its messages
    try { try { await S.Cmd.openChatBottom({ chat }); } catch (e1) { await S.Cmd.openChatBottom(chat); } await new Promise(r => setTimeout(r, 2000)); } catch (e) {}
    arr = real();
  }
  let msgTs = 0;
  for (const m of arr) if (Number(m.t) > msgTs) msgTs = Number(m.t);
  return { t: Number(chat.t) || 0, msgTs };
};

// 2c) load a group's older messages (as far as WhatsApp can without the phone) and note every member's last message
const PAGE_HISTORY = async (gid, budgetMs, maxMsgs, callMs) => {
 try {
  const S = window.__wx;
  let chat = S.Chat.getModelsArray().find(x => x.id._serialized === gid) || null;
  if (!chat) { try { const w = S.WidFactory.createWid(gid); chat = S.Chat.get(w) || await S.Chat.find(w); } catch (e) {} }
  if (!chat) return { ok: false, err: 'chat not found' };
  const SKIP = ['gp2', 'e2e_notification', 'notification_template', 'protocol', 'call_log'];
  const msgsOf = () => (chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : []);
  const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  const start = Date.now();
  let reached = false, why = '', stagnant = 0, calls = 0;
  if (S.ConversationMsgs && S.ConversationMsgs.loadEarlierMsgs) {
    for (;;) {
      if (Date.now() - start > budgetMs) { why = 'time budget reached'; break; }
      const before = msgsOf().length;
      if (maxMsgs && before >= maxMsgs) { why = 'message limit reached'; break; }
      let got;
      try { got = await withTimeout(S.ConversationMsgs.loadEarlierMsgs(chat), callMs || 12000); }
      catch (e) { why = String(e && e.message) === 'timeout' ? 'the phone did not send older messages in time (is the phone online?)' : 'error while loading'; break; }
      calls++;
      if (!got || !got.length || msgsOf().length <= before) { stagnant++; if (stagnant >= 2) { reached = true; break; } } else stagnant = 0;
    }
  } else { why = 'message loader not available'; }

  const me = new Set();
  try {
    const U = S.User;
    const pn = U.getMaybeMePnUser?.() || U.getMeUser?.();
    const lid = U.getMaybeMeLidUser?.();
    if (pn?.user) me.add(pn.user);
    if (lid?.user) me.add(lid.user);
  } catch (e) {}

  const by = new Map();
  let oldest = 0, newest = 0, total = 0, meT = 0;
  for (const m of msgsOf()) {
    if (!m || !m.t || m.isNotification || SKIP.includes(m.type)) continue;
    const t = Number(m.t);
    total++;
    if (!oldest || t < oldest) oldest = t;
    if (t > newest) newest = t;
    const a = m.author || (m.id && m.id.participant) || null;
    const fromMe = !!(m.id && m.id.fromMe);
    if (fromMe) { if (t > meT) meT = t; continue; }
    const user = a && (a.user || String(a).split('@')[0]);
    if (!user) continue;
    if (me.has(user)) { if (t > meT) meT = t; continue; }
    if ((by.get(user) || 0) < t) by.set(user, t);
  }
  // free the memory used by this group's messages before the next group
  try { if (!(S.Chat.getActive && S.Chat.getActive() === chat) && chat.msgs && chat.msgs.reset) chat.msgs.reset(); } catch (e) {}
  return { ok: true, authors: [...by.entries()].map(([user, t]) => ({ user, t })), total, oldest, newest, meT, reached, why, calls };
 } catch (e) {
  let j = '';
  try { j = JSON.stringify(e, Object.getOwnPropertyNames(Object(e))); } catch (x) {}
  return { ok: false, err: ('page error: ' + ((e && e.message) || '') + ' ' + j).slice(0, 160) };
 }
};

// 2d) scroll the chat list to the bottom (makes WhatsApp load the older chats it has stored)
const PAGE_SCROLL_CHATLIST = () => {
  const el = document.getElementById && document.getElementById('pane-side');
  if (!el) return 0;
  el.scrollTop = el.scrollHeight;
  return el.scrollHeight;
};

// 2e) ask WhatsApp's server for ALL groups of the account (independent of what this device has synced) and keep the answer
const PAGE_TRY_LIST_ALL_GROUPS = async () => {
  const S = window.__wx;
  const names = [], tried = [], errors = [], debug = [];
  if (!window.__srv) window.__srv = new Map();
  let all = [];
  try { const dm = window.require('__debug'); all = Object.keys(dm.modulesMap || dm.modules || {}); } catch (e) {}
  const mods = all.filter(n => /Group/i.test(n) && /(Query|Fetch|Sync|Participating|List|Job|RPC)/i.test(n) && !/(react|Loadable|graphql|Modal|Drawer|Wam|Invite|Newsletter|Community)/i.test(n));
  const FN = /(participating|allgroups)/i;
  const BAD = /(reset|revoke|set|delete|leave|create|add|remove|join|accept|promote|demote|parse|make|mixin|send)/i;

  const idStr = x => { if (!x) return ''; if (typeof x === 'string') return x; if (x._serialized) return x._serialized; if (x.user && x.server) return x.user + '@' + x.server; return ''; };
  const asArray = r => {
    if (!r) return [];
    if (Array.isArray(r)) return r;
    if (r instanceof Map) return [...r.values()];
    if (typeof r.getModelsArray === 'function') return r.getModelsArray();
    for (const k of ['groups', 'data', 'results', 'participating']) if (r[k]) return asArray(r[k]);
    if (typeof r === 'object') return Object.values(r).filter(v => v && typeof v === 'object');
    return [];
  };
  const partsOf = it => {
    let ps = it.participants;
    if (!ps) return [];
    if (typeof ps.getModelsArray === 'function') ps = ps.getModelsArray();
    if (ps instanceof Map) ps = [...ps.values()];
    if (!Array.isArray(ps)) ps = Object.values(ps);
    return ps.map(p => {
      const id = idStr((p && (p.id || p.jid)) || p);
      const user = id.split('@')[0], server = id.split('@')[1] || 'c.us';
      if (!user) return null;
      const adm = p && p.admin;
      return { user, server, admin: !!(p && (p.isAdmin || p.isSuperAdmin || adm === 'admin' || adm === 'superadmin')), superAdmin: !!(p && (p.isSuperAdmin || adm === 'superadmin')) };
    }).filter(Boolean);
  };

  for (const n of mods) {
    let m = null;
    try { m = window.require(n); } catch (e) { continue; }
    if (!m) continue;
    for (const k of Object.keys(m)) {
      if (!FN.test(k) || BAD.test(k) || typeof m[k] !== 'function') continue;
      names.push(n + '.' + k);
      if (!/^(query|fetch|get|sync)/i.test(k)) continue;
      try {
        const r = await m[k]();
        tried.push(n + '.' + k);
        const items = asArray(r);
        const first = items[0];
        debug.push(k + ': returned ' + (Array.isArray(r) ? 'array' : typeof r) + ' with ' + items.length + ' items' + (first ? ' | first item keys: ' + Object.keys(first).slice(0, 12).join('|') : ''));
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          const gid = idStr(it.id || it.jid || it.gid);
          if (!gid.endsWith('@g.us')) continue;
          const parts = partsOf(it);
          const old = window.__srv.get(gid);
          window.__srv.set(gid, {
            id: gid,
            name: it.subject || it.name || it.formattedTitle || (old && old.name) || '',
            creation: Number(it.creation) || (old && old.creation) || 0,
            size: Number(it.size) || parts.length || (old && old.size) || 0,
            parts: parts.length ? parts : ((old && old.parts) || [])
          });
        }
      } catch (e) { errors.push(n + '.' + k + ': ' + String((e && e.message) || e).slice(0, 60)); }
    }
  }

  // groups the server knows that have no member list in the answer and are not on this device yet
  const local = new Set();
  try { for (const c of S.Chat.getModelsArray()) if (c.id) local.add(c.id._serialized); } catch (e) {}
  try { for (const g of (S.GroupMetadata?.getModelsArray?.() || [])) if (g.id) local.add(g.id._serialized); } catch (e) {}
  const recs = [...window.__srv.values()];
  const pendingIds = recs.filter(r => !r.parts.length && !local.has(r.id)).map(r => r.id);
  return { names, tried, errors, debug, serverCount: recs.length, withMembers: recs.filter(r => r.parts.length).length,
    onThisDevice: recs.filter(r => local.has(r.id)).length, pendingIds };
};

// 2f) fetch group info for specific groups from the server into WhatsApp's own store
const PAGE_FIND_GROUPS = async ids => {
  const S = window.__wx;
  let ok = 0, fail = 0;
  for (const gid of ids) {
    try { const w = S.WidFactory.createWid(gid); const md = await S.GroupMetadata.find(w); if (md) ok++; else fail++; } catch (e) { fail++; }
    await new Promise(r => setTimeout(r, 250));
  }
  return { ok, fail };
};

// 3) is the invite-code function available in the page yet?
const PAGE_INVITE_READY = () => {
  const SAFE = /^(fetchMex|query|fetch|get)[A-Za-z]*InviteCode$/;
  const BAD = /(reset|revoke|set|delete|accept|join|send)/i;
  const has = m => { try { return !!m && Object.keys(m).some(k => SAFE.test(k) && !BAD.test(k) && typeof m[k] === 'function'); } catch (e) { return false; } };
  for (const n of ['WAWebMexFetchGroupInviteCodeJob', 'WAWebGroupInviteJob', 'WAWebGroupQueryJob']) {
    try { if (has(window.require(n))) return true; } catch (e) {}
  }
  try {
    const dm = window.require('__debug');
    for (const n of Object.keys(dm.modulesMap || dm.modules || {}).filter(n => /invite/i.test(n))) {
      try { if (has(window.require(n))) return true; } catch (e) {}
    }
  } catch (e) {}
  return false;
};

// 4) click the "Invite to group via link" row in the open group-info panel (no other clicks)
const PAGE_CLICK_INVITE = () => {
  const want = /invite[^\n]*link|via link|link to (the )?group|دعوة[^\n]*رابط|الدعوة[^\n]*رابط|رابط[^\n]*المجموعة|invitar[^\n]*enlace|inviter[^\n]*lien|einladen[^\n]*link/i;
  const never = /reset|revoke|copy|share|إعادة|تعيين|إلغاء|نسخ|مشاركة/i;
  const cands = Array.from(document.querySelectorAll('[role="button"], [role="listitem"], [role="row"], button, div[tabindex]'));
  for (const el of cands) {
    const t = (el.innerText || '').trim();
    if (t && t.length < 120 && want.test(t) && !never.test(t)) { el.scrollIntoView({ block: 'center' }); el.click(); return t; }
  }
  return '';
};

// 4b) ask WhatsApp to download the lazy "invite link" part of its code (what opening the invite screen would do)
const PAGE_LOAD_INVITE_BUNDLE = async () => {
  const out = [];
  let names = [];
  try {
    const dm = window.require('__debug');
    names = Object.keys(dm.modulesMap || dm.modules || {}).filter(n => /Invite/i.test(n) && /Loadable/i.test(n));
  } catch (e) {}
  for (const n of names) {
    try {
      const m = window.require(n);
      if (m && typeof m.requireBundle === 'function') { await m.requireBundle(); out.push(n); }
    } catch (e) { out.push(n + ':error'); }
  }
  return out;
};

// 5) every group invite code currently visible on screen
const PAGE_LINK_CODES = () => {
  const re = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/g;
  const out = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) { const t = n.nodeValue || ''; let m; re.lastIndex = 0; while ((m = re.exec(t))) out.push(m[1]); }
  return out;
};

// 6) the link that appeared on the invite screen (new on screen, or shown in the right-hand panel)
const PAGE_PICK_LINK = before => {
  const re = /chat\.whatsapp\.com\/([A-Za-z0-9_-]{10,})/g;
  const found = [];
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = w.nextNode())) {
    const t = n.nodeValue || '';
    let m; re.lastIndex = 0;
    while ((m = re.exec(t))) {
      const el = n.parentElement;
      const r = el ? el.getBoundingClientRect() : { left: 0, width: 0, height: 0 };
      if (r.width > 0 && r.height > 0) found.push({ code: m[1], left: r.left });
    }
  }
  const fresh = found.filter(f => !before.includes(f.code));
  const pool = fresh.length ? fresh : found.filter(f => f.left > window.innerWidth * 0.55);
  if (!pool.length) return '';
  pool.sort((a, b) => b.left - a.left);
  return pool[0].code;
};


// Loads WhatsApp's invite-link code by opening (and then closing) one admin group's invite screen inside the browser.
async function autoLoadInvite(gid) {
  const isReady = () => pageCall(PAGE_INVITE_READY);
  if (await isReady()) return true;
  log('Loading WhatsApp invite-link code automatically (no action needed)...');
  try {
    const loaded = await pageCall(PAGE_LOAD_INVITE_BUNDLE);
    log('Invite code parts requested from WhatsApp: ' + (loaded.length ? loaded.join(', ') : 'none found'));
    for (let k = 0; k < 8; k++) { if (await isReady()) return true; await sleep(1000); }
  } catch (e) { log('Invite code load problem: ' + short(e)); }
  try {
    const opened = await pageCall(PAGE_OPEN_GROUP_INFO, gid);
    log('Group info panel: ' + opened);
    await sleep(3000);
    let clicked = '';
    for (let k = 0; k < 5 && !clicked; k++) {
      clicked = await pageCall(PAGE_CLICK_INVITE);
      if (!clicked) await sleep(1500);
    }
    log(clicked ? 'Opened: ' + clicked : 'Could not find the invite row in the group info panel.');
    for (let k = 0; k < 6; k++) { if (await isReady()) break; await sleep(1000); }
  } catch (e) { log('Auto-load problem: ' + short(e)); }
  try { await pageCall(PAGE_CLOSE_DRAWER); } catch (e) {}
  return await isReady();
}
// ---------------------------------------------------

// Opens Group info > "Invite to group via link" and reads the link shown there. Never presses Reset/Copy/Share.
async function readLinkViaUI(gid) {
  let err = '';
  try {
    await pageCall(PAGE_OPEN_GROUP_INFO, gid);
    await sleep(2500);
    const before = await pageCall(PAGE_LINK_CODES);
    let clicked = '';
    for (let k = 0; k < 4 && !clicked; k++) { clicked = await pageCall(PAGE_CLICK_INVITE); if (!clicked) await sleep(1500); }
    if (!clicked) err = 'the "Invite to group via link" row was not found in Group info';
    else {
      for (let k = 0; k < 8; k++) {
        await sleep(1000);
        const code = await pageCall(PAGE_PICK_LINK, before);
        if (code) return { link: 'https://chat.whatsapp.com/' + code };
      }
      err = 'the invite screen opened but no link was shown';
    }
  } catch (e) { err = short(e); }
  finally {
    try { await pageCall(PAGE_CLOSE_DRAWER); await pageCall(PAGE_CLOSE_DRAWER); await getPage().keyboard.press('Escape'); await sleep(500); } catch (e) {}
  }
  return { link: '', err };
}

const statusOf = r => (!r.parts.length ? 'EMPTY' : (r.declared && r.parts.length < r.declared ? `INCOMPLETE (${r.parts.length} of ${r.declared})` : 'OK'));

async function printDiag(tag, expected) {
  const d = await pageCall(PAGE_DIAG);
  log(`${tag} chats loaded: ${d.chats} | group chats: ${d.groupChats} | groups known in total: ${d.groupsTotal}`);
  log(`${tag} groups with member list: ${d.loaded} | without member list: ${d.empty} | incomplete: ${d.incomplete}`);
  log(`${tag} saved contacts synced: ${d.saved} (with a phone number: ${d.savedWithNum}) | hidden-ID contacts: ${d.lidContacts}`);
  if (d.empty) log(`${tag} ${d.empty} groups have no member list yet. The export will request them from WhatsApp (slower).`);
  if (!d.saved) log(`${tag} WARNING: no saved contacts are synced to this window, so "In My Contacts?" would be No for everyone. On your phone: allow WhatsApp access to Contacts and keep the phone online, then close and reopen WhatsApp Desktop and try again.`);
  else if (d.savedWithNum < d.saved) log(`${tag} ${d.saved - d.savedWithNum} saved contacts have no phone number yet (WhatsApp has not finished syncing them).`);
  if (expected && d.groupsTotal < expected) log(`${tag} WARNING: ${d.groupsTotal} groups found but you expected ${expected}. ${expected - d.groupsTotal} are not synced to this window yet. Keep your phone online, scroll your chat list in WhatsApp Desktop to load older chats, wait a few minutes, then run this check again.`);
  return d;
}


async function runExport({ getLinks, savedOnly, delay, fresh, refresh, expected, skipWait, syncStableSec, syncMaxMin, linkMode, forceSync, memberHistory, historyBudgetSec, historyCallSec, historyMaxMessages }) {
  const histBudgetMs = Math.max(10, Number(historyBudgetSec) || 120) * 1000, histMax = Number(historyMaxMessages) || 0;
  const histCallMs = Math.max(5, Number(historyCallSec) || 60) * 1000;
  expected = Number(expected) || 0;
  linkMode = ['api', 'ui'].includes(linkMode) ? linkMode : 'auto';
  if (forceSync) refresh = true;       // force sync also asks the server for every group again
  const DELAY = Math.max(1000, Number(delay) || 1500);
  reconnectCount = 0; retryCount = 0;
  const fmt = ts => {
    if (!ts) return '';
    const d = new Date(Number(ts) * 1000), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  // ---- Force sync: reload WhatsApp so it fetches your data from the server again ----
  if (forceSync && mode === 'desktop') {
    log('Force sync (WhatsApp Desktop): no reload. Asking WhatsApp for the full group list and for older chats instead.');
  } else if (forceSync) {
    log('Force sync: reloading WhatsApp so it downloads your chats, groups and contacts from the server again...');
    const pg0 = getPage();
    try { await pg0.reload({ waitUntil: 'domcontentloaded', timeout: 120000 }); } catch (e) { log('Reload problem (continuing): ' + short(e)); }
    await sleep(8000);
    await ensureInit(pg0);
    inviteChecked = false;
  }

  // ---- Wait until WhatsApp has finished syncing (chat, group and contact counts stop changing) ----
  if (!skipWait || forceSync) {
    const stableNeeded = Math.max(4, Math.ceil((Number(syncStableSec) || 120) / 10));
    const maxChecks = Math.max(stableNeeded + 1, (Number(syncMaxMin) || 20) * 6);
    log(`Waiting for WhatsApp to finish syncing (the counts must stay unchanged for about ${stableNeeded * 10} seconds, at most ${Math.round(maxChecks / 6)} minutes)...`);
    let sig = '', same = 0;
    for (let k = 0; k < maxChecks && same < stableNeeded; k++) {
      try { await pageCall(PAGE_SCROLL_CHATLIST); } catch (e) {}        // nudge WhatsApp to load older chats
      const d = await pageCall(PAGE_DIAG);
      const now = [d.chats, d.groupsTotal, d.saved].join('|');
      if (now === sig) same++;
      else { same = 0; log(`Syncing... chats ${d.chats}, groups ${d.groupsTotal}, saved contacts ${d.saved}, hidden-ID contacts ${d.lidContacts}`); }
      sig = now;
      if (same < stableNeeded) await sleep(10000);
    }
    log(same >= stableNeeded ? `Sync looks complete (no changes for ${stableNeeded * 10} seconds).` : 'Counts were still changing at the time limit. Continuing with what is loaded.');
  }

  // ---- Ask WhatsApp's server for the list of ALL groups of the account (not only the ones already on this device) ----
  let srvInfo = { serverCount: 0, withMembers: 0, onThisDevice: 0 };
  try {
    const lg = await pageCall(PAGE_TRY_LIST_ALL_GROUPS);
    serverListUsed = true;
    log('WhatsApp functions that can list all groups: ' + (lg.names.length ? lg.names.join(', ') : 'none found'));
    for (const d of lg.debug) log('Full group list answer: ' + d);
    if (lg.errors.length) log('Full group list problems: ' + lg.errors.join(' || '));
    srvInfo = lg;
    log(`WhatsApp's server lists ${lg.serverCount} groups (${lg.withMembers} with member lists, ${lg.onThisDevice} already on this device).`);
    if (lg.pendingIds.length) {
      log(`Fetching ${lg.pendingIds.length} more groups from the server one by one...`);
      let okAll = 0, failAll = 0;
      for (let k = 0; k < lg.pendingIds.length; k += 20) {
        const r = await pageCall(PAGE_FIND_GROUPS, lg.pendingIds.slice(k, k + 20));
        okAll += r.ok; failAll += r.fail;
        if ((k / 20) % 5 === 4) log(`  ...${Math.min(k + 20, lg.pendingIds.length)}/${lg.pendingIds.length} (fetched ${okAll}, not available ${failAll})`);
      }
      log(`Fetched ${okAll} groups from the server (${failAll} not available).`);
    }
    await sleep(2000);
  } catch (e) { log('Full group list request failed: ' + short(e)); }

  // ---- Contacts ----
  log('Reading contacts...');
  const contacts = await pageCall(PAGE_CONTACTS);
  const savedCount = contacts.length;
  log(`Saved contacts found: ${savedCount}`);

  // ---- Groups: wait until the list stops growing ----
  log('Reading groups...');
  let list = [], prev = -1, stable = 0;
  for (let k = 0; k < 10; k++) {
    list = await pageCall(PAGE_LIST_GROUPS);
    log(`Groups loaded so far: ${list.length}`);
    if (list.length === prev) { stable++; if (stable >= 3) break; } else stable = 0;
    prev = list.length;
    await sleep(4000);
  }
  log(`Groups found: ${list.length} (no limit)`);
  const noTime = list.filter(g => !g.t);
  if (noTime.length) {
    log(`Finding the last activity of ${noTime.length} groups...`);
    for (const g of noTime) {
      try { const r = await pageCall(PAGE_LAST_MSG, g.id, !!forceSync); g.t = Math.max(r.t, r.msgTs); g.src = g.t ? 'Latest message' : ''; } catch (e) {}
      await sleep(300);
    }
  }
  let fallbackDates = 0;
  for (const g of list) {
    if (g.t && !g.src) g.src = 'Chat activity';
    if (!g.t && g.creation) { g.t = g.creation; g.src = 'Group creation date (no messages found)'; fallbackDates++; }
  }
  if (!list.length) { log('No groups found. Wait a minute for chats to finish loading, then click Export again.'); return; }

  const diag = await printDiag('Sync check:', expected);

  // ---- Saved progress (resume after a lost connection) ----
  let ck = fresh ? null : loadCkpt();
  if (ck && !(ck.getLinks === !!getLinks && Date.now() - ck.savedAt < 12 * 3600 * 1000)) ck = null;
  const store = { savedAt: Date.now(), getLinks: !!getLinks, groups: ck ? ck.groups : {} };
  const reusable = e => e && e.res && e.res.parts && e.res.parts.length &&
    !(e.res.declared && e.res.parts.length < e.res.declared) &&
    !(getLinks && e.res.amAdmin && !String(e.res.link).startsWith('https://'));
  const resumed = list.filter(g => reusable(store.groups[g.id])).length;
  if (resumed) log(`Resuming: ${resumed} groups already read, ${list.length - resumed} left.`);

  let inviteBroken = false, libFails = 0, sinceSave = 0, aborted = null, uiOk = 0, uiFails = 0;
  const gdata = [];
  log(`Phase 1: reading all ${list.length} groups (members, admins, invite links)...`);

  for (let i = 0; i < list.length; i++) {
    const g = list[i];
    let res;
    try {
    const cached = store.groups[g.id];
    if (reusable(cached)) {
      res = cached.res;
    } else {
      let force = !!refresh;
      for (let attempt = 0; attempt < 3; attempt++) {
        res = await pageCall(PAGE_READ_GROUP, g.id, !!getLinks && linkMode !== 'ui' && !inviteBroken, force);
        if (getLinks && !res.amAdmin && !res.link) res.link = 'Not admin';

        // first admin group: make sure WhatsApp's invite-link code is loaded
        if (getLinks && !inviteBroken && res.dbg && !inviteChecked) {
          inviteChecked = true;
          log('Invite functions found: ' + res.dbg);
          if (/functions=\[\]/.test(res.dbg)) {
            const ok = await autoLoadInvite(g.id);
            if (ok) {
              res = await pageCall(PAGE_READ_GROUP, g.id, true);
              log('Invite functions after auto-load: ' + res.dbg);
            } else {
              inviteBroken = true;
              log('WARNING: could not load the invite-link code automatically. The export continues without links; admin groups will say so in the Group Link column. Tick "Show the WhatsApp window", Connect, open any admin group > Group info > Invite to group via link (do NOT press Reset link), then Export again to add links.');
            }
          }
        }
        if (getLinks && inviteBroken && res.amAdmin) res.link = 'Error: invite-link code could not be loaded';

        if (res.fetched || (getLinks && !inviteBroken && res.amAdmin)) await sleep(DELAY);

        // fallback: the library's own invite method
        if (mode === 'chrome' && client && getLinks && !inviteBroken && res.amAdmin && !String(res.link).startsWith('https://') && libFails < 3) {
          try {
            const chat = await withConn(() => client.getChatById(g.id));
            const code = await chat.getInviteCode();
            if (code) { res.link = 'https://chat.whatsapp.com/' + code; libFails = 0; }
          } catch (e) { libFails++; res.link += ' | lib: ' + short(e).slice(0, 60); }
          await sleep(DELAY);
        }

        if (res.parts.length && !(res.declared && res.parts.length < res.declared)) break;
        force = true;                       // empty or incomplete member list: ask WhatsApp's server again
        await sleep(attempt < 2 ? 2000 : 0);
      }
      // read the link from Group info > Invite to group via link (always in 'ui' mode, as a backup in 'auto' mode)
      if (getLinks && res.amAdmin && linkMode !== 'api' && !String(res.link).startsWith('https://') && uiFails < 5) {
        const u = await readLinkViaUI(g.id);
        if (u.link) { res.link = u.link; uiOk++; uiFails = 0; }
        else {
          uiFails++;
          res.link = (linkMode === 'ui' ? 'Error: ' : String(res.link).slice(0, 100) + ' | Group info: ') + u.err;
          if (uiFails >= 5) log('Reading links from the Group info screen failed 5 times in a row, so it is switched off for the rest of this export. Last reason: ' + u.err);
        }
        await sleep(DELAY);
      }
      // 'ui' mode: if the screen did not work for this group, try the direct request once
      if (getLinks && res.amAdmin && linkMode === 'ui' && !String(res.link).startsWith('https://') && !inviteBroken) {
        try {
          const r2 = await pageCall(PAGE_READ_GROUP, g.id, true, false);
          if (String(r2.link).startsWith('https://')) res.link = r2.link; else res.link += ' | direct: ' + String(r2.link).slice(0, 80);
        } catch (e) {}
      }
      store.groups[g.id] = { res, hist: (cached && cached.hist) || undefined };
      if (++sinceSave >= 5) { store.savedAt = Date.now(); saveCkpt(store); sinceSave = 0; }
    }
    gdata.push({ i, id: g.id, name: g.name, creation: g.creation, last: g.t, src: g.src || '', res, hist: null });
    send('progress', `Phase 1 - groups ${i + 1}/${list.length}`);
    } catch (e) { aborted = e; log(`Stopped at group ${i + 1}/${list.length}: ${short(e)}`); break; }
  }
  const unread = list.slice(gdata.length);
  if (!gdata.length) throw aborted || new Error('No group could be read');
  if (aborted) log(`Connection could not be restored. Saving what was read so far (${gdata.length} of ${list.length} groups). Click Export again later to finish the rest.`);
  store.savedAt = Date.now(); saveCkpt(store);

  // ---- PHASE 2: sync the chats of ALL these groups and find the last message of every member ----
  let histAborted = null;
  if (memberHistory) {
    log(`Phase 2: loading the chats (older messages) of ${gdata.length} groups to find the last activity of the groups and of every member...`);
    for (let k = 0; k < gdata.length; k++) {
      const d = gdata[k];
      const ent = store.groups[d.id];
      let hist = (ent && ent.hist && ent.hist.ok) ? ent.hist : null;
      if (!hist) {
        try { hist = await pageCall(PAGE_HISTORY, d.id, histBudgetMs, histMax, histCallMs); }
        catch (e) { histAborted = e; log(`Phase 2 stopped at group ${k + 1}/${gdata.length}: ${short(e)}`); break; }
        if (ent) ent.hist = hist;
        if (++sinceSave >= 5) { store.savedAt = Date.now(); saveCkpt(store); sinceSave = 0; }
      }
      d.hist = hist;
      if (hist && hist.ok && hist.newest && hist.newest > d.last) { d.last = hist.newest; d.src = 'Latest message (older messages loaded)'; }
      send('progress', `Phase 2 - chats ${k + 1}/${gdata.length}` + (hist && hist.ok ? ` (messages scanned in this group: ${hist.total})` : ''));
    }
    store.savedAt = Date.now(); saveCkpt(store);
  }

  // ---- Resolve every person to ONE identity (phone number when known), so duplicates are exact ----
  const lidToPhone = new Map();
  for (const d of gdata) for (const p of d.res.parts) if (p.lid && p.phone) lidToPhone.set(p.lid, p.phone);
  const memberGroups = new Map();
  const personLast = new Map();   // person -> { t, name } = their newest message in any group
  for (const d of gdata) {
    const am = new Map();
    if (d.hist && d.hist.ok) for (const a of d.hist.authors) am.set(a.user, Math.max(am.get(a.user) || 0, a.t));
    d.members = d.res.parts.map(p => {
      const phone = p.phone || (p.lid && lidToPhone.get(p.lid)) || '';
      const key = phone || 'id:' + (p.lid || p.user);
      const lastT = (p.isMe && d.hist && d.hist.meT) ? d.hist.meT : (am.get(p.user) || (p.lid && am.get(p.lid)) || (p.phone && am.get(p.phone)) || 0);
      return { num: phone || 'Hidden', key, saved: p.saved, savedName: p.savedName, pushName: p.pushName, admin: p.admin, isMe: p.isMe, lastT };
    });
    for (const m of d.members) {
      if (m.lastT && m.lastT > ((personLast.get(m.key) || {}).t || 0)) personLast.set(m.key, { t: m.lastT, name: d.name });
      if (!memberGroups.has(m.key)) memberGroups.set(m.key, []);
      memberGroups.get(m.key).push({ i: d.i, name: d.name, admin: m.admin });
    }
    d.amAdmin = d.res.amAdmin;
    d.link = d.res.link;
    d.created = d.creation ? new Date(d.creation * 1000).toISOString().slice(0, 10) : '';
  }

  // ---- Totals for the check sheet ----
  const adminGroups = gdata.filter(d => d.amAdmin);
  const linksOk = adminGroups.filter(d => String(d.link).startsWith('https://')).length;
  const emptyGroups = gdata.filter(d => !d.members.length);
  const memberRowsTotal = gdata.reduce((n, d) => n + d.members.length, 0);
  const hiddenPeople = [...memberGroups.keys()].filter(k => k.startsWith('id:')).length;
  log(`Groups: ${gdata.length} | You are admin in: ${adminGroups.length} | Links: ${linksOk} | Groups with no members loaded: ${emptyGroups.length} | Reconnects: ${reconnectCount} | Retries: ${retryCount}`);

  // ---- Excel ----
  const groupsOf = k => memberGroups.get(k) || [];
  const histOf = d => (d.hist && d.hist.ok ? d.hist : null);
  const cap = t => (t.length > 32000 ? t.slice(0, 32000) + ' | ...' : t);
  const others = (m, d) => cap(groupsOf(m.key).filter(e => e.i !== d.i).map(e => e.name).join(' | '));
  const sheetsOut = [];
  const addSheet = (name, header, rows, widths) => { sheetsOut.push({ name, rows: [header, ...rows], widths }); };
  const days = d => d.last ? Math.floor((Date.now() / 1000 - d.last) / 86400) : '';
  const nowStr = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // Sheet: Summary / checks
  addSheet('Summary', ['Check', 'Value'], [
    ['Export time (UTC)', nowStr],
    ['Data source', 'Android app (WhatsApp Web inside)'],
    ['Groups found (no limit)', list.length],
    ['Phase 2 (chat sync of all groups) finished', memberHistory ? (histAborted ? 'NO - stopped: ' + short(histAborted) : 'yes') : 'not requested'],
    ['Groups read in this file', gdata.length + ' of ' + list.length + (aborted ? '  (INCOMPLETE - connection lost)' : '')],
    ['Groups whose last activity is the creation date (no messages found)', fallbackDates],
    ['Groups complete (member list matches the group size)', gdata.filter(d => statusOf(d.res) === 'OK').length],
    ['Groups INCOMPLETE (fewer members read than the group size)', gdata.filter(d => statusOf(d.res).startsWith('INCOMPLETE')).length],
    ['Groups EMPTY (no member list could be read)', gdata.filter(d => statusOf(d.res) === 'EMPTY').length],
    ['Chats loaded in WhatsApp at export time', diag.chats],
    ["Groups in WhatsApp's full group list (server)", srvInfo.serverCount],
    ['Groups whose chat is on this device (member last-message dates possible)', gdata.filter(d => histOf(d)).length],
    ['Groups known only from the server (no chat on this device)', memberHistory ? gdata.filter(d => !histOf(d)).length : 'n/a'],
    ['Groups whose whole message history was loaded', gdata.filter(d => histOf(d) && d.hist.reached).length],
    ['Groups with only partial history (older messages could not be loaded)', gdata.filter(d => memberHistory && !(histOf(d) && d.hist.reached)).length],
    ['Messages scanned in total', gdata.reduce((n, d) => n + (histOf(d) ? d.hist.total : 0), 0)],
    ['Groups you expected (optional input)', expected || 'not given'],
    ['Groups missing compared to what you expected', expected ? Math.max(0, expected - list.length) : 'n/a'],
    ['Saved contacts synced to this WhatsApp window', diag.saved],
    ['Saved contacts that have a phone number', diag.savedWithNum],
    ['Groups where I am admin', adminGroups.length],
    ['Invite links retrieved', linksOk],
    ['  of which read from the Group info screen', uiOk],
    ['Link mode / force sync', linkMode + ' / ' + (forceSync ? 'on' : 'off')],
    ['Admin groups without a link', adminGroups.length - linksOk],
    ['Groups with no members loaded (see Issues)', emptyGroups.length],
    ['Member rows (person x group)', memberRowsTotal],
    ['Unique people', memberGroups.size],
    ['People whose number is hidden by WhatsApp', hiddenPeople],
    ['Saved contacts on this account', savedCount],
    ['Groups resumed from saved progress', resumed],
    ['Connection retries during export', retryCount],
    ['Reconnects during export', reconnectCount],
    ['Connection events', events.length ? events.join('  |  ').slice(0, 3000) : 'none']
  ], [60, 90]);

  // Sheet: Groups
  addSheet('Groups',
    ['Group Name', 'Group Link', 'Am I Admin?', 'Creation Date', 'Last Activity Date', 'Last Activity Source', 'Days Inactive',
     'Members Count', 'Admins Count', 'Admins (name:number)', 'Saved Contacts Count', 'Duplicated Members'],
    gdata.map(d => [
      d.name, d.link, d.amAdmin ? 'Yes' : 'No', d.created, fmt(d.last), d.src, days(d),
      d.members.length, d.members.filter(m => m.admin).length,
      cap(d.members.filter(m => m.admin).map(m => `${m.savedName || m.pushName}:${m.num}`).join(' | ')),
      d.members.filter(m => m.saved).length,
      d.members.filter(m => groupsOf(m.key).length > 1).length
    ]),
    [34, 44, 12, 14, 18, 26, 12, 12, 12, 50, 14, 14]);

  // Sheet: My Admin Groups
  addSheet('My Admin Groups',
    ['Group Name', 'Group Link', 'Creation Date', 'Last Activity Date', 'Last Activity Source', 'Days Inactive', 'Members Count'],
    adminGroups.map(d => [d.name, d.link, d.created, fmt(d.last), d.src, days(d), d.members.length]),
    [34, 44, 14, 18, 26, 12, 12]);

  const lastText = (m, d) => {
    if (m.lastT) return fmt(m.lastT);
    const h = histOf(d);
    if (!h) return '(older messages not loaded)';
    return h.reached ? '(no messages)' : '(none since ' + fmt(h.oldest).slice(0, 10) + ')';
  };

  // Sheet(s): Members (split automatically if Excel's row limit would be exceeded)
  const mHeader = ['Group Name', 'Group Link', 'Group Last Activity Date', 'Member Last Message In This Group', 'My Saved Name',
    'WhatsApp Name', 'In My Contacts?', 'Number', 'Is Admin?', 'In Other Groups?', 'In Groups Count', 'Other Groups'];
  const mWidths = [34, 44, 18, 24, 26, 24, 14, 18, 10, 14, 14, 60];
  const mrows = [];
  for (const d of gdata) for (const m of d.members) {
    if (savedOnly && !m.saved) continue;
    const n = groupsOf(m.key).length;
    mrows.push([d.name, d.link, fmt(d.last), lastText(m, d), m.savedName, m.pushName,
      m.saved ? 'Yes' : 'No', m.num, m.admin ? 'Yes' : 'No', n > 1 ? 'Yes' : 'No', n, others(m, d)]);
  }
  const CHUNK = 1000000;
  for (let k = 0, part = 1; k < Math.max(mrows.length, 1); k += CHUNK, part++) {
    addSheet(part === 1 ? 'Members' : 'Members ' + part, mHeader, mrows.slice(k, k + CHUNK), mWidths);
  }

  // Sheet: Contacts
  const crows = contacts.map(c => {
    const key = c.number || lidToPhone.get(c.lid || c.user) || 'id:' + (c.lid || c.user);
    const gs = groupsOf(key);
    return [c.name || c.push || '', 'Yes', c.number || 'Hidden', gs.length,
      gs.length > 1 ? 'Duplicated' : (gs.length ? 'Unique' : 'No group'),
      gs.filter(e => e.admin).length, cap(gs.map(e => e.name).join(' | '))];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  addSheet('Contacts',
    ['Contact Name', 'In My Contacts?', 'Number', 'Groups Count', 'Duplicated?', 'Admin In (count)', 'Groups'],
    crows, [28, 14, 18, 12, 12, 14, 70]);

  // Sheet: Issues (everything that could not be read completely)
  const irows = [];
  for (const d of gdata) {
    if (!d.members.length) irows.push([d.name, 'Member list could not be loaded (run Export again)']);
    if (d.amAdmin && !String(d.link).startsWith('https://')) irows.push([d.name, d.link]);
  }
  for (const g of unread) irows.push([g.name, 'NOT READ - connection was lost before this group (click Export again to continue)']);
  if (!irows.length) irows.push(['(none)', 'Every group was read completely']);
  addSheet('Issues', ['Group Name', 'Problem'], irows, [40, 120]);

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const partial = !!(aborted || histAborted);
  const fileName = `whatsapp_groups_export_${stamp}${partial ? '_PARTIAL' : ''}.xlsx`;
  status('Building the Excel file...');
  const bytes = await buildXlsx(sheetsOut);
  A.fileBegin(fileName);
  for (let i = 0; i < bytes.length; i += 600000) A.fileChunk(toB64(bytes.subarray(i, i + 600000)));
  A.fileEnd(fileName, partial);
  if (!partial) A.clearState();
  log(`Done. Saved in your Downloads folder: ${fileName}` + (partial ? ' (PARTIAL - tap Start again later to read the remaining groups)' : ''));
}


  // ---------------- minimal XLSX writer (with compression when the WebView supports it) ----------------
  const enc = new TextEncoder();
  const crcTable = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = bytes => { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === 'undefined') return null;
    try {
      const cs = new CompressionStream('deflate-raw');
      const w = cs.writable.getWriter();
      w.write(bytes); w.close();
      return new Uint8Array(await new Response(cs.readable).arrayBuffer());
    } catch (e) { return null; }
  }
  async function makeZip(files) {
    const now = new Date();
    const dTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [], central = [];
    let offset = 0;
    for (const f of files) {
      const name = enc.encode(f.name);
      const crc = crc32(f.data);
      const z = await deflateRaw(f.data);
      const method = z && z.length < f.data.length ? 8 : 0;
      const body = method === 8 ? z : f.data;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(8, method, true); lh.setUint16(10, dTime, true); lh.setUint16(12, dDate, true);
      lh.setUint32(14, crc, true); lh.setUint32(18, body.length, true); lh.setUint32(22, f.data.length, true);
      lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      parts.push(new Uint8Array(lh.buffer), name, body);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true); ch.setUint16(10, method, true); ch.setUint16(12, dTime, true); ch.setUint16(14, dDate, true);
      ch.setUint32(16, crc, true); ch.setUint32(20, body.length, true); ch.setUint32(24, f.data.length, true);
      ch.setUint16(28, name.length, true); ch.setUint16(30, 0, true); ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true); ch.setUint16(36, 0, true); ch.setUint32(38, 0, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + body.length;
    }
    const cdSize = central.reduce((s, p) => s + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(4, 0, true); end.setUint16(6, 0, true);
    end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, cdSize, true); end.setUint32(16, offset, true); end.setUint16(20, 0, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)];
    const total = all.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let pos = 0;
    for (const p of all) { out.set(p, pos); pos += p.length; }
    return out;
  }
  const colName = n => { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
  const xmlEsc = v => String(v == null ? '' : v)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .slice(0, 32000)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const sheetXml = (rows, widths) => {
    const nCols = Math.max(...rows.map(r => r.length));
    const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'];
    parts.push('<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    let cols = '<cols>';
    for (let i = 0; i < nCols; i++) cols += `<col min="${i + 1}" max="${i + 1}" width="${(widths && widths[i]) || 18}" customWidth="1"/>`;
    parts.push(cols + '</cols><sheetData>');
    rows.forEach((r, ri) => {
      let x = `<row r="${ri + 1}">`;
      r.forEach((v, ci) => {
        const ref = colName(ci) + (ri + 1);
        if (typeof v === 'number' && isFinite(v)) x += `<c r="${ref}"><v>${v}</v></c>`;
        else x += `<c r="${ref}" t="inlineStr"${ri === 0 ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlEsc(v)}</t></is></c>`;
      });
      parts.push(x + '</row>');
    });
    parts.push(`</sheetData><autoFilter ref="A1:${colName(nCols - 1)}${rows.length}"/></worksheet>`);
    return parts.join('');
  };
  async function buildXlsx(sheets) {
    const H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    const files = [
      { name: '[Content_Types].xml', data: enc.encode(H + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' + sheets.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') + '</Types>') },
      { name: '_rels/.rels', data: enc.encode(H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: enc.encode(H + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheets.map((s, i) => `<sheet name="${xmlEsc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') + '</sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode(H + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + sheets.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') + `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
      { name: 'xl/styles.xml', data: enc.encode(H + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>') }
    ];
    for (let i = 0; i < sheets.length; i++) files.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: enc.encode(sheetXml(sheets[i].rows, sheets[i].widths)) });
    return makeZip(files);
  }
  function toB64(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
    return btoa(s);
  }

  // ---------------- start / wait for the link ----------------
  async function waitReady() {
    status('Waiting for WhatsApp to be linked and loaded. Link it in the page below (Link with phone number).');
    for (let k = 0; k < 360; k++) {                 // up to 30 minutes
      try { const r = PAGE_INIT(); if (r.ok && r.chats > 0) return r.chats; } catch (e) {}
      if (k % 6 === 5) log('Still waiting for the WhatsApp link / chats to load...');
      await sleep(5000);
    }
    throw new Error('WhatsApp was not linked within 30 minutes.');
  }
  const wx = {
    running: false,
    async start(cfgJson) {
      if (wx.running) return;
      wx.running = true;
      try {
        const c = Object.assign({ getLinks: true, refresh: true, skipWait: false, syncStableSec: 60, syncMaxMin: 15, delay: 1500,
          memberHistory: true, historyBudgetSec: 120, historyCallSec: 60, historyMaxMessages: 0, savedOnly: false, expected: 0 }, JSON.parse(cfgJson || '{}'));
        await waitReady();
        status('Connected. Exporting your data. Keep the app open and the phone charging - this can take a long time.');
        await runExport({ getLinks: c.getLinks, savedOnly: c.savedOnly, delay: c.delay, fresh: false, refresh: c.refresh, expected: c.expected,
          skipWait: c.skipWait, syncStableSec: c.syncStableSec, syncMaxMin: c.syncMaxMin, linkMode: 'api', forceSync: false,
          memberHistory: c.memberHistory, historyBudgetSec: c.historyBudgetSec, historyCallSec: c.historyCallSec, historyMaxMessages: c.historyMaxMessages });
      } catch (e) {
        try { A.fail(String((e && e.message) || e)); } catch (x) {}
      }
      wx.running = false;
    }
  };
  window.__waExporter = wx;
})();
