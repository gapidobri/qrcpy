'use strict';

// ---------- Small helpers ----------

const $ = (sel) => document.querySelector(sel);
const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

const store = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch {} },
  del(k) { try { sessionStorage.removeItem(k); } catch {} },
};

// The device name is remembered across sessions, unlike everything else.
const device = {
  get() { try { return localStorage.getItem('qrcpy-name'); } catch { return null; } },
  set(v) { try { localStorage.setItem('qrcpy-name', v); } catch {} },
};

const cleanName = (v) => (typeof v === 'string' ? v.trim().slice(0, 40) : '');

const PEER_COLORS = ['#FFD43B', '#FF8FB1', '#5BE3B0', '#8FD3FF', '#C9A7FF', '#FFB066'];
const colorFor = (id) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PEER_COLORS[h % PEER_COLORS.length];
};

// Images the browser can show inline; these are fetched as soon as they're shared.
const PREVIEWABLE = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml']);
const PREVIEW_LIMIT = 25 * 1024 * 1024;
// Text longer than this is shared as a .txt file so it doesn't overflow a data channel message.
const TEXT_LIMIT = 100_000;

function deviceName() {
  const ua = navigator.userAgent;
  const browser =
    /Edg\//.test(ua) ? 'Edge' :
    /OPR\//.test(ua) ? 'Opera' :
    /Firefox\//.test(ua) ? 'Firefox' :
    /Chrome\//.test(ua) ? 'Chrome' :
    /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os =
    /iPhone/.test(ua) ? 'iPhone' :
    /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad' :
    /Android/.test(ua) ? 'Android' :
    /Windows/.test(ua) ? 'Windows' :
    /Mac OS X/.test(ua) ? 'Mac' :
    /CrOS/.test(ua) ? 'ChromeOS' :
    /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  // Long messages stay up long enough to read.
  toastTimer = setTimeout(() => el.classList.remove('show'), Math.max(2400, msg.length * 60));
}

const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const coarsePointer = matchMedia('(pointer: coarse)');
const canHover = matchMedia('(hover: hover)');

// ---------- State ----------

const me = {
  id: store.get('cid') || randomHex(16),
  name: cleanName(device.get()) || deviceName(),
};
store.set('cid', me.id);

const state = {
  room: store.get('room'),
  session: store.get('session') === '1',
  code: '',
  ice: [],
  lan: [],
  origin: '',
  ttl: 60_000,
  pendingJoin: null,
};

const items = new Map();    // id -> item metadata (text items carry their text)
const blobs = new Map();    // id -> Blob held by this device
const holders = new Map();  // id -> Set of peer ids that hold the file
const tombstones = new Set();
const peers = new Map();    // peer id -> { id, name, pc, ctl, queue, color }
const transfers = new Map(); // transfer id -> download in progress
const fetching = new Map();  // item id -> transfer
const uploads = new Map();   // item id -> Map of transfer id -> upload this device is sending

// ---------- Persistence ----------

// Keeps this tab's cards and files in IndexedDB so a refresh doesn't lose them.
// IndexedDB is shared by every tab, so records are keyed by this tab's id.
const persist = (() => {
  const STALE = 24 * 60 * 60 * 1000;
  let dbp;
  const open = () => dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('qrcpy', 1);
    req.onupgradeneeded = () => {
      for (const name of ['items', 'blobs', 'tabs']) req.result.createObjectStore(name);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const key = (id) => `${me.id}:${id}`;
  const range = (cid) => IDBKeyRange.bound(`${cid}:`, `${cid}:\uffff`);

  // fn queues requests on the transaction and may return a function that
  // reads their results once it completes.
  async function run(stores, mode, fn) {
    try {
      const db = await open();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(stores, mode);
        const read = fn(tx);
        tx.oncomplete = () => resolve(read?.());
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } catch (err) {
      console.warn('could not use storage', err);
      return undefined;
    }
  }

  const clear = (cid) => run(['items', 'blobs', 'tabs'], 'readwrite', (tx) => {
    tx.objectStore('items').delete(range(cid));
    tx.objectStore('blobs').delete(range(cid));
    tx.objectStore('tabs').delete(cid);
  });

  return {
    putItem: (it) => run('items', 'readwrite', (tx) => { tx.objectStore('items').put(it, key(it.id)); }),
    putBlob: (id, blob) => run('blobs', 'readwrite', (tx) => { tx.objectStore('blobs').put(blob, key(id)); }),
    remove: (id) => run(['items', 'blobs'], 'readwrite', (tx) => {
      tx.objectStore('items').delete(key(id));
      tx.objectStore('blobs').delete(key(id));
    }),
    saveMeta: () => run('tabs', 'readwrite', (tx) => {
      tx.objectStore('tabs').put({ lastSeen: Date.now(), tombstones: [...tombstones] }, me.id);
    }),
    clear: () => clear(me.id),
    load: () => run(['items', 'blobs', 'tabs'], 'readonly', (tx) => {
      const list = tx.objectStore('items').getAll(range(me.id));
      const keys = tx.objectStore('blobs').getAllKeys(range(me.id));
      const values = tx.objectStore('blobs').getAll(range(me.id));
      const meta = tx.objectStore('tabs').get(me.id);
      return () => ({
        items: list.result,
        blobs: new Map(keys.result.map((k, i) => [k.slice(me.id.length + 1), values.result[i]])),
        tombstones: meta.result?.tombstones || [],
      });
    }),
    // Drops what tabs closed long ago left behind.
    async sweep() {
      const tabs = await run('tabs', 'readonly', (tx) => {
        const keys = tx.objectStore('tabs').getAllKeys();
        const values = tx.objectStore('tabs').getAll();
        return () => keys.result.map((k, i) => [k, values.result[i]]);
      });
      for (const [cid, meta] of tabs || []) {
        if (cid !== me.id && Date.now() - (meta?.lastSeen || 0) > STALE) await clear(cid);
      }
    },
  };
})();

// ---------- Signaling ----------

let ws;
let wsRetry = 0;

function connect() {
  const url = new URL('/ws', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('cid', me.id);
  url.searchParams.set('name', me.name);
  if (state.room) url.searchParams.set('room', state.room);

  ws = new WebSocket(url);
  ws.onopen = () => { wsRetry = 0; };
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onclose = () => {
    ws = null;
    setTimeout(connect, Math.min(500 * 2 ** wsRetry++, 8000));
  };
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function onServer(m) {
  switch (m.t) {
    case 'hello':
      state.room = m.room;
      state.ice = m.ice || [];
      state.lan = m.lan || [];
      state.origin = m.origin || '';
      state.ttl = m.ttl || state.ttl;
      if (state.session) store.set('room', state.room);
      setCode(m.code, m.left);
      for (const p of [...peers.values()]) closePeer(p);
      for (const p of m.peers) addPeer(p, true);
      if (m.peers.length) enterSession();
      if (state.pendingJoin) sendJoin(state.pendingJoin);
      break;
    case 'code':
      setCode(m.code, m.left);
      break;
    case 'joined':
      state.room = m.room;
      state.ice = m.ice || state.ice;
      state.pendingJoin = null;
      store.set('room', state.room);
      for (const p of [...peers.values()]) closePeer(p);
      setCode(m.code, m.left);
      for (const p of m.peers) addPeer(p, true);
      joinDone();
      enterSession();
      break;
    case 'join-error':
      state.pendingJoin = null;
      joinFailed(m.msg);
      break;
    case 'peer-join':
      // The newcomer sends the offer; this side just waits for it.
      addPeer(m, false);
      enterSession();
      if (leaveTimers.has(m.id)) {
        // Back from a refresh: nothing to announce.
        clearTimeout(leaveTimers.get(m.id));
        leaveTimers.delete(m.id);
      } else {
        toast(`${m.name} joined`);
      }
      break;
    case 'peer-leave': {
      const p = peers.get(m.id);
      if (!p) break;
      closePeer(p);
      // A refresh looks like leaving and coming back, so wait before dropping
      // their files, unless they said goodbye.
      clearTimeout(leaveTimers.get(p.id));
      leaveTimers.set(p.id, setTimeout(() => peerGone(p), p.bye ? 0 : LEAVE_GRACE));
      break;
    }
    case 'signal':
      onSignal(m.from, m.data);
      break;
  }
}

const LEAVE_GRACE = 10_000;
const leaveTimers = new Map(); // peer id -> timer that finalizes their leaving

function peerGone(p) {
  leaveTimers.delete(p.id);
  if (peers.has(p.id)) return;
  const gone = pruneOrphans();
  toast(gone ? `${p.name} left. ${gone === 1 ? 'A file' : `${gone} files`} only they had ${gone === 1 ? 'is' : 'are'} gone.` : `${p.name} left`);
}

// ---------- WebRTC mesh ----------

function addPeer(info, initiator) {
  const old = peers.get(info.id);
  if (old) closePeer(old);

  const pc = new RTCPeerConnection({ iceServers: state.ice });
  const p = { id: info.id, name: info.name || 'A device', pc, ctl: null, queue: [], color: colorFor(info.id) };
  peers.set(p.id, p);

  pc.onicecandidate = (e) => {
    if (e.candidate) wsSend({ t: 'signal', to: p.id, data: { ice: e.candidate } });
  };
  pc.ondatachannel = (e) => {
    if (e.channel.label === 'ctl') setupCtl(p, e.channel);
    else if (e.channel.label.startsWith('f:')) receiveFile(p, e.channel);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' && peers.get(p.id) === p) {
      toast(`Couldn't reach ${p.name} directly. The networks may block peer-to-peer connections.`);
    }
    renderPeers();
  };

  if (initiator) {
    setupCtl(p, pc.createDataChannel('ctl'));
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => wsSend({ t: 'signal', to: p.id, data: { sdp: pc.localDescription } }))
      .catch((err) => console.error('offer failed', err));
  }
  renderPeers();
  return p;
}

function closePeer(p) {
  if (peers.get(p.id) === p) peers.delete(p.id);
  try { p.pc.close(); } catch {}
  for (const set of holders.values()) set.delete(p.id);
  for (const xf of transfers.values()) {
    if (xf.peer === p.id) tryNextHolder(xf);
  }
  // Closing the connection ourselves fires no channel close events.
  for (const list of [...uploads.values()]) {
    for (const up of [...list.values()]) if (up.peer === p.id) up.finish();
  }
  renderPeers();
  refreshAvailability();
}

async function onSignal(from, data) {
  let p = peers.get(from);
  try {
    if (data.sdp) {
      if (data.sdp.type === 'offer' && (!p || p.pc.remoteDescription)) {
        p = addPeer({ id: from, name: p?.name }, false);
      }
      if (!p) return;
      await p.pc.setRemoteDescription(data.sdp);
      if (data.sdp.type === 'offer') {
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        wsSend({ t: 'signal', to: from, data: { sdp: p.pc.localDescription } });
      }
      for (const c of p.queue.splice(0)) await p.pc.addIceCandidate(c);
    } else if (data.ice && p) {
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(data.ice);
      else p.queue.push(data.ice);
    }
  } catch (err) {
    console.error('signaling failed', err);
  }
}

function setupCtl(p, ch) {
  p.ctl = ch;
  ch.onopen = () => {
    // Bring the other side up to date with everything this device knows about.
    peerSend(p, { t: 'name', name: me.name });
    if (tombstones.size) peerSend(p, { t: 'del', ids: [...tombstones] });
    // Say who holds which file before listing the items, including devices
    // the other side isn't connected to yet, so no card looks orphaned.
    const known = {};
    for (const [id, set] of holders) known[id] = [...set].filter((pid) => pid !== p.id);
    peerSend(p, { t: 'have', ids: [...blobs.keys()], known });
    for (const it of items.values()) peerSend(p, { t: 'add', item: it, have: blobs.has(it.id) });
    renderPeers();
  };
  ch.onclose = () => renderPeers();
  ch.onmessage = (e) => {
    try { onPeer(p, JSON.parse(e.data)); } catch (err) { console.error('bad peer message', err); }
  };
}

function peerSend(p, msg) {
  if (p.ctl && p.ctl.readyState === 'open') p.ctl.send(JSON.stringify(msg));
}

function broadcast(msg) {
  for (const p of peers.values()) peerSend(p, msg);
}

const isOpen = (p) => p && p.ctl && p.ctl.readyState === 'open';

function onPeer(p, m) {
  switch (m.t) {
    case 'add': {
      const it = m.item;
      if (!validItem(it)) break;
      if (m.have === true) addHolder(it.id, p.id);
      // Skip files that no device in the session can provide.
      if (it.kind === 'file' && !blobs.has(it.id) &&
          ![...(holders.get(it.id) || [])].some((pid) => peers.has(pid))) break;
      addItem(it, false);
      break;
    }
    case 'del':
      for (const id of m.ids) removeItem(id);
      break;
    case 'name': {
      const name = cleanName(m.name);
      if (!name || name === p.name) break;
      p.name = name;
      renderPeers();
      relabel(p.id);
      break;
    }
    case 'bye':
      p.bye = true;
      break;
    case 'have':
      for (const id of m.ids) addHolder(id, p.id);
      for (const [id, pids] of Object.entries(m.known || {})) {
        if (!Array.isArray(pids)) continue;
        for (const pid of pids) if (pid !== me.id && peers.has(pid)) addHolder(id, pid);
      }
      break;
    case 'get':
      if (blobs.has(m.id)) sendFile(p, m.x, m.id, blobs.get(m.id));
      else peerSend(p, { t: 'nope', x: m.x });
      break;
    case 'nope': {
      const xf = transfers.get(m.x);
      if (xf) tryNextHolder(xf);
      break;
    }
  }
}

function validItem(it) {
  if (!it || typeof it.id !== 'string' || typeof it.ts !== 'number') return false;
  if (it.kind === 'text') return typeof it.text === 'string';
  if (it.kind === 'file') return typeof it.name === 'string' && Number.isFinite(it.size) && it.size >= 0;
  return false;
}

// ---------- File transfer (only when someone asks for it) ----------

const CHUNK = 16 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;

async function sendFile(p, x, id, blob) {
  const ch = p.pc.createDataChannel(`f:${x}`, { ordered: true });
  ch.binaryType = 'arraybuffer';
  ch.bufferedAmountLowThreshold = HIGH_WATER / 4;
  const max = p.pc.sctp?.maxMessageSize;
  const chunk = max && max < 256 * 1024 ? Math.min(CHUNK * 4, max) : CHUNK * 4;

  const list = uploads.get(id) || new Map();
  uploads.set(id, list);
  const tick = setInterval(() => renderUpload(id), 250);
  const up = { peer: p.id, name: p.name, size: blob.size, ch, queued: 0, sentAll: false };
  // Runs once, when the receiver closes the channel or the peer goes away.
  up.finish = () => {
    if (!list.delete(x)) return;
    clearInterval(tick);
    if (!list.size) uploads.delete(id);
    renderUpload(id, up.sentAll ? `Sent to ${p.name}` : `Stopped sending to ${p.name}`);
  };
  list.set(x, up);
  ch.onclose = up.finish;
  renderUpload(id);

  try {
    await new Promise((resolve, reject) => {
      ch.onopen = resolve;
      ch.onerror = reject;
    });
    for (let off = 0; off < blob.size; off += chunk) {
      if (ch.readyState !== 'open') return;
      if (ch.bufferedAmount > HIGH_WATER) {
        await new Promise((r) => { ch.onbufferedamountlow = r; });
      }
      const buf = await blob.slice(off, off + chunk).arrayBuffer();
      ch.send(buf);
      up.queued += buf.byteLength;
    }
    ch.send('end');
    up.sentAll = true;
  } catch (err) {
    console.error('send failed', err);
    ch.close();
    up.finish();
  }
}

// Shows how much of a file has left this device for the devices fetching it.
function renderUpload(id, note) {
  const it = items.get(id);
  const card = cards.get(id);
  if (!it || !card) return;
  const list = [...(uploads.get(id)?.values() || [])];
  if (!list.length) {
    if (note) {
      card.dataset.note = note;
      card.dataset.noteUntil = Date.now() + 4000;
      setTimeout(() => refreshAvailability(id), 4100);
    }
    refreshAvailability(id);
    return;
  }
  let total = 0;
  let out = 0;
  for (const up of list) {
    total += up.size;
    // Bytes still in the browser's send buffer haven't left yet.
    const buffered = up.ch.readyState === 'open' ? up.ch.bufferedAmount : 0;
    out += up.sentAll && !buffered ? up.size : Math.max(0, up.queued - buffered);
  }
  const frac = total ? Math.min(1, out / total) : 1;
  const bar = card.querySelector('.progress');
  bar.hidden = false;
  bar.firstElementChild.style.setProperty('--p', frac);
  const who = list.length === 1 ? list[0].name : `${list.length} devices`;
  card.querySelector('.file-size').textContent = `Sending to ${who}, ${Math.floor(frac * 100)}%`;
}

function addHolder(id, pid) {
  if (!holders.has(id)) holders.set(id, new Set());
  holders.get(id).add(pid);
  refreshAvailability(id);
}

// Removes file cards whose bytes left with the devices that had them.
// Text and files this device already has (like auto-loaded photos) stay.
function pruneOrphans() {
  let gone = 0;
  for (const it of [...items.values()]) {
    if (it.kind !== 'file' || blobs.has(it.id) || fetching.has(it.id)) continue;
    if (![...(holders.get(it.id) || [])].some((pid) => peers.has(pid))) {
      // No tombstone: if a device with the file comes back, the card can too.
      removeItem(it.id, { tombstone: false });
      gone++;
    }
  }
  return gone;
}

// Files this device is the only one in the session to have.
function onlyHereFiles() {
  return [...blobs.keys()].filter((id) =>
    items.has(id) && ![...(holders.get(id) || [])].some((pid) => peers.has(pid)));
}

// Downloads come from the tab that has the file, so closing it ends them.
function servingFiles() {
  return peers.size > 0 && (uploads.size > 0 || onlyHereFiles().length > 0);
}

function fetchItem(id) {
  if (blobs.has(id)) return Promise.resolve(blobs.get(id));
  if (fetching.has(id)) return fetching.get(id).promise;

  const xf = { id, x: randomHex(8), tried: new Set(), peer: null, received: 0 };
  xf.promise = new Promise((resolve, reject) => { xf.resolve = resolve; xf.reject = reject; });
  xf.promise.catch(() => {});
  fetching.set(id, xf);
  setProgress(id, 0);
  tryNextHolder(xf);
  return xf.promise;
}

function tryNextHolder(xf) {
  const item = items.get(xf.id);
  transfers.delete(xf.x);
  if (!item) return finishTransfer(xf, new Error('removed'));

  const candidates = [...(holders.get(xf.id) || [])]
    .filter((pid) => !xf.tried.has(pid) && isOpen(peers.get(pid)));
  candidates.sort((a, b) => (b === item.by) - (a === item.by));
  if (!candidates.length) {
    return finishTransfer(xf, new Error('No connected device has this file right now.'));
  }
  const pid = candidates[0];
  xf.tried.add(pid);
  xf.peer = pid;
  xf.x = randomHex(8);
  xf.received = 0;
  transfers.set(xf.x, xf);
  peerSend(peers.get(pid), { t: 'get', id: xf.id, x: xf.x });
}

function receiveFile(p, ch) {
  const xf = transfers.get(ch.label.slice(2));
  if (!xf || xf.peer !== p.id) return ch.close();
  ch.binaryType = 'arraybuffer';
  xf.ch = ch;
  const chunks = [];
  const item = items.get(xf.id);
  let done = false;

  ch.onmessage = (e) => {
    if (typeof e.data === 'string') {
      if (e.data !== 'end') return;
      done = true;
      ch.close();
      const blob = new Blob(chunks, { type: item?.mime || '' });
      transfers.delete(xf.x);
      finishTransfer(xf, null, blob);
      return;
    }
    chunks.push(e.data);
    xf.received += e.data.byteLength;
    if (item?.size) setProgress(xf.id, xf.received / item.size);
  };
  ch.onclose = () => {
    if (!done && transfers.get(xf.x) === xf) tryNextHolder(xf);
  };
}

// Stops a download in progress. Closing the channel tells the sender too.
function cancelFetch(id) {
  const xf = fetching.get(id);
  if (!xf) return;
  transfers.delete(xf.x);
  xf.ch?.close();
  finishTransfer(xf, new Error('cancelled'));
}

function finishTransfer(xf, err, blob) {
  fetching.delete(xf.id);
  if (err) {
    xf.reject(err);
  } else {
    blobs.set(xf.id, blob);
    persist.putBlob(xf.id, blob);
    broadcast({ t: 'have', ids: [xf.id] });
    xf.resolve(blob);
  }
  setProgress(xf.id, null);
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---------- Items ----------

function addItem(it, local) {
  if (items.has(it.id) || tombstones.has(it.id)) return;
  items.set(it.id, it);
  persist.putItem(it);
  if (local) broadcast({ t: 'add', item: it, have: blobs.has(it.id) });
  renderCard(it, local);
  updateEmpty();
  if (it.kind === 'file' && PREVIEWABLE.has(it.mime) && it.size <= PREVIEW_LIMIT && !blobs.has(it.id)) {
    // Holders are announced right after the item, so give that a moment to arrive.
    setTimeout(() => fetchItem(it.id).then(() => showPreview(it.id)).catch(() => {}), 50);
  }
}

function removeItem(id, { broadcast: tell = false, tombstone = true } = {}) {
  if (tombstone) {
    tombstones.add(id);
    persist.saveMeta();
  }
  if (tell) broadcast({ t: 'del', ids: [id] });
  if (!items.has(id)) return;
  persist.remove(id);
  items.delete(id);
  blobs.delete(id);
  holders.delete(id);
  const card = cards.get(id);
  cards.delete(id);
  if (card) {
    if (card.dataset.url) URL.revokeObjectURL(card.dataset.url);
    card.classList.add('leaving');
    setTimeout(() => { card.remove(); updateEmpty(); }, reducedMotion.matches ? 0 : 200);
  }
}

function shareText(text) {
  if (!text.trim()) return;
  if (text.length > TEXT_LIMIT) {
    shareFiles([new File([text], 'Pasted text.txt', { type: 'text/plain' })]);
    return;
  }
  addItem({ id: randomHex(12), kind: 'text', text, by: me.id, byName: me.name, ts: Date.now() }, true);
}

function shareFiles(files) {
  for (const f of files) {
    const id = randomHex(12);
    blobs.set(id, f);
    persist.putBlob(id, f);
    addItem({
      id, kind: 'file', name: f.name || 'Pasted file', size: f.size, mime: f.type || '',
      by: me.id, byName: me.name, ts: Date.now(),
    }, true);
    if (PREVIEWABLE.has(f.type)) showPreview(id);
  }
}

// ---------- Rendering ----------

const cards = new Map(); // id -> card element
const cardList = $('#cards');

function authorLabel(it) {
  return it.by === me.id ? 'You' : (peers.get(it.by)?.name || it.byName || 'A device');
}

function renderCard(it, local) {
  const tpl = $(it.kind === 'text' ? '#tplText' : '#tplFile');
  const card = tpl.content.firstElementChild.cloneNode(true);
  card.dataset.id = it.id;
  card.style.setProperty('--peer', colorFor(it.by));
  card.querySelector('.who').textContent = authorLabel(it);
  const when = card.querySelector('.when');
  when.dateTime = new Date(it.ts).toISOString();
  when.dataset.ts = it.ts;
  when.textContent = timeAgo(it.ts);

  if (it.kind === 'text') {
    linkify(card.querySelector('.text-body'), it.text);
    if (it.text.length > 700 || it.text.split('\n').length > 10) card.classList.add('long', 'clamped');
  } else {
    const ext = (it.name.match(/\.([a-z0-9]{1,5})$/i)?.[1] || 'file').toUpperCase();
    card.querySelector('.file-ext').textContent = ext;
    card.querySelector('.file-name').textContent = it.name;
    card.querySelector('.file-name').title = it.name;
    card.querySelector('.file-size').textContent = formatSize(it.size);
    if (PREVIEWABLE.has(it.mime)) card.classList.add('is-image');
  }

  if (local) card.classList.add('fresh');
  card.addEventListener('animationend', () => card.classList.remove('fresh'), { once: true });
  cards.set(it.id, card);

  // Newest first.
  const firstOlder = [...cardList.children].find((el) => (items.get(el.dataset.id)?.ts ?? 0) < it.ts);
  cardList.insertBefore(card, firstOlder || null);
  refreshAvailability(it.id);
}

// Fills el with text, turning web addresses into links. Built from text nodes
// and anchors, so nothing pasted is ever parsed as HTML.
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;

function linkify(el, text) {
  const count = (s, ch) => s.split(ch).length - 1;
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let raw = m[0];
    // Leave sentence punctuation, and a closing paren with no opening one, outside the link.
    while (/[.,;:!?'\]]$/.test(raw) || (raw.endsWith(')') && count(raw, '(') < count(raw, ')'))) {
      raw = raw.slice(0, -1);
    }
    let href;
    try {
      href = new URL(/^www\./i.test(raw) ? `https://${raw}` : raw);
    } catch {
      continue;
    }
    if (href.protocol !== 'http:' && href.protocol !== 'https:') continue;
    el.append(text.slice(last, m.index));
    const a = document.createElement('a');
    a.href = href.href;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.textContent = raw;
    el.append(a);
    last = m.index + raw.length;
  }
  el.append(text.slice(last));
}

function showPreview(id) {
  const card = cards.get(id);
  const blob = blobs.get(id);
  if (!card || !blob || card.querySelector('.file-face img')) return;
  const url = URL.createObjectURL(blob);
  card.dataset.url = url;
  const img = new Image();
  img.alt = items.get(id)?.name || '';
  img.decoding = 'async';
  img.src = url;
  const face = card.querySelector('.file-face');
  img.onload = () => { face.replaceChildren(img); };
}

function setProgress(id, frac) {
  const card = cards.get(id);
  if (!card) return;
  const bar = card.querySelector('.progress');
  const btn = card.querySelector('.dl');
  if (!bar) return;
  if (frac === null) {
    bar.hidden = true;
    card.classList.remove('loading');
    btn.removeAttribute('aria-label');
    refreshAvailability(id);
    return;
  }
  const pct = `${Math.floor(frac * 100)}%`;
  bar.hidden = false;
  card.classList.add('loading');
  btn.disabled = false;
  card.querySelector('.dl-label').textContent = pct;
  // With a mouse the button itself cancels; touch screens get a separate cancel button.
  btn.setAttribute('aria-label', canHover.matches ? `${pct} downloaded, cancel download` : `${pct} downloaded`);
  bar.firstElementChild.style.setProperty('--p', frac);
}

// Marks file cards whose bytes no connected device can provide.
function refreshAvailability(onlyId) {
  const ids = onlyId ? [onlyId] : [...items.keys()];
  for (const id of ids) {
    const it = items.get(id);
    const card = cards.get(id);
    if (!it || !card || it.kind !== 'file' || fetching.has(id) || uploads.has(id)) continue;
    const btn = card.querySelector('.dl');
    const have = blobs.has(id);
    const reachable = [...(holders.get(id) || [])].some((pid) => isOpen(peers.get(pid)));
    const unavailable = !have && !reachable;
    card.classList.toggle('failed', unavailable);
    btn.disabled = unavailable;
    card.querySelector('.dl-label').textContent = have && it.by !== me.id ? 'Save' : 'Download';
    card.querySelector('.progress').hidden = true;
    const noted = card.dataset.note && Date.now() < +card.dataset.noteUntil;
    card.querySelector('.file-size').textContent =
      noted ? card.dataset.note :
      unavailable ? `${formatSize(it.size)}, connecting to sender` : formatSize(it.size);
  }
}

// This device's own pill stays put between renders so renaming isn't interrupted.
const selfPill = document.createElement('li');
selfPill.className = 'peer self';
selfPill.style.setProperty('--peer', colorFor(me.id));

function paintSelf() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'self-btn';
  btn.title = 'Rename this device';
  const name = document.createElement('span');
  name.className = 'self-name';
  name.textContent = me.name;
  const tag = document.createElement('span');
  tag.className = 'self-tag';
  tag.textContent = 'you';
  btn.append(name, tag);
  btn.addEventListener('click', startRename);
  selfPill.replaceChildren(btn);
}

function startRename() {
  const field = document.createElement('input');
  field.className = 'self-input';
  field.value = me.name;
  field.maxLength = 40;
  field.setAttribute('aria-label', 'Device name');
  field.size = Math.max(10, me.name.length);
  let done = false;
  // Enter saves, Escape cancels, and clicking away saves without moving focus back.
  const finish = (save) => {
    if (done) return;
    done = true;
    if (save !== false) setName(field.value);
    paintSelf();
    if (save !== null) selfPill.querySelector('button').focus();
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') finish(false);
  });
  field.addEventListener('input', () => { field.size = Math.max(10, field.value.length); });
  field.addEventListener('blur', () => finish(null));
  selfPill.replaceChildren(field);
  field.focus();
  field.select();
}

function setName(value) {
  const name = cleanName(value);
  if (!name || name === me.name) return;
  me.name = name;
  device.set(name);
  wsSend({ t: 'name', name });
  broadcast({ t: 'name', name });
}

function relabel(pid) {
  for (const [id, card] of cards) {
    const it = items.get(id);
    if (it?.by === pid) card.querySelector('.who').textContent = authorLabel(it);
  }
}

function renderPeers() {
  const list = $('#peers');
  if (selfPill.parentNode !== list) {
    paintSelf();
    list.prepend(selfPill);
  }
  while (list.lastChild !== selfPill) list.lastChild.remove();
  for (const p of peers.values()) {
    const li = document.createElement('li');
    const ready = isOpen(p);
    li.className = ready ? 'peer' : 'peer pending';
    li.style.setProperty('--peer', colorFor(p.id));
    li.textContent = ready ? p.name : `${p.name}, connecting`;
    list.append(li);
  }
  updateEmpty();
}

function updateEmpty() {
  const empty = $('#empty');
  if (items.size) {
    empty.textContent = '';
  } else if (peers.size) {
    empty.textContent = 'Nothing shared yet. Anything you add shows up on every device here.';
  } else {
    empty.textContent = 'No other devices yet. Scan the QR code or enter the digits on another device, and everything here appears there too.';
  }
}

setInterval(() => {
  for (const t of document.querySelectorAll('.when')) t.textContent = timeAgo(+t.dataset.ts);
}, 30_000);

cardList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const card = btn.closest('.card');
  const id = card.dataset.id;
  const it = items.get(id);
  if (!it) return;

  switch (btn.dataset.act) {
    case 'copy':
      copyText(it.text);
      break;
    case 'remove':
      removeItem(id, { broadcast: true });
      break;
    case 'more':
      card.classList.toggle('clamped');
      btn.textContent = card.classList.contains('clamped') ? 'Show all' : 'Show less';
      break;
    case 'cancel':
      cancelFetch(id);
      break;
    case 'download':
      if (fetching.has(id)) {
        if (canHover.matches) cancelFetch(id);
        break;
      }
      try {
        const blob = await fetchItem(id);
        saveBlob(blob, it.name);
        if (PREVIEWABLE.has(it.mime)) showPreview(id);
      } catch (err) {
        if (err.message !== 'cancelled') toast(err.message === 'removed' ? 'That file was removed.' : err.message);
      }
      break;
  }
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; fall back for plain-http LAN use.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

// ---------- Join code + QR ----------

let lastCode = '';

function shareOrigin() {
  if (state.origin) return state.origin;
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(location.hostname);
  if (local && state.lan.length) {
    return `${location.protocol}//${state.lan[0]}${location.port ? `:${location.port}` : ''}`;
  }
  return location.origin;
}

function setCode(code, left) {
  state.code = code;
  const digits = $('#codeDigits');
  digits.textContent = `${code.slice(0, 3)} ${code.slice(3)}`;
  if (lastCode && lastCode !== code && !reducedMotion.matches) {
    digits.classList.remove('swap');
    void digits.offsetWidth;
    digits.classList.add('swap');
  }
  lastCode = code;

  const bar = $('#codeBar');
  bar.style.animation = 'none';
  void bar.offsetWidth;
  bar.style.setProperty('--from', Math.min(1, left / state.ttl));
  bar.style.setProperty('--dur', `${left}ms`);
  bar.style.animation = `drain ${left}ms linear forwards`;

  const target = `${shareOrigin()}/#j=${code}`;
  const img = new Image();
  img.onload = () => { $('#qr').src = img.src; };
  img.src = `/qr.svg?d=${encodeURIComponent(target)}`;
}

// ---------- Landing → session ----------

function enterSession() {
  if (state.session && document.body.classList.contains('session')) return;
  state.session = true;
  store.set('session', '1');
  if (state.room) store.set('room', state.room);

  const swap = () => {
    document.body.classList.replace('landing', 'session');
    $('#inviteHint').textContent = 'Add another device';
    $('#codeNote').textContent = 'Changes every minute';
    updateEmpty();
  };
  if (document.startViewTransition && !reducedMotion.matches && document.visibilityState === 'visible') {
    document.startViewTransition(swap);
  } else {
    swap();
  }
}

let leaving = false;

window.addEventListener('beforeunload', (e) => {
  if (leaving || !servingFiles()) return;
  // Browsers show their own wording here.
  e.preventDefault();
  e.returnValue = '';
});

$('#leave').addEventListener('click', async () => {
  if (servingFiles() && !confirm('Some files are only on this device. If you leave, the others can no longer download them. Leave anyway?')) return;
  leaving = true;
  // Tells the others this isn't a refresh, so they don't wait for a return.
  broadcast({ t: 'bye' });
  store.del('room');
  store.del('session');
  await persist.clear();
  await new Promise((r) => setTimeout(r, 150));
  if (ws) { ws.onclose = null; ws.close(); }
  for (const p of peers.values()) p.pc.close();
  location.replace(location.pathname);
});

// ---------- Composer ----------

const input = $('#input');

input.addEventListener('input', () => {
  if (input.value.trim()) enterSession();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarsePointer.matches) {
    e.preventDefault();
    $('#composer').requestSubmit();
  }
});

$('#composer').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!input.value.trim()) return;
  enterSession();
  shareText(input.value);
  input.value = '';
  input.focus();
});

$('#files').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  enterSession();
  shareFiles(files);
});

// Pasting files anywhere shares them; pasting text outside an input shares it as a card.
document.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    enterSession();
    shareFiles(files);
    return;
  }
  if (e.target.closest?.('input, textarea')) return;
  const text = e.clipboardData?.getData('text/plain');
  if (text && text.trim()) {
    e.preventDefault();
    enterSession();
    shareText(text);
  }
});

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  document.body.classList.add('dragging');
});
document.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove('dragging');
  }
});
document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  enterSession();
  shareFiles(files);
});

// ---------- Join form ----------

const joinForm = $('#joinForm');
const joinInput = $('#joinInput');
const joinStatus = $('#joinStatus');
const cells = [...document.querySelectorAll('.otp-cells span')];

function paintCells() {
  const v = joinInput.value;
  cells.forEach((c, i) => {
    c.textContent = v[i] || '';
    c.classList.toggle('at', i === Math.min(v.length, 5));
  });
}

joinInput.addEventListener('input', () => {
  joinInput.value = joinInput.value.replace(/\D/g, '').slice(0, 6);
  joinForm.classList.remove('bad');
  joinStatus.classList.remove('bad');
  joinStatus.textContent = '';
  paintCells();
  if (joinInput.value.length === 6) sendJoin(joinInput.value);
});
joinInput.addEventListener('focus', paintCells);
joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (joinInput.value.length === 6) sendJoin(joinInput.value);
});

function sendJoin(code) {
  state.pendingJoin = code;
  joinForm.classList.add('busy');
  joinStatus.textContent = 'Joining…';
  wsSend({ t: 'join', code });
}

function joinDone() {
  joinForm.classList.remove('busy');
  joinStatus.textContent = '';
  joinInput.value = '';
  paintCells();
}

function joinFailed(msg) {
  joinForm.classList.remove('busy');
  joinForm.classList.remove('bad');
  void joinForm.offsetWidth;
  joinForm.classList.add('bad');
  joinStatus.classList.add('bad');
  joinStatus.textContent = msg;
  joinInput.value = '';
  paintCells();
  if (!state.session) joinInput.focus();
  else toast(msg);
}

// ---------- Boot ----------

// QR codes link to /#j=123456, which joins straight away.
function joinFromHash() {
  const code = location.hash.match(/^#j=(\d{6})$/)?.[1];
  if (!code) return null;
  history.replaceState(null, '', location.pathname + location.search);
  joinInput.value = code;
  paintCells();
  if (ws && ws.readyState === WebSocket.OPEN) sendJoin(code);
  else {
    state.pendingJoin = code;
    joinForm.classList.add('busy');
    joinStatus.textContent = 'Joining…';
  }
  return code;
}
window.addEventListener('hashchange', joinFromHash);
const hashCode = joinFromHash();

if (state.session) {
  document.body.classList.replace('landing', 'session');
  $('#inviteHint').textContent = 'Add another device';
  $('#codeNote').textContent = 'Changes every minute';
}
if (!coarsePointer.matches && !hashCode) input.focus({ preventScroll: true });

// Puts back what this tab had before a refresh.
async function restore() {
  const saved = await persist.load();
  if (!saved) return;
  for (const id of saved.tombstones) tombstones.add(id);
  for (const it of saved.items.sort((a, b) => a.ts - b.ts)) {
    const blob = saved.blobs.get(it.id);
    // Files that were never downloaded here come back from the others, if anyone has them.
    if (!validItem(it) || (it.kind === 'file' && !blob)) {
      persist.remove(it.id);
      continue;
    }
    if (blob) blobs.set(it.id, blob);
    addItem(it, false);
    if (blob && PREVIEWABLE.has(it.mime)) showPreview(it.id);
  }
}

async function boot() {
  renderPeers();
  if (state.session) await restore();
  else await persist.clear();
  persist.saveMeta();
  setInterval(() => persist.saveMeta(), 5 * 60_000);
  persist.sweep();
  connect();
}
boot();
