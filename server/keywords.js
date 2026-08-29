/*
 * 단어 테마(그룹) 관리.
 * 테마를 선택하면 떨어지는 단어가 그 테마의 목록에서만 나온다.
 * 선택하지 않으면(기본) 기존의 난이도 진행형 단어(words.js)를 쓴다.
 * 변경 사항은 keywords.json에 저장되어 서버를 재시작해도 유지된다.
 */
const fs = require('fs');
const path = require('path');
const { randomWord } = require('./words');

const FILE = path.join(__dirname, 'keywords.json');

const DEFAULT_THEMES = [
  {
    name: '자연',
    builtin: true,
    words: [
      '바다', '구름', '노을', '햇살', '바람', '나무', '별빛', '계곡',
      '폭포', '무지개', '소나기', '은하수', '단풍잎', '진달래', '민들레', '솔방울',
      '아지랑이', '이슬비', '산들바람', '보름달', '갯벌', '숲길', '들꽃', '냇물',
    ],
  },
  {
    name: '곤충',
    builtin: true,
    words: [
      '나비', '개미', '꿀벌', '매미', '잠자리', '무당벌레', '사마귀', '메뚜기',
      '귀뚜라미', '풍뎅이', '하늘소', '반딧불이', '장수풍뎅이', '사슴벌레', '여치', '베짱이',
      '소금쟁이', '물방개', '호랑나비', '쇠똥구리', '애벌레', '번데기',
    ],
  },
  {
    name: '예절',
    builtin: true,
    words: [
      '안녕하세요', '감사합니다', '죄송합니다', '실례합니다', '고맙습니다', '괜찮아요',
      '부탁드려요', '수고하셨어요', '어서오세요', '안녕히가세요', '잘먹겠습니다', '잘먹었습니다',
      '축하합니다', '환영합니다', '사랑합니다', '반갑습니다', '조심히가세요', '많이드세요',
    ],
  },
];

// 게임 설정 — 단어 양·낙하 속도 배율(1 = 기본)과 라운드 시간(초)
const DEFAULT_SETTINGS = { amount: 1, speed: 1, roundSec: 150 };

let themes = [];
let activeTheme = null;   // null이면 기본 단어(난이도 진행형)
let settings = { ...DEFAULT_SETTINGS };

function save() {
  fs.writeFileSync(FILE, JSON.stringify({ active: activeTheme, settings, themes }, null, 2));
}

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    themes = Array.isArray(saved.themes) ? saved.themes : [];
    activeTheme = saved.active || null;
    settings = { ...DEFAULT_SETTINGS, ...(saved.settings || {}) };
    // 기본 테마가 파일에서 빠졌으면 복원한다.
    for (const def of DEFAULT_THEMES) {
      if (!themes.some((t) => t.name === def.name)) {
        themes.push({ ...def, words: [...def.words] });
      }
    }
  } catch {
    themes = DEFAULT_THEMES.map((t) => ({ ...t, words: [...t.words] }));
    activeTheme = null;
    settings = { ...DEFAULT_SETTINGS };
    save();
  }
}

function getSettings() {
  return settings;
}

function setSettings(raw) {
  const clamp = (v, lo, hi, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
  };
  settings = {
    amount: clamp(raw?.amount, 0.3, 2, settings.amount),
    speed: clamp(raw?.speed, 0.5, 2, settings.speed),
    roundSec: Math.round(clamp(raw?.roundSec, 30, 600, settings.roundSec)),
  };
  save();
  return { ok: true, settings };
}

function findTheme(name) {
  return themes.find((t) => t.name === name) || null;
}

function cleanWord(raw) {
  return String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

function list() {
  return { active: activeTheme, themes, settings };
}

function createTheme(rawName, rawWords) {
  const name = cleanWord(rawName).slice(0, 10);
  if (!name) return { ok: false, error: '테마 이름을 입력해 주세요' };
  if (findTheme(name)) return { ok: false, error: '이미 있는 테마입니다' };
  if (themes.length >= 30) return { ok: false, error: '테마는 30개까지 만들 수 있습니다' };

  const words = [...new Set((rawWords || []).map(cleanWord).filter(Boolean))].slice(0, 200);
  themes.push({ name, builtin: false, words });
  save();
  return { ok: true, name };
}

function addWords(name, rawWords) {
  const theme = findTheme(name);
  if (!theme) return { ok: false, error: '테마가 없습니다' };

  const words = (rawWords || []).map(cleanWord).filter(Boolean);
  let added = 0;
  for (const w of words) {
    if (theme.words.length >= 200) break;
    if (!theme.words.includes(w)) { theme.words.push(w); added += 1; }
  }
  save();
  return { ok: true, added };
}

function removeWord(name, word) {
  const theme = findTheme(name);
  if (!theme) return { ok: false, error: '테마가 없습니다' };
  theme.words = theme.words.filter((w) => w !== word);
  save();
  return { ok: true };
}

function deleteTheme(name) {
  const theme = findTheme(name);
  if (!theme) return { ok: false, error: '테마가 없습니다' };
  if (theme.builtin) return { ok: false, error: '기본 테마는 지울 수 없습니다' };
  themes = themes.filter((t) => t !== theme);
  if (activeTheme === name) activeTheme = null;
  save();
  return { ok: true };
}

function setActive(name) {
  if (!name) { activeTheme = null; save(); return { ok: true, active: null }; }

  const theme = findTheme(name);
  if (!theme) return { ok: false, error: '테마가 없습니다' };
  if (!theme.words.length) return { ok: false, error: '단어가 없는 테마입니다. 단어를 먼저 추가해 주세요' };
  activeTheme = name;
  save();
  return { ok: true, active: name };
}

/** 게임이 새 단어를 뽑을 때 부른다. */
function pickWord(elapsedSec) {
  const theme = activeTheme ? findTheme(activeTheme) : null;
  if (theme && theme.words.length) {
    return theme.words[Math.floor(Math.random() * theme.words.length)];
  }
  return randomWord(elapsedSec);
}

load();

module.exports = {
  list, createTheme, addWords, removeWord, deleteTheme, setActive, pickWord,
  getSettings, setSettings,
};
