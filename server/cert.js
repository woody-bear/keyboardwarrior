const fs = require('fs');
const os = require('os');
const path = require('path');
const selfsigned = require('selfsigned');

const DIR = path.join(__dirname, '..', '.certs');
const KEY = path.join(DIR, 'key.pem');
const CRT = path.join(DIR, 'cert.pem');

/** 이 PC가 가진 모든 IPv4 주소 (인증서 SAN에 넣어 준다) */
function localAddresses() {
  const list = ['127.0.0.1'];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const net of iface || []) {
      if (net.family === 'IPv4' && !net.internal) list.push(net.address);
    }
  }
  return [...new Set(list)];
}

/*
 * 일부 브라우저(Brave 등)는 http:// 주소를 https:// 로 자동 승격한다.
 * 평문 HTTP만 열어두면 TLS 핸드셰이크가 깨져 ERR_SSL_PROTOCOL_ERROR가 나므로,
 * LAN 접속용 자체 서명 인증서를 만들어 HTTPS 요청도 받아준다.
 * (자체 서명이라 첫 접속에 경고가 뜬다. 경고 없는 접속은 npm run tunnel 사용)
 */
async function ensureCert() {
  try {
    if (fs.existsSync(KEY) && fs.existsSync(CRT)) {
      return { key: fs.readFileSync(KEY), cert: fs.readFileSync(CRT) };
    }
  } catch { /* 캐시를 못 읽으면 새로 만든다 */ }

  const altNames = [
    { type: 2, value: 'localhost' },
    ...localAddresses().map((ip) => ({ type: 7, ip })),
  ];

  // selfsigned v5의 generate()는 Promise를 반환한다.
  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'Team Drop Words' }],
    { days: 365, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames }] },
  );

  if (!pems || !pems.private || !pems.cert) throw new Error('자체 서명 인증서 생성 실패');

  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(KEY, pems.private);
    fs.writeFileSync(CRT, pems.cert);
  } catch { /* 디스크에 못 써도 메모리 인증서로 동작한다 */ }

  return { key: pems.private, cert: pems.cert };
}

module.exports = { ensureCert, localAddresses };
