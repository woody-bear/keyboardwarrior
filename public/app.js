/* Team Drop Words — 클라이언트는 렌더링과 입력 전송만 담당한다. */

// ?team=red / ?team=blue 로 들어오면 그 팀으로 배정해 달라고 서버에 알린다.
const params = new URLSearchParams(location.search);
const requestedTeam = ['red', 'blue'].includes(params.get('team')) ? params.get('team') : null;

const socket = io({
  transports: ['websocket', 'polling'],
  auth: requestedTeam ? { team: requestedTeam } : {},
});

const $ = (id) => document.getElementById(id);
const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const input = $('input');

const TEAM_COLOR = { red: '#ff4d6d', blue: '#4d9dff' };
const TEAM_LABEL = { red: 'RED', blue: 'BLUE' };

/* ------------------------------- 효과음 ------------------------------- */

/*
 * 오디오 파일 없이 Web Audio로 합성한 짧은 타격음 5종.
 * 단어 파괴에 성공할 때마다 랜덤으로 하나가 재생된다.
 */
const sound = (() => {
  let actx = null;
  let lastAt = 0;
  let unlocked = false;

  // iOS 무음 스위치가 켜져 있어도 게임 소리는 나게 한다 (iOS 17+ Safari).
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch { /* 미지원 브라우저 */ }

  const ensure = () => {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!actx) actx = new AC();
    if (actx.state !== 'running') actx.resume();
    return actx;
  };

  /*
   * iOS는 사용자 제스처 "안에서" 소리를 한 번 실제로 재생해야
   * 이후의 모든 소리가 풀린다. 무음 버퍼를 제스처 시점에 재생해 둔다.
   */
  const unlock = () => {
    const ctx = ensure();
    if (!ctx) return;
    if (!unlocked) {
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, 22050);
        src.connect(ctx.destination);
        src.start(0);
        unlocked = true;
      } catch { /* 이미 풀렸거나 미지원 */ }
    }
  };

  // touchend가 iOS에서 가장 확실한 잠금 해제 지점이다.
  for (const ev of ['touchend', 'pointerdown', 'keydown', 'click']) {
    window.addEventListener(ev, unlock, { passive: true });
  }

  const tone = (ctx, { type = 'sine', from = 600, to = 200, dur = 0.12, delay = 0, vol = 0.18 }) => {
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(to, 1), t0 + dur);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  };

  const VARIANTS = [
    (ctx) => tone(ctx, { type: 'sine', from: 700, to: 220, dur: 0.12 }),                       // 뽁
    (ctx) => {                                                                                  // 딩동
      tone(ctx, { type: 'triangle', from: 880, to: 870, dur: 0.16, vol: 0.15 });
      tone(ctx, { type: 'triangle', from: 1320, to: 1310, dur: 0.2, delay: 0.05, vol: 0.1 });
    },
    (ctx) => tone(ctx, { type: 'sawtooth', from: 1300, to: 90, dur: 0.13, vol: 0.1 }),         // 지잉
    (ctx) => {                                                                                  // 도-솔
      tone(ctx, { type: 'square', from: 523, to: 520, dur: 0.07, vol: 0.09 });
      tone(ctx, { type: 'square', from: 784, to: 780, dur: 0.1, delay: 0.06, vol: 0.09 });
    },
    (ctx) => tone(ctx, { type: 'sine', from: 300, to: 900, dur: 0.1, vol: 0.15 }),             // 뿅
  ];

  return {
    hit(bonus) {
      const ctx = ensure();
      if (!ctx) return;
      const now = performance.now();
      if (now - lastAt < 70) return;   // 동시 다발 타격 때 소리 폭주 방지
      lastAt = now;
      VARIANTS[Math.floor(Math.random() * VARIANTS.length)](ctx);
      // 보너스(×2)는 반짝이는 상승음을 겹쳐서 특별하게 들리게 한다.
      if (bonus) tone(ctx, { type: 'triangle', from: 660, to: 1760, dur: 0.28, delay: 0.02, vol: 0.12 });
    },
  };
})();

let me = null;
let snapshot = {
  phase: 'waiting', words: [], scores: { red: 0, blue: 0 },
  lives: 10, maxLives: 10, playerCount: 0, remainMs: 0, restartInMs: 0,
};

const rendered = new Map();   // wordId -> 화면 보간용 단어
const effects = [];           // 파괴 / 낙하 이펙트
let lastScores = { red: 0, blue: 0 };
let comboTimer = null;
let toastTimer = null;

/* ------------------------------ 참여 안내 ------------------------------ */

let joinUrl = '';

function applySession(data) {
  if (!data) return;
  joinUrl = data.joinUrl || '';
  $('joinUrl').textContent = joinUrl.replace(/^https?:\/\//, '');
  if (data.qrDataUrl) $('qrMain').src = data.qrDataUrl;
}

/** 클립보드 복사 — 비 HTTPS 환경에서도 동작하도록 폴백을 둔다. */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function flashCopied(btn, label) {
  const original = btn.textContent;
  btn.textContent = '복사됨!';
  btn.classList.add('done');
  setTimeout(() => { btn.textContent = label || original; btn.classList.remove('done'); }, 1500);
}

fetch('/api/session')
  .then((r) => r.json())
  .then(applySession)
  .catch(() => { $('joinUrl').textContent = '주소를 불러오지 못했습니다'; });

// 터널이 열리면 서버가 새 주소를 밀어준다.
socket.on('session', (data) => {
  applySession(data);
  toast('참여 링크가 갱신되었습니다');
});

$('copyBtn').addEventListener('click', async () => {
  await copyText(joinUrl || window.location.origin);
  flashCopied($('copyBtn'), '링크 복사');
  input.focus();
});

// 단어 직접 추가 — 서버 큐에 넣으면 다음 스폰 때 금색 단어로 떨어진다.
const customWord = $('customWord');

function addCustomWord() {
  const text = customWord.value.trim();
  if (!text) return;
  socket.emit('word:custom', text);
  customWord.value = '';
}

$('customAdd').addEventListener('click', addCustomWord);
customWord.addEventListener('keyup', (e) => { if (e.key === 'Enter') addCustomWord(); });

/* -------------------------------- 소켓 -------------------------------- */

/*
 * 로그인은 없지만 브라우저에 닉네임과 개인 최고 기록은 남겨둔다.
 * (한컴타자는 비로그인이면 기록이 사라진다고 안내하는데, 그 아쉬움을 로컬 저장으로 메운다)
 */
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(`dropwords.${key}`)) ?? fallback; }
    catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`dropwords.${key}`, JSON.stringify(value)); } catch { /* 사파리 프라이빗 모드 등 */ }
  },
};

socket.on('welcome', (data) => {
  me = data.me;
  applyMe();

  // 이미 접속해 있던 사람들의 프로필 사진
  if (data.photos) {
    for (const [id, photo] of Object.entries(data.photos)) photos.set(id, photo);
  }

  // 전에 쓰던 닉네임이 있으면 자동 생성된 이름 대신 그것을 쓴다.
  const saved = store.get('nick', null);
  if (saved && saved !== me.nick) socket.emit('rename', saved);

  applySession(data);

  if (requestedTeam) {
    toast(`${me.nick} 님, ${TEAM_LABEL[me.team]} 팀으로 입장했습니다`);
  } else {
    // 팀을 지정하지 않고 들어왔다면 직접 고를 기회를 준다.
    showTeamPick();
  }

  // 라운드 종료 중에 들어왔다면 직전 결과부터 보여준다.
  if (data.lastResult) {
    const r = data.lastResult;
    showResult(
      r.winner === 'draw' ? '무승부!' : `${TEAM_LABEL[r.winner]} 팀 승리!`,
      r.reason === 'time' ? '시간 종료' : '목숨 소진',
      r,
    );
  }
});

socket.on('me:profile', (data) => {
  me = data.me;
  applyMe();
  store.set('nick', me.nick);
  toast(`${me.nick} · ${TEAM_LABEL[me.team]} 팀`);
});

socket.on('me:update', (data) => {
  $('meScore').textContent = data.score;
  showCombo(data.combo);
  paintGauges(data);
});

/** 한컴타자식 지표 표시 — 타/분, 정확도 */
function paintGauges(stats) {
  if (typeof stats.cpm === 'number') $('myCpm').textContent = stats.cpm;
  if (typeof stats.accuracy === 'number') {
    $('myAcc').textContent = stats.accuracy;
    $('myAcc').parentElement.classList.toggle('low', stats.accuracy < 80);
  }
}

socket.on('disconnect', () => {
  $('phaseLabel').textContent = '연결 끊김';
  toast('서버와 연결이 끊어졌습니다. 다시 연결하는 중…');
});

socket.on('connect', () => { if (me) toast('다시 연결되었습니다'); });

function applyMe() {
  $('meNick').textContent = me.nick;
  $('meScore').textContent = me.score;
  document.body.classList.remove('team-red', 'team-blue');
  document.body.classList.add(`team-${me.team}`);
}

socket.on('state', (s) => {
  snapshot = s;
  syncWords(s.words);
  paintHud(s);
});

/* ------------------------ 프로필 사진 / 득점 바 ------------------------ */

const photos = new Map();   // playerId -> dataURL
let lastRoster = null;

socket.on('profile:photo', ({ id, photo }) => {
  photos.set(id, photo);
  if (lastRoster) renderScoreBars(lastRoster);
});

/** 상단 득점 바 — 플레이어별 점수 비중을 실시간으로 보여준다. */
function renderScoreBars(data) {
  const bars = $('scoreBars');
  bars.innerHTML = '';

  const players = data.players.slice(0, 10);
  for (const p of players) {
    const seg = document.createElement('div');
    seg.className = `sb-seg ${p.team}`;
    seg.dataset.pid = p.id;            // 아바타 비행 애니메이션의 출발점 조회용
    // 점수 비중만큼 넓어진다. +1은 0점일 때도 존재감을 주기 위한 바닥값.
    seg.style.flexGrow = p.score + 1;

    const photo = photos.get(p.id);
    if (photo) {
      const img = document.createElement('img');
      img.className = 'sb-avatar';
      img.src = photo;
      seg.appendChild(img);
    } else {
      const initial = document.createElement('span');
      initial.className = 'sb-initial';
      initial.textContent = [...p.nick][0] || '?';
      seg.appendChild(initial);
    }

    const nick = document.createElement('span');
    nick.className = 'sb-nick';
    nick.textContent = p.nick;
    seg.appendChild(nick);

    const score = document.createElement('span');
    score.className = 'sb-score';
    score.textContent = p.score;
    seg.appendChild(score);

    bars.appendChild(seg);
  }
}

socket.on('roster', (data) => {
  lastRoster = data;
  $('countRed').textContent = `${data.counts.red}명`;
  $('countBlue').textContent = `${data.counts.blue}명`;
  $('tpRed').textContent = `${data.counts.red}명`;
  $('tpBlue').textContent = `${data.counts.blue}명`;

  renderScoreBars(data);

  const list = $('rosterList');
  list.innerHTML = '';

  for (const p of data.players.slice(0, 12)) {
    const li = document.createElement('li');
    li.className = `${p.team}${me && p.id === me.id ? ' self' : ''}`;
    li.dataset.pid = p.id;

    const photo = photos.get(p.id);
    li.innerHTML = `${photo ? '<img class="r-avatar" alt="" />' : '<i></i>'}<b></b><span></span>`;
    if (photo) li.querySelector('.r-avatar').src = photo;
    li.querySelector('b').textContent = p.nick;
    li.querySelector('span').textContent = p.score;
    list.appendChild(li);

    if (me && p.id === me.id) $('meScore').textContent = p.score;
  }
});

socket.on('word:hit', (hit) => {
  const word = rendered.get(hit.id);
  // 서버 좌표보다 화면에 실제로 그려지던 위치에서 터뜨려야 자연스럽다.
  const x = word ? word.x : hit.x;
  const y = word ? wordY(word, Date.now() - 120) : hit.y;
  rendered.delete(hit.id);

  // 셀카 프로필이 있으면 아바타가 단어까지 날아가 명중하는 순간 터진다.
  const img = hit.playerId ? photoImg(hit.playerId) : null;
  if (img && img.complete && img.naturalWidth) {
    launchAvatar(img, hit, x, y);
  } else {
    spawnBurst(x, y, hit);
    sound.hit(hit.bonus);
  }
});

/* ------------------------- 아바타 비행 애니메이션 ------------------------- */

const photoImgs = new Map();   // playerId -> HTMLImageElement (dataURL 캐시)

function photoImg(id) {
  const dataUrl = photos.get(id);
  if (!dataUrl) return null;
  let img = photoImgs.get(id);
  if (img && img.__src === dataUrl) return img;
  img = new Image();
  img.src = dataUrl;
  img.__src = dataUrl;
  photoImgs.set(id, img);
  return img;
}

/** 출발점: 상단 득점 바(또는 모바일 순위 스트립)의 내 칸. 없으면 상단 중앙. */
function flyStart(playerId, rect) {
  const candidates = [
    document.querySelector(`.sb-seg[data-pid="${playerId}"]`),
    document.querySelector(`#rosterList li[data-pid="${playerId}"]`),
  ];
  for (const el of candidates) {
    if (el && el.offsetWidth) {
      const r = el.getBoundingClientRect();
      return {
        x: (r.left + r.width / 2 - rect.left) / rect.width,
        y: (r.top + r.height / 2 - rect.top) / rect.height,
      };
    }
  }
  return { x: 0.5, y: -0.04 };
}

function launchAvatar(img, hit, tx, ty) {
  const start = flyStart(hit.playerId, canvas.getBoundingClientRect());
  effects.push({
    kind: 'fly',
    img, hit,
    x: start.x, y: start.y,
    tx, ty,
    t: 0, life: 16,
  });
}

socket.on('word:dropped', (info) => {
  rendered.delete(info.id);
  effects.push({ kind: 'drop', x: info.x, y: 1, text: info.text, color: '#ff4d6d', t: 0, life: 38 });
});

socket.on('word:miss', (data) => {
  // 타이핑 타임에 터치한 경우 — 실수로 치지 않고 안내만 한다.
  if (data && data.reason === 'typing-only') {
    toast('⌨️ 단어를 입력해야 점수를 얻습니다');
    return;
  }
  hideCombo();
  paintGauges(data || {});
  input.classList.add('miss');
  setTimeout(() => input.classList.remove('miss'), 300);
});

socket.on('round:start', () => {
  hideOverlay();
  hideCombo();
  effects.length = 0;
  paintGauges({ cpm: 0, accuracy: 100 });
  toast('라운드 시작!');
});

socket.on('round:over', (result) => {
  const title = result.winner === 'draw' ? '무승부!' : `${TEAM_LABEL[result.winner]} 팀 승리!`;
  const reason = result.reason === 'time' ? '시간 종료' : '목숨 소진';
  showResult(title, reason, result);
});

socket.on('toast', (msg) => toast(msg));

/* -------------------------------- 입력 -------------------------------- */

/*
 * 한글 IME는 Enter로 조합을 확정하기 때문에 keydown으로 받으면
 * 조합 중 이벤트(isComposing)와 겹쳐 두 번 눌러야 한다.
 * keyup은 조합 확정 이후에 한 번만 오므로 여기서 제출한다.
 */
input.addEventListener('keyup', (e) => {
  if (e.key !== 'Enter') return;
  submit();
});

function submit() {
  const text = input.value.trim();
  if (!text) return;
  socket.emit('submit', text, 'type');
  input.value = '';
}

// PC에서는 아무 키나 눌러도 입력창으로 포커스가 간다.
window.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (!$('modal').hidden) return;
  // 단어 추가 등 다른 입력창에 타이핑 중일 때는 포커스를 뺏지 않는다.
  const active = document.activeElement;
  if (active && active.tagName === 'INPUT' && active !== input) return;
  if (active !== input) input.focus();
});

// 모바일에서 화면을 누르면 키보드가 다시 올라온다.
canvas.addEventListener('pointerdown', () => input.focus());
input.focus();

/*
 * 터치 득점은 비활성화되어 있다 — 모든 득점은 타이핑으로만 한다.
 * 휴대폰에서 캔버스를 터치하면 입력창에 포커스만 준다.
 */
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  input.focus();
  return;

  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const pad = 12;                      // 손가락 오차 허용

  let target = null;
  for (const word of rendered.values()) {
    if (word.hx === undefined) continue;
    if (
      x >= word.hx - word.hw / 2 - pad && x <= word.hx + word.hw / 2 + pad
      && y >= word.hy - word.hh / 2 - pad && y <= word.hy + word.hh / 2 + pad
    ) {
      if (!target || word.hy > target.hy) target = word;
    }
  }

  if (target) socket.emit('submit', target.text, 'touch');
});

/* ------------------------------ 팀 선택 ------------------------------ */

const teamPick = $('teamPick');

function showTeamPick() {
  teamPick.hidden = false;
}

function closeTeamPick() {
  teamPick.hidden = true;
  input.focus();
}

for (const btn of teamPick.querySelectorAll('[data-pick]')) {
  btn.addEventListener('click', () => {
    const team = btn.dataset.pick;
    // 이미 그 팀이면 서버를 부를 필요가 없다.
    if (me && me.team !== team) socket.emit('team:set', team);
    else toast(`${TEAM_LABEL[team]} 팀으로 시작합니다`);
    closeTeamPick();
  });
}

// 결과 화면의 다시 시작 — 누구든 누르면 다음 판이 시작된다.
$('restartBtn').addEventListener('click', () => socket.emit('round:restart'));

$('teamPickSkip').addEventListener('click', () => {
  toast(`${TEAM_LABEL[me.team]} 팀으로 자동 배정되었습니다`);
  closeTeamPick();
});

/* ------------------------------ 셀카 프로필 ------------------------------ */

const selfieInput = $('selfieInput');
const openSelfie = () => selfieInput.click();

$('selfieBtn').addEventListener('click', openSelfie);
$('photoBtn').addEventListener('click', openSelfie);

selfieInput.addEventListener('change', () => {
  const file = selfieInput.files && selfieInput.files[0];
  if (!file) return;

  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);

    // 정사각형으로 잘라 96px로 줄인다. 전송량을 아끼기 위한 크기다.
    const size = 96;
    const c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    const cctx = c.getContext('2d');
    const crop = Math.min(img.width, img.height);
    cctx.drawImage(
      img,
      (img.width - crop) / 2, (img.height - crop) / 2, crop, crop,
      0, 0, size, size,
    );

    const dataUrl = c.toDataURL('image/jpeg', 0.72);
    socket.emit('profile:photo', dataUrl);

    const preview = $('selfiePreview');
    preview.src = dataUrl;
    preview.hidden = false;
    toast('프로필 사진이 설정되었습니다');
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('사진을 읽지 못했습니다');
  };
  img.src = url;
  selfieInput.value = '';
});

/* ---------------------------- 내 정보 편집 ---------------------------- */

const modal = $('modal');

$('meBtn').addEventListener('click', () => {
  if (!me) return;
  $('nickInput').value = me.nick;
  modal.hidden = false;
  $('nickInput').focus();
  $('nickInput').select();
});

$('modalCancel').addEventListener('click', closeModal);
$('modalSave').addEventListener('click', saveProfile);
$('teamBtn').addEventListener('click', () => socket.emit('team:switch'));

$('nickInput').addEventListener('keyup', (e) => {
  if (e.key === 'Enter') saveProfile();
  if (e.key === 'Escape') closeModal();
});

modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

function saveProfile() {
  const nick = $('nickInput').value.trim();
  if (nick && nick !== me.nick) socket.emit('rename', nick);
  closeModal();
}

function closeModal() {
  modal.hidden = true;
  input.focus();
}

/* ------------------------------- HUD 갱신 ------------------------------ */

function paintHud(s) {
  // 점수가 오르면 살짝 튀는 연출
  for (const team of ['red', 'blue']) {
    const el = $(team === 'red' ? 'scoreRed' : 'scoreBlue');
    el.textContent = s.scores[team];
    if (s.scores[team] > lastScores[team]) {
      el.classList.add('bump');
      setTimeout(() => el.classList.remove('bump'), 120);
    }
  }
  lastScores = { ...s.scores };

  $('playerCount').textContent = s.playerCount;

  const lives = $('lives');
  if (lives.children.length !== s.maxLives) lives.innerHTML = '<i></i>'.repeat(s.maxLives);
  [...lives.children].forEach((el, i) => el.classList.toggle('lost', i >= s.lives));

  const timer = $('timer');
  if (s.phase === 'playing') {
    const sec = Math.ceil(s.remainMs / 1000);
    timer.textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    timer.classList.toggle('urgent', sec <= 15);
  } else {
    timer.textContent = '--:--';
    timer.classList.remove('urgent');
  }

  const labels = { waiting: '대기 중', playing: '진행 중', over: '라운드 종료' };
  $('phaseLabel').textContent = s.phase === 'playing'
    ? '⌨️ 타이핑'
    : (labels[s.phase] || s.phase);

  // 항상 타이핑 모드이므로 모드 전환 배너는 쓰지 않는다.
  $('modeBar').hidden = true;

  if (s.phase === 'playing') {
    hideOverlay();
  } else if (s.phase === 'waiting') {
    showWaiting();
  } else if (s.phase === 'over') {
    $('overlayCountdown').textContent = '';
    $('restartBtn').hidden = false;
  }
}

function showWaiting() {
  const t = $('overlayTitle');
  t.textContent = '참가자를 기다리는 중';
  t.className = 'overlay-title';
  $('overlaySub').textContent = 'QR을 스캔하거나 링크로 접속하면 바로 시작됩니다';
  $('result').hidden = true;
  $('overlayCountdown').textContent = '';
  $('restartBtn').hidden = true;
  $('overlay').hidden = false;
}

/** 라운드 결과: 팀 점수 비교와 참가자 전원의 득점 리스트 */
function showResult(title, reason, result) {
  const t = $('overlayTitle');
  t.textContent = title;
  t.className = `overlay-title${result.winner !== 'draw' ? ` ${result.winner}` : ''}`;
  $('overlaySub').textContent = reason;

  const { red, blue } = result.scores;
  const total = red + blue;
  $('barRed').textContent = red;
  $('barBlue').textContent = blue;
  // 0:0이면 반반으로 채워 막대가 비어 보이지 않게 한다.
  $('barFillRed').style.width = `${total ? (red / total) * 100 : 50}%`;
  $('barFillBlue').style.width = `${total ? (blue / total) * 100 : 50}%`;

  const sec = Math.round((result.durationMs || 0) / 1000);
  $('resultMeta').textContent =
    `${result.ranking.length}명 참가 · ${result.totalHits}개 파괴 · ${Math.floor(sec / 60)}분 ${sec % 60}초`;

  const list = $('resultList');
  list.innerHTML = '';

  result.ranking.forEach((p, i) => {
    const li = document.createElement('li');
    li.className = `${p.team}${me && p.id === me.id ? ' self' : ''}${i < 3 ? ` top${i + 1}` : ''}`;
    li.style.animationDelay = `${Math.min(i, 12) * 0.035}s`;
    li.innerHTML =
      '<span class="rank"></span>'
      + '<span class="name"><i></i><b></b></span>'
      + '<span class="num cpm"></span>'
      + '<span class="num acc"></span>'
      + '<span class="num hits"></span>'
      // 화면 하단 콤보 칩(.combo)과 클래스가 겹치지 않도록 이름을 구분한다
      + '<span class="num bestcombo"></span>'
      + '<span class="score"></span>';

    li.querySelector('.rank').textContent = i + 1;
    li.querySelector('.name b').textContent = p.nick;
    li.querySelector('.cpm').textContent = p.cpm ?? 0;

    const acc = li.querySelector('.acc');
    acc.textContent = `${p.accuracy ?? 100}%`;
    acc.classList.toggle('low', (p.accuracy ?? 100) < 80);

    li.querySelector('.hits').textContent = `${p.hits}개`;
    li.querySelector('.bestcombo').textContent = p.bestCombo > 1 ? `x${p.bestCombo}` : '-';
    li.querySelector('.score').textContent = `${p.score}점`;
    li.querySelector('.score').style.color = TEAM_COLOR[p.team];

    // 1위이면서 점수가 있는 경우에만 MVP 표시
    if (i === 0 && p.score > 0) {
      const tag = document.createElement('span');
      tag.className = 'mvp';
      tag.textContent = 'MVP';
      li.querySelector('.name').appendChild(tag);
    }

    list.appendChild(li);
  });

  paintPersonalBest(result);

  $('result').hidden = false;
  $('overlayCountdown').textContent = '';
  $('overlay').hidden = false;
}

/** 내 이번 판 기록을 개인 최고 기록과 비교해 보여준다. */
function paintPersonalBest(result) {
  const el = $('resultBest');
  el.className = 'result-best';

  const mine = me && result.ranking.find((p) => p.id === me.id);
  if (!mine) { el.textContent = ''; return; }

  const best = store.get('best', { score: 0, cpm: 0, accuracy: 0 });
  const renewed = [];

  if (mine.score > best.score) { renewed.push('점수'); best.score = mine.score; }
  if (mine.cpm > best.cpm) { renewed.push('타수'); best.cpm = mine.cpm; }
  if (mine.hits > 0 && mine.accuracy > best.accuracy) { renewed.push('정확도'); best.accuracy = mine.accuracy; }

  if (renewed.length) {
    store.set('best', best);
    el.className = 'result-best record';
    el.textContent = `🎉 개인 최고 ${renewed.join(' · ')} 기록 경신! ${mine.score}점 · ${mine.cpm}타/분 · 정확도 ${mine.accuracy}%`;
  } else {
    el.innerHTML = `이번 판 <b>${mine.score}점 · ${mine.cpm}타/분 · 정확도 ${mine.accuracy}%</b>`
      + ` &nbsp;|&nbsp; 내 최고 ${best.score}점 · ${best.cpm}타/분`;
  }
}

function hideOverlay() {
  $('overlay').hidden = true;
  $('result').hidden = true;   // 결과표도 함께 접어 상태를 깔끔히 유지한다
  $('restartBtn').hidden = true;
}

function showCombo(combo) {
  if (!combo || combo < 2) return hideCombo();
  $('comboNum').textContent = `x${combo}`;
  $('combo').hidden = false;
  clearTimeout(comboTimer);
  comboTimer = setTimeout(hideCombo, 4000);
}

function hideCombo() { $('combo').hidden = true; }

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

/* ------------------------------ 렌더링 ------------------------------ */

function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.round(rect.width * dpr));
  canvas.height = Math.max(1, Math.round(rect.height * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));

/*
 * 모바일 키보드가 올라오면 보이는 영역이 줄어든다. 그만큼 화면을 줄여준다.
 * iOS는 여기에 더해 페이지 전체를 위로 스크롤해 점수판과 게임 화면을
 * 밖으로 밀어내므로, 스크롤을 매번 0으로 되돌려 상단이 항상 보이게 한다.
 */
if (window.visualViewport) {
  const vv = window.visualViewport;
  const syncViewport = () => {
    document.body.style.height = `${vv.height}px`;
    window.scrollTo(0, 0);
    resize();
  };
  vv.addEventListener('resize', syncViewport);
  vv.addEventListener('scroll', syncViewport);
  // 키보드 등장 애니메이션이 끝난 뒤 한 번 더 맞춘다.
  input.addEventListener('focus', () => {
    setTimeout(syncViewport, 80);
    setTimeout(syncViewport, 350);
  });
}

resize();

/*
 * 서버는 20Hz로 좌표를 보낸다. 매 프레임 목표점으로 당기는 방식은
 * 스냅샷 사이에서 가다 서다를 반복하므로, 최근 두 스냅샷 사이를
 * 시간 기준으로 선형 보간해 등속으로 미끄러지듯 내려오게 한다.
 */
function syncWords(words) {
  const now = Date.now();
  const alive = new Set();

  for (const [id, text, x, y, custom, bonus] of words) {
    alive.add(id);
    const cur = rendered.get(id);
    if (cur) {
      cur.t0 = cur.t1; cur.y0 = cur.y1;
      cur.t1 = now; cur.y1 = y;
      cur.x = x;
    } else {
      rendered.set(id, {
        text, x,
        y0: y, y1: y, t0: now - 50, t1: now,
        custom: !!custom, bonus: !!bonus,
      });
    }
  }

  for (const id of rendered.keys()) {
    if (!alive.has(id)) rendered.delete(id);
  }
}

/** 120ms 과거 시점을 그려서 다음 스냅샷이 늦어도 튀지 않게 한다. */
function wordY(word, renderAt) {
  if (word.t1 <= word.t0) return word.y1;
  let f = (renderAt - word.t0) / (word.t1 - word.t0);
  if (f < 0) f = 0;
  if (f > 2) f = 2;               // 스냅샷이 끊겨도 과하게 앞서가지 않도록
  return word.y0 + (word.y1 - word.y0) * f;
}

function draw() {
  const rect = canvas.getBoundingClientRect();
  const w = rect.width;
  const h = rect.height;
  ctx.clearRect(0, 0, w, h);

  // 바닥 경고선
  ctx.strokeStyle = 'rgba(255,77,109,0.35)';
  ctx.setLineDash([6, 8]);
  ctx.beginPath();
  ctx.moveTo(0, h - 2);
  ctx.lineTo(w, h - 2);
  ctx.stroke();
  ctx.setLineDash([]);

  const fontSize = Math.max(15, Math.min(26, w / 42));
  ctx.font = `600 ${fontSize}px -apple-system, 'Apple SD Gothic Neo', system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const typed = input.value.trim();
  const renderAt = Date.now() - 120;

  for (const word of rendered.values()) {
    const y = wordY(word, renderAt);

    const boxW = ctx.measureText(word.text).width + fontSize * 1.4;
    const boxH = fontSize * 1.9;

    // 좁은 화면에서 긴 단어가 잘리지 않도록 화면 안으로 밀어 넣는다.
    const px = Math.min(Math.max(word.x * w, boxW / 2 + 4), w - boxW / 2 - 4);
    const py = y * h;

    // 터치 판정용으로 실제 그려진 위치를 기억해 둔다.
    word.hx = px; word.hy = py; word.hw = boxW; word.hh = boxH;

    const danger = Math.max(0, (y - 0.65) / 0.35);   // 바닥에 가까울수록 붉게
    const matching = typed && word.text.startsWith(typed);

    ctx.beginPath();
    ctx.roundRect(px - boxW / 2, py - boxH / 2, boxW, boxH, boxH / 2);

    if (word.custom && !matching) {
      // 직접 추가한 단어 — 은은하게 숨쉬는 금빛 강조
      const glow = 0.7 + 0.3 * Math.sin(Date.now() / 240);
      ctx.fillStyle = 'rgba(62, 47, 12, 0.92)';
      ctx.shadowColor = '#ffd66b';
      ctx.shadowBlur = 18 * glow;
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(255, 214, 107, 0.95)';
      ctx.stroke();
    } else if (word.bonus && !matching) {
      // 점수 2배 — 시안↔마젠타로 흐르는 네온 테두리 + ×2 배지
      const t = Date.now() / 480;
      const grad = ctx.createLinearGradient(px - boxW / 2, py - boxH / 2, px + boxW / 2, py + boxH / 2);
      const mid = 0.5 + 0.45 * Math.sin(t);
      grad.addColorStop(0, '#4dfff0');
      grad.addColorStop(mid, '#b44dff');
      grad.addColorStop(1, '#ff4df0');

      ctx.fillStyle = 'rgba(32, 12, 46, 0.93)';
      ctx.shadowColor = '#c44dff';
      ctx.shadowBlur = 16 + 8 * Math.sin(t * 2.3);
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = grad;
      ctx.stroke();

      // 상자 오른쪽 위 ×2 배지
      const mainFont = ctx.font;
      ctx.font = `800 ${Math.round(fontSize * 0.6)}px system-ui, sans-serif`;
      ctx.fillStyle = '#ff8df5';
      ctx.shadowColor = '#ff4df0';
      ctx.shadowBlur = 8;
      ctx.fillText('×2', px + boxW / 2 - fontSize * 0.2, py - boxH / 2 - fontSize * 0.28);
      ctx.shadowBlur = 0;
      ctx.font = mainFont;
    } else {
      ctx.fillStyle = matching
        ? 'rgba(124,245,196,0.2)'
        : `rgba(${Math.round(20 + danger * 80)}, ${Math.round(28 - danger * 10)}, ${Math.round(54 - danger * 20)}, 0.9)`;
      ctx.fill();
      ctx.lineWidth = matching ? 2 : 1;
      ctx.strokeStyle = matching
        ? '#7cf5c4'
        : `rgba(${Math.round(90 + danger * 165)}, ${Math.round(110 - danger * 40)}, ${Math.round(170 - danger * 60)}, 0.9)`;
      ctx.stroke();
    }

    // 입력한 부분까지는 강조해서 어디까지 쳤는지 보이게 한다.
    if (matching && typed.length < word.text.length) {
      const rest = word.text.slice(typed.length);
      const fullW = ctx.measureText(word.text).width;
      const doneW = ctx.measureText(typed).width;
      const left = px - fullW / 2;

      ctx.textAlign = 'left';
      ctx.fillStyle = '#7cf5c4';
      ctx.fillText(typed, left, py + 1);
      ctx.fillStyle = '#e8ecf8';
      ctx.fillText(rest, left + doneW, py + 1);
      ctx.textAlign = 'center';
    } else {
      ctx.fillStyle = matching
        ? '#7cf5c4'
        : (word.custom ? '#ffe9ad' : (word.bonus ? '#ffd9fb' : '#e8ecf8'));
      ctx.fillText(word.text, px, py + 1);
    }
  }

  drawEffects(w, h, fontSize);
  requestAnimationFrame(draw);
}

/*
 * 단어를 맞히면 글자가 산산이 흩어지고 충격파가 퍼지는 연출.
 * 좌표는 정규화(x, y)를 기준점으로 두고 조각의 이동량만 픽셀로 다뤄
 * 화면 비율이 달라도 원형으로 퍼진다.
 */
function spawnBurst(x, y, hit) {
  const color = TEAM_COLOR[hit.team] || '#7cf5c4';
  const combo = hit.combo || 1;
  // 콤보가 높을수록, 보너스(×2)면 한층 더 화려하게. 뒤늦은 타격(echo)은 조금 작게.
  const power = Math.min(1 + (combo - 1) * 0.16, 2.1) * (hit.bonus ? 1.35 : 1) * (hit.echo ? 0.75 : 1);

  effects.push({ kind: 'ring', x, y, color, t: 0, life: 26, power });
  if (hit.bonus) {
    effects.push({ kind: 'ring', x, y, color: '#ff4df0', t: 0, life: 34, power: power * 1.25 });
  }

  // 글자 조각 — 단어가 부서지듯 흩어진다
  const chars = [...hit.text];
  chars.forEach((ch, i) => {
    const slot = chars.length > 1 ? i / (chars.length - 1) - 0.5 : 0;
    const angle = -Math.PI / 2 + slot * 1.7 + (Math.random() - 0.5) * 0.45;
    const speed = (2.4 + Math.random() * 2.0) * power;
    effects.push({
      kind: 'shard',
      x, y, ch, slot, color,
      ox: 0, oy: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      rot: 0,
      vrot: (Math.random() - 0.5) * 0.28,
      t: 0, life: 38 + Math.random() * 12,
    });
  });

  // 불꽃 입자
  const sparks = Math.round(11 * power);
  for (let i = 0; i < sparks; i += 1) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (1.6 + Math.random() * 3.4) * power;
    effects.push({
      kind: 'spark',
      x, y, color,
      ox: 0, oy: 0,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      size: 1.5 + Math.random() * 2.2,
      t: 0, life: 22 + Math.random() * 16,
    });
  }

  effects.push({
    kind: 'score',
    x, y, combo,
    color: hit.bonus ? '#ff8df5' : color,
    // 뒤늦은 타격은 점수가 없으므로 득점 대신 타격 표시만 띄운다.
    label: hit.echo ? '타격!' : `+${hit.gain}${hit.bonus ? ' ×2' : ''}`,
    sub: hit.by,
    t: 0, life: 54,
  });

  // 폭주하지 않도록 상한을 둔다 (동시 접속이 많을 때 대비)
  if (effects.length > 700) effects.splice(0, effects.length - 700);
}

function drawEffects(w, h, fontSize) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (let i = effects.length - 1; i >= 0; i -= 1) {
    const fx = effects[i];
    fx.t += 1;
    if (fx.t > fx.life) {
      effects.splice(i, 1);
      // 아바타가 단어에 도착하는 순간 폭발과 효과음이 터진다.
      if (fx.kind === 'fly') {
        spawnBurst(fx.tx, fx.ty, fx.hit);
        sound.hit(fx.hit.bonus);
      }
      continue;
    }

    const p = fx.t / fx.life;          // 0 → 1 진행도
    const fade = 1 - p * p;            // 끝으로 갈수록 빠르게 사라진다
    const px = fx.x * w;
    const py = fx.y * h;

    if (fx.kind === 'ring') {
      const r = fontSize * (0.6 + 3.4 * (1 - (1 - p) ** 3)) * fx.power;
      ctx.globalAlpha = fade * 0.75;
      ctx.strokeStyle = fx.color;
      ctx.lineWidth = Math.max(0.5, 3.2 * (1 - p) * fx.power);
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      ctx.stroke();

    } else if (fx.kind === 'shard') {
      // 첫 프레임에 글자 폭을 알 수 있으므로 그때 시작 위치를 잡는다
      if (fx.ox === 0 && fx.t === 1) fx.ox = fx.slot * fontSize * 1.05 * [...fx.ch].length;

      fx.vy += 0.34;                   // 중력
      fx.vx *= 0.985;
      fx.ox += fx.vx;
      fx.oy += fx.vy;
      fx.rot += fx.vrot;

      ctx.save();
      ctx.translate(px + fx.ox, py + fx.oy);
      ctx.rotate(fx.rot);
      ctx.globalAlpha = fade;
      ctx.font = `800 ${fontSize * (1 + 0.25 * (1 - p))}px -apple-system, 'Apple SD Gothic Neo', system-ui, sans-serif`;
      ctx.fillStyle = fx.color;
      ctx.shadowColor = fx.color;
      ctx.shadowBlur = 12 * fade;
      ctx.fillText(fx.ch, 0, 0);
      ctx.restore();
      ctx.shadowBlur = 0;

    } else if (fx.kind === 'spark') {
      fx.vy += 0.22;
      fx.vx *= 0.94;
      fx.vy *= 0.97;
      fx.ox += fx.vx;
      fx.oy += fx.vy;

      ctx.globalAlpha = fade;
      ctx.fillStyle = fx.color;
      ctx.beginPath();
      ctx.arc(px + fx.ox, py + fx.oy, fx.size * (1 - p * 0.7), 0, Math.PI * 2);
      ctx.fill();

    } else if (fx.kind === 'score') {
      // 튀어오르며 커졌다가 제자리로 — 짧은 팝 연출
      const pop = fx.t < 9 ? 0.45 + (fx.t / 9) * 0.75 : 1.2 - Math.min((fx.t - 9) / 8, 1) * 0.2;
      const rise = 12 + p * 52;

      ctx.save();
      ctx.translate(px, py - rise);
      ctx.scale(pop, pop);
      ctx.globalAlpha = fade;

      ctx.font = `800 ${fontSize * 1.05}px system-ui, sans-serif`;
      ctx.fillStyle = fx.color;
      ctx.shadowColor = fx.color;
      ctx.shadowBlur = 16 * fade;
      ctx.fillText(fx.label, 0, 0);
      ctx.shadowBlur = 0;

      ctx.font = `600 ${fontSize * 0.55}px system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(232,236,248,0.85)';
      ctx.fillText(fx.sub, 0, fontSize * 0.95);

      if (fx.combo >= 3) {
        ctx.font = `800 ${fontSize * 0.5}px system-ui, sans-serif`;
        ctx.fillStyle = '#ffd66b';
        ctx.fillText(`COMBO x${fx.combo}`, 0, -fontSize * 0.95);
      }

      ctx.restore();

    } else if (fx.kind === 'fly') {
      // 셀카 아바타가 포물선을 그리며 단어로 날아간다.
      const ease = p * p * (3 - 2 * p);                       // smoothstep
      const cx = (fx.x + (fx.tx - fx.x) * ease) * w;
      const cy = (fx.y + (fx.ty - fx.y) * ease - Math.sin(p * Math.PI) * 0.06) * h;
      const size = fontSize * (1.4 - 0.45 * p);               // 다가갈수록 살짝 작아진다
      const color = TEAM_COLOR[fx.hit.team] || '#7cf5c4';

      ctx.globalAlpha = 1;

      // 속도감을 주는 잔상
      const prevEase = Math.max(0, p - 0.12);
      const pe = prevEase * prevEase * (3 - 2 * prevEase);
      const gx = (fx.x + (fx.tx - fx.x) * pe) * w;
      const gy = (fx.y + (fx.ty - fx.y) * pe - Math.sin(prevEase * Math.PI) * 0.06) * h;
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(gx, gy, size * 0.7, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(fx.img, cx - size, cy - size, size * 2, size * 2);
      ctx.restore();

      ctx.lineWidth = 2.5;
      ctx.strokeStyle = color;
      ctx.shadowColor = color;
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(cx, cy, size, 0, Math.PI * 2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      ctx.lineWidth = 1;

    } else if (fx.kind === 'drop') {
      // 놓친 단어 — 바닥에서 붉게 흩어진다
      ctx.globalAlpha = fade;
      ctx.font = `700 ${fontSize}px system-ui, sans-serif`;
      ctx.fillStyle = fx.color;
      ctx.fillText(`✕ ${fx.text}`, px, py - 16 - p * 16);

      ctx.globalAlpha = fade * 0.5;
      ctx.strokeStyle = fx.color;
      ctx.lineWidth = 2 * (1 - p);
      ctx.beginPath();
      ctx.ellipse(px, py, fontSize * (1 + p * 3), fontSize * 0.4 * (1 + p * 2), 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
  }
}

// roundRect가 없는 구형 브라우저 대비
if (!CanvasRenderingContext2D.prototype.roundRect) {
  CanvasRenderingContext2D.prototype.roundRect = function (x, y, rw, rh, r) {
    this.moveTo(x + r, y);
    this.arcTo(x + rw, y, x + rw, y + rh, r);
    this.arcTo(x + rw, y + rh, x, y + rh, r);
    this.arcTo(x, y + rh, x, y, r);
    this.arcTo(x, y, x + rw, y, r);
    this.closePath();
    return this;
  };
}

// 개발 중 화면 확인용
window.__debugWords = () => snapshot.words;

requestAnimationFrame(draw);
