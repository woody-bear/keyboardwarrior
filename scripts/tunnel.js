#!/usr/bin/env node
/*
 * 게임 서버 + Cloudflare 임시 터널을 한 번에 띄운다.
 * 발급된 https://xxx.trycloudflare.com 주소를 서버에 알려주면
 * PC 화면의 QR과 공유 링크가 그 주소로 바뀐다.
 *
 * 자체 서명 인증서 경고 없이, 다른 네트워크(LTE)에서도 참여할 수 있다.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = path.join(__dirname, '..');

/*
 * ~/.cloudflared/config.yml 에 기존 named 터널의 ingress 규칙이 있으면
 * quick 터널에도 그 규칙이 병합되어 모든 요청이 마지막 http_status:404로 떨어진다.
 * 그래서 이 스크립트 전용의 최소 설정 파일을 만들어 --config 로 격리한다.
 * (사용자가 이미 돌리고 있는 터널에는 전혀 영향을 주지 않는다)
 */
function isolatedConfig() {
  const file = path.join(os.tmpdir(), 'drop-words-cloudflared.yml');
  fs.writeFileSync(file, 'no-autoupdate: true\nprotocol: http2\nedge-ip-version: "4"\n');
  return file;
}

const children = [];

function shutdown(code = 0) {
  for (const c of children) { try { c.kill('SIGTERM'); } catch { /* 이미 종료됨 */ } }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

/* --------------------------------- 서버 --------------------------------- */

const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) },
});
children.push(server);

server.on('exit', (code) => {
  console.error(`\n서버가 종료되었습니다 (code ${code})`);
  shutdown(code || 0);
});

/** 서버가 뜰 때까지 기다린다. */
function waitForServer(attempt = 0) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/healthz', timeout: 1000 }, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', () => {
      if (attempt > 40) return reject(new Error('서버 시작 실패'));
      setTimeout(() => waitForServer(attempt + 1).then(resolve, reject), 250);
    });
    req.on('timeout', () => req.destroy());
  });
}

/* --------------------------------- 터널 --------------------------------- */

function publish(url) {
  const body = JSON.stringify({ url });
  const req = http.request(
    {
      host: '127.0.0.1',
      port: PORT,
      path: '/api/public-url',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    },
    (res) => {
      res.resume();
      if (res.statusCode === 200) {
        console.log('');
        console.log('  ✅ 참여 링크가 준비되었습니다 (인증서 경고 없음)');
        console.log(`     ${url}`);
        console.log('     PC 화면의 QR도 이 주소로 바뀌었습니다.');
        console.log('');
      } else {
        console.error(`  주소 갱신 실패 (HTTP ${res.statusCode})`);
      }
    },
  );
  req.on('error', (e) => console.error('  주소 갱신 실패:', e.message));
  req.end(body);
}

waitForServer()
  .then(() => {
    console.log('  ▸ Cloudflare 터널을 여는 중…');

    // 터널은 평문 HTTP 쪽으로 붙인다(자체 서명 인증서 검증 회피).
    const tunnel = spawn('cloudflared', [
      '--config', isolatedConfig(),
      'tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`,
    ]);
    children.push(tunnel);

    let published = false;
    const scan = (buf) => {
      const text = buf.toString();

      // cloudflared 진단 메시지는 그대로 보여준다 (오류를 삼키면 원인을 못 찾는다).
      for (const line of text.split('\n')) {
        if (/ERR |error|failed|Failed/.test(line)) console.error(`  [cloudflared] ${line.trim()}`);
      }

      const found = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
      if (found && !published) {
        published = true;
        publish(found[0]);
      }
    };

    tunnel.stdout.on('data', scan);
    tunnel.stderr.on('data', scan);   // cloudflared는 주소를 stderr로 출력한다

    tunnel.on('error', (e) => {
      console.error('\ncloudflared 실행 실패:', e.message);
      console.error('설치: brew install cloudflared');
      shutdown(1);
    });

    tunnel.on('exit', (code) => {
      if (code !== 0) console.error(`\n터널이 종료되었습니다 (code ${code})`);
      shutdown(code || 0);
    });
  })
  .catch((e) => {
    console.error(e.message);
    shutdown(1);
  });
