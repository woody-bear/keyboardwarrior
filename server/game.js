const { generateNickname, releaseNickname } = require('./nickname');
const keywords = require('./keywords');
const { countStrokes } = require('./hangul');

// 서버가 Source of Truth. 좌표는 0~1 정규화 값으로 다뤄
// 클라이언트 화면 크기와 무관하게 동일한 게임 상태를 공유한다.
const TICK_MS = 50;              // 20Hz 물리 + 브로드캐스트
// 낙하량은 초기값(14개 / 1.3초)의 60% 수준에서 2배로 늘렸다.
const MAX_WORDS = 18;
const SPAWN_MS = 1075;
const BASE_FALL_SPEED = 0.045;   // 화면 높이 비율 / 초
const START_LIVES = 10;
// 라운드 제한 시간은 /keyword 설정(roundSec)을 따른다.
const roundMs = () => keywords.getSettings().roundSec * 1000;
const OVER_HOLD_MS = 10000;      // 결과 화면 유지 후 자동 재시작
const COMBO_WINDOW_MS = 4000;    // 이 시간 안에 연속으로 맞히면 콤보 유지
const MAX_COMBO_BONUS = 1.0;     // 최대 2배

// 입력 모드: 항상 타이핑으로만 득점한다. (터치 득점 사이클은 제거됨)

// 파괴 직후 이 시간 안에 같은 단어를 친 사람은 점수 없이 타격 연출만 받는다.
const ECHO_WINDOW_MS = 2500;

// 단어 겹침 방지용 레인. 우측 순위표를 피하려고 0.84까지만 쓴다.
const LANES = 7;
const LANE_MARGIN = 0.08;
const LANE_STEP = 0.12;
const LANE_CLEAR_Y = 0.16;       // 이 아래로 내려간 단어는 레인을 비워준 것으로 본다

let nextWordId = 1;

const state = {
  phase: 'waiting',              // waiting | playing | over
  players: new Map(),            // socketId -> player
  words: new Map(),              // wordId -> word
  scores: { red: 0, blue: 0 },
  lives: START_LIVES,
  startedAt: 0,
  overAt: 0,
  winner: null,
  lastResult: null,
  lastSpawn: 0,
};

let io = null;
let loopTimer = null;

// 방금 파괴된 단어의 기록. 한 발 늦게 같은 단어를 친 사람의 무점수 타격 판정에 쓴다.
const recentKills = new Map();   // text -> { at, x, y }

/** 현재 입력 모드. 항상 타이핑 전용이다. */
function inputMode() {
  return { mode: 'typing', remainMs: 0 };
}

/* ---------------------------------- 팀 ---------------------------------- */

function teamCounts() {
  const counts = { red: 0, blue: 0 };
  for (const p of state.players.values()) counts[p.team] += 1;
  return counts;
}

/** 인원이 적은 팀으로 넣고, 같으면 점수가 낮은 팀으로 넣는다. */
function pickTeam() {
  const { red, blue } = teamCounts();
  if (red !== blue) return red < blue ? 'red' : 'blue';
  return state.scores.red <= state.scores.blue ? 'red' : 'blue';
}

/* -------------------------------- 플레이어 -------------------------------- */

/** 전용 링크로 지정한 팀은 그대로 존중하고, 없으면 자동 배정한다. */
function resolveTeam(wanted) {
  const team = String(wanted || '').toLowerCase();
  return (team === 'red' || team === 'blue') ? team : pickTeam();
}

function addPlayer(socketId, wantedTeam) {
  const player = {
    id: socketId,
    nick: generateNickname(),
    team: resolveTeam(wantedTeam),
    score: 0,
    hits: 0,
    misses: 0,
    combo: 0,
    bestCombo: 0,
    lastHitAt: 0,
    strokes: 0,        // 맞힌 글자의 타수 (한컴타자식 분당 타수 계산용)
    wrongStrokes: 0,   // 틀린 입력의 타수 (정확도 계산용)
    playedMs: 0,       // 이 라운드에서 실제로 참여한 시간
    joinedAt: Date.now(),
  };
  state.players.set(socketId, player);

  // 대기 중이었다면 첫 참가자가 들어온 순간 라운드를 시작한다.
  if (state.phase === 'waiting') startRound();

  return player;
}

function removePlayer(socketId) {
  const player = state.players.get(socketId);
  if (!player) return;
  releaseNickname(player.nick);
  state.players.delete(socketId);
  if (state.players.size === 0) resetToWaiting();
}

/** 닉네임 자동 생성이 기본이지만, 원하면 직접 바꿀 수 있게 한다. */
function renamePlayer(socketId, rawNick) {
  const player = state.players.get(socketId);
  if (!player) return null;

  const nick = String(rawNick || '').replace(/\s+/g, ' ').trim().slice(0, 12);
  if (!nick) return player;

  const taken = [...state.players.values()].some((p) => p.id !== socketId && p.nick === nick);
  if (taken) return player;

  releaseNickname(player.nick);
  player.nick = nick;
  return player;
}

function switchTeam(socketId) {
  const player = state.players.get(socketId);
  if (!player) return null;
  player.team = player.team === 'red' ? 'blue' : 'red';
  return player;
}

/** 팀 선택 화면에서 고른 팀으로 옮긴다. */
function setTeam(socketId, team) {
  const player = state.players.get(socketId);
  if (!player) return null;
  const wanted = String(team || '').toLowerCase();
  if (wanted !== 'red' && wanted !== 'blue') return null;
  player.team = wanted;
  return player;
}

/* --------------------------------- 라운드 --------------------------------- */

function startRound() {
  state.phase = 'playing';
  state.words.clear();
  recentKills.clear();
  state.scores = { red: 0, blue: 0 };
  state.lives = START_LIVES;
  state.startedAt = Date.now();
  state.winner = null;
  state.lastResult = null;
  state.lastSpawn = 0;

  for (const p of state.players.values()) {
    p.score = 0;
    p.hits = 0;
    p.misses = 0;
    p.combo = 0;
    p.bestCombo = 0;
    p.lastHitAt = 0;
    p.strokes = 0;
    p.wrongStrokes = 0;
    p.joinedAt = state.startedAt;   // 라운드 도중 들어온 사람은 참여 시점부터 계산
  }

  if (io) io.emit('round:start', { startedAt: state.startedAt, duration: roundMs() });
}

function resetToWaiting() {
  state.phase = 'waiting';
  state.words.clear();
  state.scores = { red: 0, blue: 0 };
  state.lives = START_LIVES;
  state.winner = null;
}

function endRound(reason) {
  state.phase = 'over';
  state.overAt = Date.now();

  const { red, blue } = state.scores;
  state.winner = red === blue ? 'draw' : (red > blue ? 'red' : 'blue');

  // 결과 화면에서는 참여한 사람 전원의 기록을 보여준다.
  const ranking = rankedPlayers();
  state.lastResult = {
    winner: state.winner,
    reason,                       // 'lives' | 'time'
    scores: { red, blue },
    ranking,
    mvp: ranking.length ? ranking[0] : null,
    durationMs: state.overAt - state.startedAt,
    totalHits: ranking.reduce((sum, p) => sum + p.hits, 0),
    restartInMs: OVER_HOLD_MS,
  };

  // 결과 화면 뒤에 멈춘 단어가 남지 않도록 정리한다.
  state.words.clear();

  io.emit('round:over', state.lastResult);
}

/** 아직 라운드가 끝나지 않았다면 즉시 다시 시작한다(수동 재시작). */
function restartRound() {
  if (state.players.size === 0) return false;
  startRound();
  return true;
}

/* ---------------------------------- 단어 ---------------------------------- */

/** 경과 시간에 따라 낙하 속도를 조금씩 올린다. */
function currentSpeed() {
  const elapsedSec = (Date.now() - state.startedAt) / 1000;
  return BASE_FALL_SPEED * (1 + Math.min(elapsedSec / 90, 1.2));
}

/** 화면에 이미 있는 단어와 중복되지 않는 단어를 고른다(입력 모호성 방지). */
function pickUniqueWord() {
  const elapsedSec = (Date.now() - state.startedAt) / 1000;
  const onField = new Set([...state.words.values()].map((w) => w.text));

  for (let i = 0; i < 20; i += 1) {
    const text = keywords.pickWord(elapsedSec);
    if (!onField.has(text)) return text;
  }
  return null;
}

/*
 * 단어가 서로 겹쳐 보이지 않도록 화면을 세로 레인으로 나눠 배치한다.
 * 위쪽이 비어 있는 레인 중에서 고르고, 전부 차 있으면 가장 여유 있는 레인을 쓴다.
 */
function pickLaneX() {
  const occupied = new Array(LANES).fill(1);   // 값이 클수록 여유 있음

  for (const w of state.words.values()) {
    if (w.y > LANE_CLEAR_Y) continue;          // 충분히 내려간 단어는 방해되지 않는다
    const lane = Math.round((w.x - LANE_MARGIN) / LANE_STEP);
    if (lane >= 0 && lane < LANES) occupied[lane] = Math.min(occupied[lane], w.y / LANE_CLEAR_Y);
  }

  const free = [];
  occupied.forEach((room, lane) => { if (room >= 1) free.push(lane); });

  const lane = free.length
    ? free[Math.floor(Math.random() * free.length)]
    : occupied.indexOf(Math.max(...occupied));

  // 레인 안에서 살짝 흔들어 기계적으로 보이지 않게 한다.
  return LANE_MARGIN + lane * LANE_STEP + (Math.random() - 0.5) * LANE_STEP * 0.3;
}

// PC 화면에서 직접 추가한 단어는 다음 스폰 때 우선 등장한다.
const customQueue = [];

function queueCustomWord(rawText) {
  const text = String(rawText || '').replace(/\s+/g, ' ').trim().slice(0, 10);
  if (!text) return { ok: false, reason: 'empty' };
  if (customQueue.length >= 20) return { ok: false, reason: 'full' };
  customQueue.push(text);
  return { ok: true, text };
}

function spawnWord() {
  let text = null;
  let custom = false;

  // 직접 추가한 단어가 있으면 먼저 내보낸다. 같은 단어가 화면에 있으면 다음 기회로 미룬다.
  if (customQueue.length) {
    const onField = new Set([...state.words.values()].map((w) => w.text));
    if (!onField.has(customQueue[0])) {
      text = customQueue.shift();
      custom = true;
    }
  }
  if (!text) text = pickUniqueWord();
  if (!text) return;

  // 문장은 글자 수가 많으므로 조금 더 천천히 떨어뜨려 입력할 시간을 준다.
  const lengthEase = text.length > 6 ? 0.72 : 1;

  // 일정 확률로 점수 2배 보너스 단어가 등장한다.
  const bonus = !custom && Math.random() < 0.12;

  const id = nextWordId++;
  state.words.set(id, {
    id,
    text,
    custom,
    bonus,
    x: pickLaneX(),
    y: -0.05,
    vy: currentSpeed() * (0.9 + Math.random() * 0.25) * lengthEase,
  });
}

/** 입력한 텍스트와 일치하는 단어 중 가장 아래(급한) 것을 파괴한다. */
function submitWord(socketId, rawText, method) {
  const player = state.players.get(socketId);
  if (!player || state.phase !== 'playing') return { ok: false, reason: 'inactive' };

  const text = String(rawText || '').trim();
  if (!text) return { ok: false, reason: 'empty' };

  const now = Date.now();

  // 터치로는 점수를 얻을 수 없다 — 타이핑만 인정한다.
  if (method === 'touch') {
    return { ok: false, reason: 'typing-only' };
  }

  let target = null;
  for (const w of state.words.values()) {
    if (w.text === text && (!target || w.y > target.y)) target = w;
  }

  if (!target) {
    // 방금 다른 사람이 파괴한 단어라면 실수가 아니다 — 점수 없는 타격으로 처리한다.
    const kill = recentKills.get(text);
    if (kill && now - kill.at <= ECHO_WINDOW_MS) {
      return { ok: true, echo: true, text, x: kill.x, y: kill.y, player };
    }

    player.combo = 0;
    player.misses += 1;
    player.wrongStrokes += countStrokes(text);
    return { ok: false, reason: 'miss', text, stats: statsOf(player) };
  }

  // 콤보: 일정 시간 안에 연속으로 맞히면 배수가 올라간다.
  player.combo = (now - player.lastHitAt <= COMBO_WINDOW_MS) ? player.combo + 1 : 1;
  player.lastHitAt = now;
  player.bestCombo = Math.max(player.bestCombo, player.combo);

  const multiplier = 1 + Math.min((player.combo - 1) * 0.1, MAX_COMBO_BONUS);
  const gain = Math.round(target.text.length * 10 * multiplier) * (target.bonus ? 2 : 1);

  state.words.delete(target.id);
  recentKills.set(target.text, { at: now, x: target.x, y: target.y });
  // 오래된 기록은 정리해 맵이 무한히 커지지 않게 한다.
  if (recentKills.size > 30) {
    for (const [t, k] of recentKills) {
      if (now - k.at > ECHO_WINDOW_MS) recentKills.delete(t);
    }
  }
  player.score += gain;
  player.hits += 1;
  player.strokes += countStrokes(target.text);
  state.scores[player.team] += gain;

  return {
    ok: true,
    word: target,
    player,
    gain,
    combo: player.combo,
    multiplier,
    stats: statsOf(player),
  };
}

/*
 * 한컴타자식 지표.
 * 타수(CPM) = 맞힌 글자의 자모 타수 / 경과 분
 * 정확도(%) = 맞힌 타수 / (맞힌 타수 + 틀린 타수)
 */
function statsOf(player) {
  const now = state.phase === 'playing' ? Date.now() : state.overAt || Date.now();
  const minutes = Math.max((now - Math.max(player.joinedAt, state.startedAt)) / 60000, 1 / 60);
  const attempted = player.strokes + player.wrongStrokes;

  return {
    cpm: Math.round(player.strokes / minutes),
    accuracy: attempted ? Math.round((player.strokes / attempted) * 100) : 100,
    strokes: player.strokes,
  };
}

/* --------------------------------- 게임 루프 -------------------------------- */

function tick() {
  const now = Date.now();

  // 라운드가 끝나면 자동으로 다음 판을 시작하지 않는다.
  // 결과 화면의 「다시 시작」 버튼(round:restart)을 눌러야 시작된다.

  if (state.phase === 'playing') {
    const dt = TICK_MS / 1000;
    const dropped = [];

    // /keyword 설정의 배율: speed는 즉시(떠 있는 단어 포함), amount는 생성 간격·개수에 적용
    const tuning = keywords.getSettings();

    for (const w of state.words.values()) {
      w.y += w.vy * tuning.speed * dt;
      if (w.y >= 1) dropped.push(w);
    }

    // 바닥에 닿은 단어는 공동 목숨을 깎는다.
    for (const w of dropped) {
      state.words.delete(w.id);
      state.lives -= 1;
      io.emit('word:dropped', { id: w.id, text: w.text, x: w.x, lives: state.lives });
    }

    const maxWords = Math.max(3, Math.round(MAX_WORDS * tuning.amount));
    const spawnMs = SPAWN_MS / tuning.amount;
    if (state.words.size < maxWords && now - state.lastSpawn > spawnMs) {
      state.lastSpawn = now;
      spawnWord();
    }

    if (state.lives <= 0) endRound('lives');
    else if (now - state.startedAt >= roundMs()) endRound('time');
  }

  io.emit('state', snapshot());
}

/* -------------------------------- 스냅샷 전송 ------------------------------- */

/** 대역폭을 아끼기 위해 단어는 배열 형태로 압축해서 보낸다. */
function snapshot() {
  const words = [];
  for (const w of state.words.values()) {
    words.push([
      w.id, w.text,
      Math.round(w.x * 1000) / 1000, Math.round(w.y * 1000) / 1000,
      w.custom ? 1 : 0, w.bonus ? 1 : 0,
    ]);
  }

  const now = Date.now();
  const mode = inputMode(now);
  return {
    phase: state.phase,
    words,
    scores: state.scores,
    lives: state.lives,
    maxLives: START_LIVES,
    playerCount: state.players.size,
    remainMs: state.phase === 'playing'
      ? Math.max(0, roundMs() - (now - state.startedAt))
      : 0,
    // 입력 모드 — 항상 타이핑. (하위 호환을 위해 필드는 유지)
    mode: state.phase === 'playing' ? mode.mode : null,
    modeRemainMs: mode.remainMs,
    restartInMs: 0,   // 자동 재시작 없음 — 버튼으로만 시작한다

  };
}

function rankedPlayers() {
  return [...state.players.values()]
    .sort((a, b) => b.score - a.score || b.hits - a.hits)
    .map((p) => {
      const s = statsOf(p);
      return {
        id: p.id,
        nick: p.nick,
        team: p.team,
        score: p.score,
        hits: p.hits,
        bestCombo: p.bestCombo,
        cpm: s.cpm,
        accuracy: s.accuracy,
      };
    });
}

function roster() {
  return { players: rankedPlayers(), counts: teamCounts() };
}

/* ---------------------------------- 시작 ---------------------------------- */

function attach(ioServer) {
  io = ioServer;
  if (loopTimer) clearInterval(loopTimer);
  loopTimer = setInterval(tick, TICK_MS);
}

module.exports = {
  state,
  attach,
  addPlayer,
  removePlayer,
  renamePlayer,
  switchTeam,
  setTeam,
  submitWord,
  queueCustomWord,
  restartRound,
  snapshot,
  roster,
  rankedPlayers,
};
