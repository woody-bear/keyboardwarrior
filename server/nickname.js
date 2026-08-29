// 로그인 없이 참여하므로 서버가 닉네임을 자동 생성한다.
const ADJECTIVES = [
  '날쌘', '조용한', '무서운', '엉뚱한', '용맹한', '게으른', '눈부신', '수상한',
  '따끔한', '든든한', '재빠른', '고요한', '치명적인', '푸른', '붉은', '거대한',
  '자유로운', '반짝이는', '깜찍한', '단단한', '뜨거운', '차가운', '유쾌한', '전설의',
];

const NOUNS = [
  '타자기', '독수리', '고양이', '판다', '치타', '늑대', '여우', '두더지',
  '키보드', '커서', '코알라', '수달', '문어', '햄스터', '펭귄', '올빼미',
  '알파카', '해달', '표범', '기린', '상어', '나무늘보', '다람쥐', '까마귀',
];

const used = new Set();

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** 현재 접속자와 겹치지 않는 닉네임을 만든다. */
function generateNickname() {
  for (let i = 0; i < 40; i += 1) {
    const nick = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (!used.has(nick)) {
      used.add(nick);
      return nick;
    }
  }
  // 충돌이 계속되면 숫자를 붙여 유일성을 보장한다.
  const nick = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${Math.floor(Math.random() * 900) + 100}`;
  used.add(nick);
  return nick;
}

function releaseNickname(nick) {
  used.delete(nick);
}

module.exports = { generateNickname, releaseNickname };
