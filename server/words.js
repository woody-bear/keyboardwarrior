/*
 * 난이도 단계별 문제 풀.
 * 한컴타자의 자리 → 낱말 → 단문 흐름을 따라, 라운드가 진행될수록
 * 짧은 낱말에서 긴 낱말, 짧은 문장으로 넘어간다.
 */

// 1단계 — 짧은 낱말 (2~3글자)
const SHORT = [
  '사과', '바다', '구름', '노을', '햇살', '바람', '나무', '별빛',
  '고래', '펭귄', '여우', '수달', '문어', '판다', '치타', '늑대',
  '커피', '우산', '기차', '연필', '지도', '거울', '모래', '등대',
  '토끼', '참새', '메아리', '고양이', '강아지', '호랑이', '다람쥐', '거북이',
];

// 2단계 — 보통 낱말 (3~5글자)
const NORMAL = [
  '키보드', '모니터', '마우스', '스피커', '노트북', '이어폰', '충전기', '카메라',
  '자전거', '기차역', '비행기', '운동화', '손목시계', '커피잔', '도서관', '우주선',
  '개발자', '프로그램', '알고리즘', '네트워크', '데이터베이스', '브라우저', '터미널', '서버실',
  '떡볶이', '김치찌개', '아메리카노', '초콜릿', '아이스크림', '샌드위치', '팬케이크', '스파게티',
  '반짝반짝', '두근두근', '알쏭달쏭', '오순도순', '티격태격', '싱글벙글',
];

// 3단계 — 짧은 문장 (한컴타자의 '단문' 연습에 해당)
const SENTENCE = [
  '오늘도 좋은 하루',
  '천 리 길도 한 걸음부터',
  '바다는 늘 그 자리에',
  '커피 한 잔의 여유',
  '노력은 배신하지 않는다',
  '작은 습관이 큰 변화를',
  '느려도 꾸준하게',
  '봄바람이 불어온다',
  '별이 빛나는 밤에',
  '함께라서 더 즐겁다',
  '손끝으로 전하는 마음',
  '내일은 내일의 해가',
  '가벼운 마음으로 시작',
  '조금씩 앞으로 나아가',
];

const TIERS = [
  { name: 'short', pool: SHORT },
  { name: 'normal', pool: NORMAL },
  { name: 'sentence', pool: SENTENCE },
];

/**
 * 경과 시간에 따라 단계를 섞어서 고른다.
 * 초반에는 짧은 낱말만, 중반부터 보통 낱말, 후반에는 단문이 섞인다.
 */
function pickPool(elapsedSec) {
  const r = Math.random();

  if (elapsedSec < 35) {
    return r < 0.8 ? SHORT : NORMAL;
  }
  if (elapsedSec < 80) {
    return r < 0.35 ? SHORT : NORMAL;
  }
  // 후반 — 단문이 등장한다
  if (r < 0.2) return SHORT;
  if (r < 0.75) return NORMAL;
  return SENTENCE;
}

function randomWord(elapsedSec = 0) {
  const pool = pickPool(elapsedSec);
  return pool[Math.floor(Math.random() * pool.length)];
}

module.exports = { randomWord, TIERS, SHORT, NORMAL, SENTENCE };
