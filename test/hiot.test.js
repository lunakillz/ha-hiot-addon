import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import test from 'node:test';

import {
  decryptHiotSeedString,
  encryptHiotSeedString,
  ENCRYPTED_APP_CONSTANTS,
} from '../src/kisa-seed.js';
import {
  HiotClient,
  SESSION_EXPIRED_CODE,
  formatKstTimestamp,
} from '../src/hiot-client.js';
import { runCli } from '../hiot-cli.js';
import { PassThrough } from 'node:stream';

test('KISA_SEED_ECB decrypts all APK Settings & HCard server constants accurately', () => {
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.SERVER_CONTEXT),
    'https://home.hiot.autoever.com:8443'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.DEV_H_SERVER_CONTEXT),
    'https://qa-home.hiot.autoever.com:8443'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.REAL_VOICE_HOME_SERVER_CONTEXT),
    'https://voicehome.autoever.com'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.REAL_DEVICE_AUTH_HOST),
    'interface.hiot.autoever.com'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.REAL_DEVICE_AUTH_HOST2),
    'home.hiot.autoever.com'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.REAL_DEVICE_AUTH_HOST3),
    'home.hiot.hdec.kr'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.REAL_DEVICE_AUTH_HOST4),
    'interface.hiot.hdec.kr'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.DEV_H_CARD_DOMAIN),
    'devhiotbiz.bluewalnut.co.kr'
  );
  assert.equal(
    decryptHiotSeedString(ENCRYPTED_APP_CONSTANTS.REAL_H_CARD_DOMAIN),
    'hiotbiz.bluewalnut.co.kr'
  );

  for (let idx = 0; idx < 10; idx++) {
    const sample = `https://example-${idx}.hiot.autoever.com/test`;
    const enc = encryptHiotSeedString(sample, idx);
    assert.equal(decryptHiotSeedString(enc), sample);
  }
});

test('formatKstTimestamp formats UTC dates into yyyyMMddHHmmss KST (+09:00)', () => {
  const utc = new Date('2026-11-04T14:05:09Z');
  assert.equal(formatKstTimestamp(utc), '20261104230509');
});

test('HiotClient login, cookie persistence, auto-relogin on smarthome.error.auth.00001, and VoiceHome 2-step control', async (t) => {
  const recordedRequests = [];
  let expireNextDeviceCall = true;

  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const bodyText = Buffer.concat(chunks).toString('utf8');
    const jsonBody = bodyText ? JSON.parse(bodyText) : null;

    recordedRequests.push({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: jsonBody,
    });

    if (req.url === '/hiot-web/login/exelogin') {
      const cond = jsonBody?.condition ?? {};
      if (cond.passwordvalu === 'wrong-pw') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            login: [
              {
                errorcode: 'smarthome.error.auth.00004',
                errormessage: 'ID 또는 패스워드를 확인하세요.',
              },
            ],
          })
        );
        return;
      }
      if (cond.passwordvalu === 'my-secret-pw') {
        res.setHeader('Set-Cookie', ['JSESSIONID=sess_initial; Path=/; HttpOnly', 'HIOT_TKN=abc1; Path=/']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            errorcode: '',
            errormessage: '',
            login: [
              {
                userid: cond.userid,
                usernm: '홍길동',
                userkeyvalu: 'ukey_refresh_999',
                clientid: req.headers['x-hiot-clientid'],
                complexnm: '힐스테이트',
                buildingno: '101',
                householdno: '1201',
                householdcd: 'HH001',
                screenlockyn: 'Y',
              },
            ],
            complex: [{ complextitlenm: '힐스테이트', voicesupportyn: 'Y' }],
            smartmodelist: [{ modecd: 'MODE_OUTING', conditioncd: 'OUT' }],
          })
        );
        return;
      }

      if (cond.userkeyvalu === 'ukey_refresh_999') {
        res.setHeader('Set-Cookie', ['JSESSIONID=sess_refreshed; Path=/; HttpOnly']);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            errorcode: '',
            login: [{ userid: cond.userid, userkeyvalu: 'ukey_refresh_999' }],
          })
        );
        return;
      }
    }

    if (req.url === '/hiot-web/login/exeunlockingscreen') {
      res.setHeader('Set-Cookie', ['PIN_VERIFIED=Y; Path=/']);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errorcode: '', verified: [{ isverified: 'Y' }] }));
      return;
    }

    if (req.url === '/hiot-web/device/getdevicelist') {
      if (expireNextDeviceCall) {
        expireNextDeviceCall = false;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            errorcode: SESSION_EXPIRED_CODE,
            errormessage: 'Session expired',
          })
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          errorcode: '',
          device: [{ devicecd: 'DEV_LIGHT_01', devicenm: '거실 조명 1', spacenm: '거실' }],
        })
      );
      return;
    }

    if (req.url === '/voicehome/cvs/request') {
      const recogText = jsonBody?.HAEvhReq?.[0]?.recogText;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          HAEvhRes: [
            {
              messageType: 'conversation',
              result: `${recogText} 제어를 실행합니다.`,
              intentType: 'iot_control',
              isFindIntention: 'true',
              addControlRequest: 'true',
              serviceID: 'SVC_LIVING_LIGHT_ON_001',
              viewType: 'light',
              viewTypeData: { space: '거실', deviceName: '조명', value: 'ON' },
            },
          ],
        })
      );
      return;
    }

    if (req.url === '/voicehome/device/control') {
      const svcId = jsonBody?.HAEvhReq?.[0]?.serviceID;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          HAEvhRes: [
            {
              messageType: 'device',
              result: 'SUCCESS',
              serviceID: svcId,
              timestamp: '20261104231500',
            },
          ],
        })
      );
      return;
    }

    if (req.url === '/hiot-web/mode/exemode') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          errorcode: '',
          result: [{ resultcd: 0, resultmsg: 'OK' }],
        })
      );
      return;
    }

    if (req.url === '/hiot-web/space/getspacelist') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          errorcode: '',
          spacelist: [
            { spacesq: 101, spacenm: '거실' },
            { spacesq: 102, spacenm: '침실1' },
          ],
        })
      );
      return;
    }

    if (req.url === '/hiot-web/space/getspace') {
      const sq = jsonBody?.condition?.spacesq;
      const spaceDevices =
        sq === 101
          ? [
              { devicecd: 'LGT_01', devicenm: '거실1', devicetypecd: 'LGT', attributevalu: 'on' },
              { devicecd: 'LGT_02', devicenm: '거실2', devicetypecd: 'LGT', attributevalu: 'on' },
            ]
          : [
              { devicecd: 'LGT_03', devicenm: '침실1-1', devicetypecd: 'LGT', attributevalu: 'off' },
            ];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errorcode: '', space: spaceDevices }));
      return;
    }

    if (req.url === '/hiot-web/device/exedevicebatch') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errorcode: '', result: [{ resultcd: 0, resultmsg: 'OK' }] }));
      return;
    }

    if (req.url === '/hiot-app/hiot/contents/control/space/HD-KMA-31-01.jsp') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        '<html><script>$.post("/hiot-web/control/homedevice.json"); location.href="/hiot-app/hiot/contents/control/space/HD-KMA-34-00.jsp";</script></html>'
      );
      return;
    }

    res.writeHead(404);
    res.end('{}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hiot-test-'));
  t.after(() => fs.rm(tmpDir, { recursive: true, force: true }));
  const sessionFile = path.join(tmpDir, '.hiot-session.json');

  const client = new HiotClient({
    mainServerUrl: baseUrl,
    voiceHomeServerUrl: baseUrl,
    sessionFile,
    reloginRetryDelayMs: 10,
  });

  // 0. HTTP 200 nested login[0].errorcode (smarthome.error.auth.00004) must throw HiotApiError
  await assert.rejects(
    () => client.login({ userId: 'tester01', password: 'wrong-pw' }),
    (err) => err.code === 'smarthome.error.auth.00004' && /패스워드/.test(err.message)
  );
  assert.equal(client.state.userKeyValu, null);

  // 1. Login + automatic PIN unlock
  await client.login({ userId: 'tester01', password: 'my-secret-pw', pin: '1234' });
  assert.equal(client.state.userKeyValu, 'ukey_refresh_999');
  assert.equal(client.state.cookies.JSESSIONID, 'sess_initial');
  assert.equal(client.state.cookies.PIN_VERIFIED, 'Y');

  // Verify session reloads from disk
  const reloaded = new HiotClient({
    mainServerUrl: baseUrl,
    voiceHomeServerUrl: baseUrl,
    sessionFile,
    reloginRetryDelayMs: 10,
  });
  assert.equal(await reloaded.loadSession(), true);
  assert.equal(reloaded.state.clientId, client.state.clientId);

  // 2. Expired session auto-relogin + retry
  const devicesRes = await reloaded.getDevices();
  assert.equal(devicesRes.device[0].devicecd, 'DEV_LIGHT_01');
  assert.equal(reloaded.state.cookies.JSESSIONID, 'sess_refreshed');

  // 3-A. VoiceHome 2-step home control ("거실 조명 켜줘")
  const voiceRes = await reloaded.voiceCommand('거실 조명 켜줘', { autoControl: true });
  assert.equal(voiceRes.needsControl, true);
  assert.equal(voiceRes.executedControl, true);
  assert.equal(voiceRes.control.result, 'SUCCESS');
  assert.equal(voiceRes.intent.serviceID, 'SVC_LIVING_LIGHT_ON_001');

  // Verify headers sent to VoiceHome match AddCookiesInterceptor
  const cvsCall = recordedRequests.find((r) => r.url === '/voicehome/cvs/request');
  assert.equal(cvsCall.headers['x-hiot-clientid'], reloaded.state.clientId);
  assert.equal(cvsCall.headers.clientkey, reloaded.state.clientId);
  assert.match(cvsCall.headers.cookie, /JSESSIONID=sess_refreshed/);

  // 3-B. Native space/device batch REST control (listLights & setLight)
  const lights = await reloaded.listLights();
  assert.equal(lights.length, 3);
  const controlRes = await reloaded.setLight('거실', false);
  assert.equal(controlRes.kind, 'control');
  assert.equal(controlRes.targets.length, 2);
  assert.equal(controlRes.commands[0].value, 'off');

  // 4. Smart Mode & WebView controller inspector
  const modeRes = await reloaded.executeSmartMode('MODE_OUTING');
  assert.equal(modeRes.result[0].resultmsg, 'OK');

  const pageInfo = await reloaded.fetchControllerPage('space');
  assert.deepEqual(pageInfo.discoveredEndpoints, [
    '/hiot-app/hiot/contents/control/space/HD-KMA-34-00.jsp',
    '/hiot-web/control/homedevice.json',
  ]);

  // 5. Interactive CLI menu: Login ([1]) -> Light Control ([3]) -> SmartMode ([7]) -> Exit ([0])
  const cliSessionFile = path.join(tmpDir, '.cli-session.json');
  const mockIn = new PassThrough();
  const mockOut = new PassThrough();
  let cliOutput = '';
  mockOut.on('data', (chunk) => {
    cliOutput += chunk.toString('utf8');
  });

  // Sequence of interactive inputs:
  // '1' (login menu) -> 'tester01' -> 'my-secret-pw' -> '1234' (PIN)
  // '3' (light menu) -> '거실' -> 'on'
  // '7' (smart mode) -> '1' (select MODE_OUTING)
  // '0' (exit)
  mockIn.end(['1', 'tester01', 'my-secret-pw', '1234', '3', '거실', 'on', '7', '1', '0'].join('\n') + '\n');

  await runCli(
    ['menu', '--session', cliSessionFile, '--server', baseUrl, '--voice-server', baseUrl],
    { input: mockIn, output: mockOut, interactive: true }
  );

  assert.match(cliOutput, /로그인 성공: 홍길동/);
  assert.match(cliOutput, /\[기기 제어\] 조명 켜기 완료/);
  assert.match(cliOutput, /거실1/);
  assert.match(cliOutput, /\[스마트모드 실행 결과\]/);
});
