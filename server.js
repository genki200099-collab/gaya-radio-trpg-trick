
const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.join(PUBLIC_DIR, urlPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    const types = {'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.jpg':'image/jpeg','.svg':'image/svg+xml'};
    res.writeHead(200, {'Content-Type': types[ext] || 'application/octet-stream'});
    res.end(data);
  });
});

const wss = new WebSocket.Server({ server });
const rooms = {};
const SUITS = [
  {key:'H',mark:'♥',label:'赤'},
  {key:'S',mark:'♠',label:'青'},
  {key:'D',mark:'♦',label:'黄'},
  {key:'C',mark:'♣',label:'緑'}
];

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  if (rooms[code]) return makeRoomCode();
  return code;
}
function send(ws, type, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type, data}));
}
function broadcast(room) {
  for (const c of room.clients) sendView(c, room);
}
function sendView(client, room) {
  send(client.ws, 'state', buildView(room, client.seat));
}
function safeName(s) {
  s = String(s || '').trim();
  return s.slice(0, 16) || 'プレイヤー';
}
function makeToken() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (let r = 1; r <= 9; r++) deck.push({id:s.key + r + '_' + Math.random().toString(36).slice(2,8), suit:s.key, rank:r});
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = deck[i]; deck[i] = deck[j]; deck[j] = t;
  }
  return deck;
}
function roleFor(seat, round) {
  const roles = ['きくぞう役','ペグ役','なかとー役','ヤマ役'];
  return roles[(seat - round + 400) % 4];
}
function leadSeat(round) {
  for (let i = 0; i < 4; i++) if (roleFor(i, round) === 'きくぞう役') return i;
  return 0;
}
function orderFrom(start) {
  const a = [];
  for (let i = 0; i < 4; i++) a.push((start + i) % 4);
  return a;
}
function suitLabel(k) {
  for (const s of SUITS) if (s.key === k) return s;
  return {key:k,mark:'?',label:k};
}
function sortHand(hand) {
  const order = {H:0,S:1,D:2,C:3};
  hand.sort((a,b) => order[a.suit] !== order[b.suit] ? order[a.suit] - order[b.suit] : a.rank - b.rank);
}
function newGame(room) {
  const deck = makeDeck();
  room.game = {
    phase:'playing',
    round:0,
    turn:0,
    deck,
    trick:[],
    lastDraw:[],
    log:[],
    results:[],
    players: room.players.map(p => ({
      name: p.name,
      isCpu: !!p.isCpu,
      score:0,
      tricks:0,
      hand:[]
    })),
    pending:null,
    comments:[],
    winnerSeats:null
  };
  deal(room);
  addLog(room, 'ゲーム開始');
}
function deal(room) {
  const g = room.game;
  for (const p of g.players) { p.hand = []; p.tricks = 0; }
  g.trick = []; g.lastDraw = []; g.turn = 0; g.pending = null; g.phase = 'playing';
  for (let n = 0; n < 5; n++) for (let i = 0; i < 4; i++) g.players[i].hand.push(g.deck.pop());
  for (const p of g.players) sortHand(p.hand);
  addLog(room, '第' + (g.round + 1) + 'R 開始');
}
function addLog(room, msg) {
  const g = room.game;
  if (!g) return;
  g.log.unshift(msg);
  if (g.log.length > 40) g.log.length = 40;
}
function currentSeat(g) {
  const o = orderFrom(leadSeat(g.round));
  return o[g.turn % 4];
}
function currentWinner(g) {
  if (g.trick.length === 0) return null;
  const lead = g.trick[0].card.suit;
  let win = g.trick[0];
  for (const t of g.trick) {
    if (t.card.suit === lead && t.card.rank > win.card.rank) win = t;
  }
  return win;
}
function playCard(room, client, cardId, cpuMode) {
  const g = room.game;
  if (!g || g.phase !== 'playing') { if(!cpuMode) send(client.ws, 'errorMsg', '今はカードを出せません'); return; }
  if (currentSeat(g) !== client.seat) { if(!cpuMode) send(client.ws, 'errorMsg', 'あなたの手番ではありません'); return; }
  const p = g.players[client.seat];
  const idx = p.hand.findIndex(c => c.id === cardId);
  if (idx < 0) { if(!cpuMode) send(client.ws, 'errorMsg', 'そのカードはありません'); return; }
  const card = p.hand.splice(idx, 1)[0];
  g.lastDraw = g.lastDraw.filter(d => d.seat !== client.seat);
  g.trick.push({seat:client.seat, card});
  pushComment(room, client.seat, 'play', card);
  addLog(room, p.name + 'さん：' + card.rank + suitLabel(card.suit).mark);
  g.turn++;
  if (g.trick.length === 4) startPause(room);
  broadcast(room);
  maybeCpu(room);
}
function startPause(room) {
  const g = room.game;
  const w = currentWinner(g);
  if (!w) return;
  g.phase = 'trickPause';
  g.pending = {winner:w.seat, until:Date.now()+5000};
  addLog(room, '獲得確認：' + g.players[w.seat].name + 'さん');
  if (room.timer) clearTimeout(room.timer);
  room.timer = setTimeout(() => {
    finishPause(room);
  }, 5000);
}
function finishPause(room) {
  const g = room.game;
  if (!g || g.phase !== 'trickPause') return;
  const w = currentWinner(g);
  if (!w) return;
  g.players[w.seat].tricks++;
  pushComment(room, w.seat, 'win', null);
  addLog(room, '獲得確定：' + g.players[w.seat].name + 'さん');
  g.trick = [];
  g.pending = null;
  if (allHandsEmpty(g)) {
    endRound(room);
  } else {
    drawAfter(room);
    g.turn = 0;
    g.phase = 'playing';
  }
  broadcast(room);
  maybeCpu(room);
}
function allHandsEmpty(g) {
  for (const p of g.players) if (p.hand.length) return false;
  return true;
}
function drawAfter(room) {
  const g = room.game;
  g.lastDraw = [];
  if (!g.deck.length) return;
  const o = orderFrom(leadSeat(g.round));
  for (const seat of o) {
    if (g.deck.length) {
      const c = g.deck.pop();
      g.players[seat].hand.push(c);
      sortHand(g.players[seat].hand);
      g.lastDraw.push({seat, cardId:c.id});
      pushComment(room, seat, 'draw', c);
    }
  }
  addLog(room, '補充：山札 ' + g.deck.length + '枚');
}
function endRound(room) {
  const g = room.game;
  const max = Math.max(...g.players.map(p => p.tricks));
  const maxSeats = [];
  for (let i = 0; i < 4; i++) if (g.players[i].tricks === max) maxSeats.push(i);
  const gm = leadSeat(g.round);
  const gained = [0,0,0,0];
  let desc = '';
  if (maxSeats.length === 1 && maxSeats[0] === gm) {
    gained[gm] = 3; desc = 'きくぞう役が単独最多。';
  } else if (maxSeats.indexOf(gm) >= 0) {
    desc = 'きくぞう役を含む同点。得点なし。';
  } else {
    for (let i = 0; i < 4; i++) if (i !== gm) gained[i] = 1;
    for (const s of maxSeats) gained[s] += 1;
    desc = 'プレイヤー側が最多。';
  }
  for (let i = 0; i < 4; i++) g.players[i].score += gained[i];
  g.results.push({round:g.round+1, desc, tricks:g.players.map(p=>p.tricks), gained});
  addLog(room, '第' + (g.round+1) + 'R 終了');
  g.phase = 'roundEnd';
}
function nextRound(room) {
  const g = room.game;
  if (!g || g.phase !== 'roundEnd') return;
  if (g.round >= 3) {
    finishGame(room);
    return;
  }
  g.round++;
  g.deck = makeDeck();
  deal(room);
  broadcast(room);
  maybeCpu(room);
}
function finishGame(room) {
  const g = room.game;
  const max = Math.max(...g.players.map(p => p.score));
  g.winnerSeats = [];
  for (let i = 0; i < 4; i++) if (g.players[i].score === max) g.winnerSeats.push(i);
  g.phase = 'gameEnd';
  addLog(room, 'ゲーム終了');
}
function buildView(room, seat) {
  const g = room.game;
  return {
    roomCode: room.code,
    seat,
    token: room.players[seat] ? room.players[seat].token : '',
    players: room.players.map((p,i) => ({
      name:p.name,
      connected: !!p.connected,
      joined: !!p.joined,
      isCpu: !!p.isCpu,
      seat:i
    })),
    hostSeat: room.hostSeat,
    game: g ? {
      phase:g.phase,
      round:g.round,
      deckCount:g.deck.length,
      trick:g.trick,
      pending:g.pending,
      lastDraw:g.lastDraw.filter(d => d.seat === seat),
      comments:(g.comments || []).slice(0,4),
      log:g.log.slice(0, 18),
      results:g.results,
      winnerSeats:g.winnerSeats,
      players:g.players.map((p,i) => ({
        name:p.name,
        score:p.score,
        tricks:p.tricks,
        handCount:p.hand.length,
        hand: i === seat ? p.hand : [],
        isCpu: !!p.isCpu,
        role: roleFor(i, g.round)
      })),
      currentSeat: g.phase === 'playing' ? currentSeat(g) : null,
      leadSeat: leadSeat(g.round)
    } : null
  };
}
function handleMessage(client, msg) {
  let data;
  try { data = JSON.parse(msg); } catch(e) { return; }
  if (!data || !data.type) return;
  const payload = data.data || {};
  if (data.type === 'create') {
    const code = makeRoomCode();
    const room = {
      code,
      players:[0,1,2,3].map(i => ({name:'', joined:false, connected:false, token:'', isCpu:false})),
      clients:[],
      hostSeat:0,
      game:null,
      timer:null
    };
    rooms[code] = room;
    joinRoom(client, code, 0, payload.name);
  }
  if (data.type === 'join') joinRoom(client, String(payload.room || '').trim().toUpperCase(), payload.seat, payload.name, payload.token);
  if (data.type === 'reconnect') reconnectRoom(client, String(payload.room || '').trim().toUpperCase(), payload.seat, payload.token);
  if (data.type === 'addCpu') {
    const room = client.room;
    if (!room || client.seat !== room.hostSeat || room.game) return;
    addCpu(room, Number(payload.seat));
    broadcast(room);
  }
  if (data.type === 'fillCpu') {
    const room = client.room;
    if (!room || client.seat !== room.hostSeat || room.game) return;
    fillCpu(room);
    broadcast(room);
  }
  if (data.type === 'removeCpu') {
    const room = client.room;
    if (!room || client.seat !== room.hostSeat || room.game) return;
    removeCpu(room, Number(payload.seat));
    broadcast(room);
  }
  if (data.type === 'start') {
    const room = client.room;
    if (!room || client.seat !== room.hostSeat) return;
    for (let i = 0; i < 4; i++) if (!room.players[i].joined) return send(client.ws, 'errorMsg', '空席はCPUで開始できます');
    newGame(room); broadcast(room); maybeCpu(room);
  }
  if (data.type === 'play') playCard(client.room, client, payload.cardId);
  if (data.type === 'nextRound') {
    if (client.room && client.room.game && client.room.game.phase === 'roundEnd') { nextRound(client.room); broadcast(client.room); }
  }
  if (data.type === 'again') {
    if (client.room) { client.room.game = null; broadcast(client.room); }
  }
}


function commentRoleKeyBySeat(room, seat) {
  if (!room || !room.game) return 'k';
  const role = roleFor(seat, room.game.round);
  if (role === 'きくぞう役') return 'k';
  if (role === 'ペグ役') return 'p';
  if (role === 'なかとー役') return 'n';
  return 'y';
}
function commentText(room, seat, kind, card) {
  const key = commentRoleKeyBySeat(room, seat);
  const n = room.game.players[seat].name;
  const cardTxt = card ? (card.rank + suitLabel(card.suit).mark) : '';
  if (key === 'k') {
    if (kind === 'play') return 'GM進行です。' + cardTxt + 'で場を整えます。';
    if (kind === 'win') return 'はい、このトリックは回収します。';
    if (kind === 'draw') return '補充入りました。次の展開を見ましょう。';
    return 'ルールに沿って進めます。';
  }
  if (key === 'p') {
    if (kind === 'play') return 'ここで' + cardTxt + '！盛り上がってきた！';
    if (kind === 'win') return 'よし、取った！これはデカい！';
    if (kind === 'draw') return '補充きた！まだ全然いける！';
    return 'いいですねぇ、場が動いてます。';
  }
  if (key === 'n') {
    if (kind === 'play') return cardTxt + '。美しく置きます。';
    if (kind === 'win') return 'きれいに決まりましたね。';
    if (kind === 'draw') return '手札が整いました。';
    return 'この流れ、悪くないです。';
  }
  if (kind === 'play') return 'ちょっと、' + cardTxt + 'でいいですか……？';
  if (kind === 'win') return '……取れましたね。';
  if (kind === 'draw') return '補充確認しました。';
  return '少し整理しましょう。';
}
function pushComment(room, seat, kind, card) {
  if (!room || !room.game || !isCpuSeat(room, seat)) return;
  const g = room.game;
  if (!g.comments) g.comments = [];
  g.comments.unshift({
    seat: seat,
    roleKey: commentRoleKeyBySeat(room, seat),
    text: commentText(room, seat, kind, card),
    at: Date.now()
  });
  if (g.comments.length > 4) g.comments.length = 4;
}

function cpuName(seat) {
  const names = ['CPUきくぞう','CPUペグ','CPUなかとー','CPUヤマ'];
  return names[seat] || ('CPU' + (seat+1));
}
function addCpu(room, seat) {
  if (seat < 0 || seat > 3) return;
  const p = room.players[seat];
  if (!p || p.connected || (p.joined && !p.isCpu)) return;
  p.name = cpuName(seat);
  p.joined = true;
  p.connected = false;
  p.isCpu = true;
  p.token = '';
}
function removeCpu(room, seat) {
  if (seat < 0 || seat > 3) return;
  const p = room.players[seat];
  if (!p || !p.isCpu) return;
  p.name = '';
  p.joined = false;
  p.connected = false;
  p.isCpu = false;
  p.token = '';
}
function fillCpu(room) {
  for (let i = 0; i < 4; i++) {
    if (!room.players[i].joined && !room.players[i].connected) addCpu(room, i);
  }
}
function isCpuSeat(room, seat) {
  return !!(room && room.players && room.players[seat] && room.players[seat].isCpu);
}
function cpuChooseCard(g, seat) {
  const hand = g.players[seat].hand;
  if (!hand.length) return null;
  if (!g.trick.length) {
    let best = 0;
    for (let i = 1; i < hand.length; i++) if (hand[i].rank < hand[best].rank) best = i;
    return hand[best].id;
  }
  const lead = g.trick[0].card.suit;
  const same = [];
  for (let i = 0; i < hand.length; i++) if (hand[i].suit === lead) same.push(hand[i]);
  if (same.length) {
    let best = same[0];
    for (let i = 1; i < same.length; i++) if (same[i].rank < best.rank) best = same[i];
    return best.id;
  }
  let low = hand[0];
  for (let i = 1; i < hand.length; i++) if (hand[i].rank < low.rank) low = hand[i];
  return low.id;
}
function maybeCpu(room) {
  if (!room || !room.game || room.game.phase !== 'playing') return;
  const seat = currentSeat(room.game);
  if (!isCpuSeat(room, seat)) return;
  if (room.cpuTimer) clearTimeout(room.cpuTimer);
  room.cpuTimer = setTimeout(() => {
    if (!room.game || room.game.phase !== 'playing') return;
    const nowSeat = currentSeat(room.game);
    if (!isCpuSeat(room, nowSeat)) return;
    const cardId = cpuChooseCard(room.game, nowSeat);
    if (!cardId) return;
    playCpuCard(room, nowSeat, cardId);
  }, 900);
}
function playCpuCard(room, seat, cardId) {
  const fakeClient = {room: room, seat: seat, ws: null};
  playCard(room, fakeClient, cardId, true);
}

function joinRoom(client, code, seat, name, token) {
  const room = rooms[code];
  if (!room) return send(client.ws, 'errorMsg', '部屋が見つかりません');
  seat = Number(seat);
  if (seat < 0 || seat > 3 || !Number.isFinite(seat)) seat = firstOpenSeat(room);

  if (seat >= 0 && seat <= 3) {
    const requested = room.players[seat];
    const ownReservation = requested && requested.joined && requested.token && token === requested.token && !requested.isCpu;
    if ((requested.isCpu || requested.connected || (requested.joined && requested.token && token !== requested.token)) && !ownReservation) {
      const alt = firstOpenSeat(room);
      if (alt >= 0) seat = alt;
    }
  }

  if (seat < 0) return send(client.ws, 'errorMsg', '満席です。空席がない場合はホストにCPU解除を依頼してください');
  if (room.players[seat].isCpu) return send(client.ws, 'errorMsg', 'その席はCPUが使用中です。ホストにCPU解除を依頼してください');
  if (room.players[seat].connected) return send(client.ws, 'errorMsg', 'その席は使用中です');
  if (room.players[seat].joined && room.players[seat].token && token !== room.players[seat].token) return send(client.ws, 'errorMsg', 'その席は予約済みです。再接続してください');
  client.room = room;
  client.seat = seat;
  room.clients = room.clients.filter(c => c !== client);
  room.clients.push(client);
  room.players[seat].name = safeName(name) || room.players[seat].name || ('P' + (seat+1));
  room.players[seat].joined = true;
  room.players[seat].connected = true;
  room.players[seat].isCpu = false;
  if (!room.players[seat].token) room.players[seat].token = makeToken();
  broadcast(room);
}
function reconnectRoom(client, code, seat, token) {
  const room = rooms[code];
  if (!room) return send(client.ws, 'errorMsg', '再接続先の部屋が見つかりません');
  seat = Number(seat);
  if (seat < 0 || seat > 3 || !Number.isFinite(seat)) return send(client.ws, 'errorMsg', '再接続情報が不正です');
  const p = room.players[seat];
  if (!p || !p.joined || !p.token || p.token !== token) return send(client.ws, 'errorMsg', '再接続できません。入り直してください');
  if (p.connected) {
    const oldClients = room.clients.filter(c => c.seat === seat);
    for (const oc of oldClients) {
      try { if (oc.ws && oc.ws.readyState === WebSocket.OPEN) oc.ws.close(); } catch(e) {}
    }
    room.clients = room.clients.filter(c => c.seat !== seat);
  }
  client.room = room;
  client.seat = seat;
  room.clients = room.clients.filter(c => c !== client);
  room.clients.push(client);
  p.connected = true;
  broadcast(room);
  maybeCpu(room);
}
function firstOpenSeat(room) {
  for (let i = 0; i < 4; i++) if (!room.players[i].connected && !room.players[i].joined && !room.players[i].isCpu) return i;
  return -1;
}
function leave(client) {
  const room = client.room;
  if (!room) return;
  if (!room.players[client.seat].isCpu) room.players[client.seat].connected = false;
  room.clients = room.clients.filter(c => c !== client);
  broadcast(room);
  if (room.clients.length === 0) {
    if (room.timer) clearTimeout(room.timer);
    if (room.cpuTimer) clearTimeout(room.cpuTimer);
    delete rooms[room.code];
  }
}

wss.on('connection', (ws) => {
  const client = {ws, room:null, seat:null};
  ws.on('message', msg => handleMessage(client, msg.toString()));
  ws.on('close', () => leave(client));
  send(ws, 'hello', {ok:true});
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('GAYA online server listening on ' + PORT);
});
