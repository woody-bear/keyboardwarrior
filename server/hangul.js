/*
 * 한글 타수 계산.
 * 한컴타자처럼 "몇 번 키를 눌렀는가"를 세기 위해 음절을 자모로 분해한다.
 * 두벌식 기준으로 겹모음(ㅘ)·겹받침(ㄳ)은 2타, 된소리(ㄲ)는 Shift 조합이라 1타로 본다.
 */

const BASE = 0xac00;
const LAST = 0xd7a3;

// 중성 21개 중 두 번 눌러야 하는 겹모음
const COMPOUND_JUNG = new Set([9, 10, 11, 14, 15, 16, 19]);   // ㅘㅙㅚㅝㅞㅟㅢ

// 종성 28개 중 두 번 눌러야 하는 겹받침 (인덱스 0은 받침 없음)
const COMPOUND_JONG = new Set([3, 5, 6, 9, 10, 11, 12, 13, 14, 15, 18]);

/** 글자 하나의 타수 */
function strokesOfChar(ch) {
  const code = ch.codePointAt(0);

  if (code >= BASE && code <= LAST) {
    const index = code - BASE;
    const jong = index % 28;
    const jung = Math.floor((index % 588) / 28);

    let strokes = 1;                                   // 초성
    strokes += COMPOUND_JUNG.has(jung) ? 2 : 1;        // 중성
    if (jong > 0) strokes += COMPOUND_JONG.has(jong) ? 2 : 1;
    return strokes;
  }

  // 낱자로 온 자모(ㄱ, ㅏ 등)와 영문·숫자·공백은 1타로 센다.
  return 1;
}

/** 문자열 전체의 타수 */
function countStrokes(text) {
  let total = 0;
  for (const ch of String(text || '')) total += strokesOfChar(ch);
  return total;
}

module.exports = { countStrokes, strokesOfChar };
