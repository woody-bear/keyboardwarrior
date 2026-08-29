const os = require('os');
const net = require('net');
const path = require('path');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const game = require('./game');
const keywords = require('./keywords');
const { ensureCert } = require('./cert');

const PORT = Number(process.env.PORT) || 3000;
// Cloudflare Tunnel 등 외부 도메인으로 노출할 때 사용한다.
const PUBLIC_URL = process.env.PUBLIC_URL || '';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

/*
 * 같은 포트로 HTTP와 HTTPS를 모두 받는다.
 * Brave처럼 http:// 를 https:// 로 자동 승격하는 브라우저가 있어서,
 * 평문만 열어두면 QR로 들어온 참가자가 ERR_SSL_PROTOCOL_ERROR를 만난다.
 */
const httpServer = http.createServer(app);
const io = new Server({ cors: { origin: '*' } });
io.attach(httpServer);

/** TLS 핸드셰이크는 0x16으로 시작한다. 첫 바이트를 보고 알맞은 서버로 넘긴다. */
function createMultiplexer(httpsServer) {
  return net.createServer((socket) => {
    socket.once('error', () => socket.destroy());
    socket.once('data', (chunk) => {
      socket.pause();
      socket.unshift(chunk);
      (chunk[0] === 0x16 ? httpsServer : httpServer).emit('connection', socket);
      process.nextTick(() => socket.resume());
    });
  });
}

/** 같은 네트워크의 휴대폰이 접속할 수 있는 LAN IP를 찾는다. */
function lanAddress() {
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net_ of iface || []) {
      if (net_.family === 'IPv4' && !net_.internal) return net_.address;
    }
  }
  return 'localhost';
}

const lanUrl = `https://${lanAddress()}:${PORT}`;
let joinUrl = PUBLIC_URL || lanUrl;
let qrDataUrl = '';

const QR_STYLE = { width: 320, margin: 1 };

// QR은 공용 링크 하나만 만든다. 팀은 접속 후 화면에서 직접 고른다.
async function setJoinUrl(url) {
  joinUrl = url;
  qrDataUrl = await QRCode.toDataURL(url, { ...QR_STYLE, color: { dark: '#0b1020', light: '#ffffff' } });
  io.emit('session', { joinUrl, qrDataUrl });
}

app.get('/api/session', (req, res) => {
  res.json({ joinUrl, qrDataUrl, lanUrl });
});

/** 터널 스크립트가 공개 주소를 알려주면 QR을 즉시 교체한다. (로컬에서만 허용) */
app.post('/api/public-url', async (req, res) => {
  const remote = req.socket.remoteAddress || '';
  if (!remote.includes('127.0.0.1') && !remote.includes('::1')) {
    return res.status(403).json({ error: 'local only' });
  }

  const url = String(req.body?.url || '').trim();
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: 'invalid url' });

  await setJoinUrl(url);
  console.log(`  ▸ 참여 링크가 갱신되었습니다: ${url}`);
  return res.json({ ok: true, joinUrl });
});

app.get('/healthz', (req, res) => res.json({ ok: true, players: game.state.players.size }));

/* ------------------------------ 단어 테마 ------------------------------ */

app.get('/keyword', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'keyword.html')));

const keywordReply = (res, result) => (result.ok ? res.json(result) : res.status(400).json(result));

app.get('/api/keywords', (req, res) => res.json(keywords.list()));

app.post('/api/keywords', (req, res) => {
  keywordReply(res, keywords.createTheme(req.body?.name, req.body?.words));
});

app.post('/api/keywords/words', (req, res) => {
  keywordReply(res, keywords.addWords(req.body?.theme, req.body?.words));
});

app.post('/api/keywords/remove-word', (req, res) => {
  keywordReply(res, keywords.removeWord(req.body?.theme, req.body?.word));
});

app.post('/api/keywords/delete', (req, res) => {
  keywordReply(res, keywords.deleteTheme(req.body?.theme));
});

app.post('/api/keywords/active', (req, res) => {
  const result = keywords.setActive(req.body?.theme || null);
  if (result.ok) io.emit('toast', `단어 테마: ${result.active || '기본'}`);
  keywordReply(res, result);
});

app.post('/api/keywords/settings', (req, res) => {
  const result = keywords.setSettings(req.body || {});
  if (result.ok) {
    const pct = (v) => `${Math.round(v * 100)}%`;
    const s = result.settings;
    const min = Math.floor(s.roundSec / 60);
    const sec = s.roundSec % 60;
    const time = `${min}분${sec ? ` ${sec}초` : ''}`;
    io.emit('toast', `게임 설정 — 단어 양 ${pct(s.amount)} · 속도 ${pct(s.speed)} · 시간 ${time}`);
  }
  keywordReply(res, result);
});

// TV 관전 화면 — 구형 TV 브라우저(webOS 등)에서도 열리도록 보수적인 문법으로 만든 페이지
app.get('/tv', (req, res) => {
  // TV 브라우저가 화면이 깨질 때 엔진 버전을 알아내기 위한 기록
  console.log(`  ▸ /tv 접속: ${req.headers['user-agent'] || '(UA 없음)'}`);
  res.sendFile(path.join(__dirname, '..', 'public', 'tv.html'));
});

/* --------------------------------- 소켓 --------------------------------- */

// roster는 매 이벤트마다 보내면 낭비라 최대 5Hz로 묶어서 내보낸다.
let rosterDirty = false;
setInterval(() => {
  if (!rosterDirty) return;
  rosterDirty = false;
  io.emit('roster', game.roster());
}, 200);

const markRoster = () => { rosterDirty = true; };

/** 현재 접속자들의 프로필 사진 모음. 새로 들어온 화면에 한 번에 보내준다. */
function allPhotos() {
  const photos = {};
  for (const [id, p] of game.state.players) {
    if (p.photo) photos[id] = p.photo;
  }
  return photos;
}

io.on('connection', (socket) => {
  // TV 관전 모드 — 플레이어로 등록하지 않고 게임 상태만 받아본다.
  if (socket.handshake.auth?.spectate || socket.handshake.query?.spectate) {
    socket.emit('welcome', {
      me: null,
      joinUrl,
      qrDataUrl,
      photos: allPhotos(),
      state: game.snapshot(),
      lastResult: game.state.phase === 'over' ? game.state.lastResult : null,
    });
    socket.emit('roster', game.roster());
    return;
  }

  // ?team=red 로 들어오면 그 팀으로, 아니면 인원이 적은 팀으로 자동 배정한다.
  const wanted = socket.handshake.auth?.team || socket.handshake.query?.team;
  const player = game.addPlayer(socket.id, wanted);

  // 라운드가 끝난 사이에 들어온 사람도 직전 결과를 볼 수 있어야 한다.
  socket.emit('welcome', {
    me: player,
    joinUrl,
    qrDataUrl,
    photos: allPhotos(),
    state: game.snapshot(),
    lastResult: game.state.phase === 'over' ? game.state.lastResult : null,
  });
  socket.emit('roster', game.roster());
  markRoster();

  socket.on('submit', (text, method) => {
    const result = game.submitWord(socket.id, text, method === 'touch' ? 'touch' : 'type');

    if (result.ok && result.echo) {
      // 이미 파괴된 단어를 한 발 늦게 친 경우 — 점수 없이 타격 연출만 모두에게 보여준다.
      io.emit('word:hit', {
        id: 0,
        text: result.text,
        x: result.x,
        y: result.y,
        by: result.player.nick,
        playerId: result.player.id,
        team: result.player.team,
        gain: 0,
        combo: 0,
        bonus: false,
        echo: true,
      });
      return;
    }

    if (result.ok) {
      io.emit('word:hit', {
        id: result.word.id,
        text: result.word.text,
        x: result.word.x,
        y: result.word.y,
        by: result.player.nick,
        playerId: result.player.id,
        team: result.player.team,
        gain: result.gain,
        combo: result.combo,
        bonus: !!result.word.bonus,
      });
      socket.emit('me:update', {
        score: result.player.score,
        combo: result.combo,
        ...result.stats,
      });
      markRoster();
    } else {
      socket.emit('word:miss', {
        text: result.text || '',
        reason: result.reason,
        ...(result.stats || {}),
      });
    }
  });

  socket.on('rename', (nick) => {
    const updated = game.renamePlayer(socket.id, nick);
    if (updated) {
      socket.emit('me:profile', { me: updated });
      markRoster();
    }
  });

  socket.on('team:switch', () => {
    const updated = game.switchTeam(socket.id);
    if (updated) {
      socket.emit('me:profile', { me: updated });
      markRoster();
    }
  });

  // 접속 직후 팀 선택 화면에서 고른 팀으로 배정한다.
  socket.on('team:set', (team) => {
    const updated = game.setTeam(socket.id, team);
    if (updated) {
      socket.emit('me:profile', { me: updated });
      markRoster();
    }
  });

  socket.on('round:restart', () => {
    if (game.restartRound()) io.emit('toast', '라운드를 다시 시작했습니다');
  });

  // PC 화면에서 단어를 직접 추가해 떨어뜨린다.
  socket.on('word:custom', (text) => {
    const result = game.queueCustomWord(text);
    if (result.ok) io.emit('toast', `단어 추가: "${result.text}"`);
  });

  // 셀카 프로필 — 작게 리사이즈된 dataURL만 받는다.
  socket.on('profile:photo', (dataUrl) => {
    const player = game.state.players.get(socket.id);
    if (!player) return;
    const photo = String(dataUrl || '');
    if (!/^data:image\/(jpeg|png|webp);base64,/.test(photo) || photo.length > 60000) return;
    player.photo = photo;
    io.emit('profile:photo', { id: socket.id, photo });
    markRoster();
  });

  socket.on('disconnect', () => {
    game.removePlayer(socket.id);
    markRoster();
  });
});

game.attach(io);

async function main() {
  let server;

  try {
    const httpsServer = https.createServer(await ensureCert(), app);
    io.attach(httpsServer);
    server = createMultiplexer(httpsServer);
  } catch (err) {
    // 인증서를 못 만들어도 게임은 평문 HTTP로 계속 돌아가야 한다.
    console.error('HTTPS 준비 실패, HTTP로만 동작합니다:', err.message);
    joinUrl = PUBLIC_URL || `http://${lanAddress()}:${PORT}`;
    server = httpServer;
  }

  await setJoinUrl(joinUrl).catch((err) => console.error('QR 생성 실패:', err.message));

  server.listen(PORT, '0.0.0.0', () => {
    console.log('');
    console.log('  ⌨️  Team Drop Words 실행 중');
    console.log(`  ▸ 이 PC:      http://localhost:${PORT}`);
    console.log(`  ▸ 참여 링크:  ${joinUrl}`);
    if (!PUBLIC_URL) {
      console.log('');
      console.log('    LAN 접속은 자체 서명 인증서라 첫 화면에 보안 경고가 뜹니다.');
      console.log('    경고 없이 공유하려면:  npm run tunnel');
    }
    console.log('');
  });
}

main();
