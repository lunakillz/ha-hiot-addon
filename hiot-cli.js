#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  HiotClient,
  HiotApiError,
  WEB_CONTROLLER_PAGES,
  SUPPORTED_VOICE_DEVICE_TYPES,
  DEVICE_TYPE_NAMES,
  LIGHT_DEVICE_TYPES,
} from './src/hiot-client.js';
import { CliPrompter } from './src/cli-prompt.js';

const HELP_TEXT = `
Hi-oT Smart Home CLI (Hyundai AutoEver Hillstate v1.0.101 호환 클라이언트)

사용법:
  .\\hiot                              대화형 로그인 및 집안 기기 제어 메뉴 실행
  .\\hiot <명령> [인자...] [옵션]      단일 명령 즉시 실행 (node hiot-cli.js ... 동일)

[대화형 콘솔]
  menu (또는 인자 없이 실행)    번호 선택 방식의 대화형 로그인 & 기기 제어 콘솔 실행

[인증 및 세션 명령]
  login                         대화형 아이디/비밀번호 입력 로그인 (.hiot-session.json 저장)
                                옵션 생략 시 터미널에서 안전하게 비밀번호 마스킹 입력
                                (옵션 지정 시: --id <ID> --pw <PW> [--pin <잠금번호>])
  unlock [--pin <PIN>]          앱 화면잠금(PIN) 번호 인증 (/hiot-web/login/exeunlockingscreen)
  relogin                       저장된 userkeyvalu 토큰으로 세션 쿠키 수동 갱신
  whoami                        저장된 로그인 세대 정보 및 스마트모드 목록 확인
  logout                        서버 로그아웃 및 로컬 세션 파일 삭제

[집안 기기 제어 및 목록 명령]
  lights [공간]                 조명 목록 및 상태 조회 (예: .\\hiot lights, .\\hiot lights 거실)
  light <공간|기기명> <on|off>  조명 켜기/끄기       (예: .\\hiot light 거실 off, .\\hiot light 거실1 on)
  heat <공간> <on|off|온도>     난방 켜기/끄기/온도  (예: .\\hiot heat 안방 24)
  ac <공간> <on|off|온도>       에어컨 제어          (예: .\\hiot ac 거실 25)
  outlet <공간|기기명> <on|off> 전열콘센트 제어      (예: .\\hiot outlet 거실 on)
  gas-lock                      가스밸브 잠그기      (예: .\\hiot gas-lock)
  vent <on|off> [공간]          환기 켜기/끄기       (예: .\\hiot vent on)
  elevator                      엘리베이터 호출하기  (예: .\\hiot elevator)
  home-status [대상]            상태 조회            (예: .\\hiot home-status "거실 조명")
  cmd <자연어명령> [--dry-run]  자유 한국어 명령 제어 (예: .\\hiot cmd "전체 조명 꺼줘")
  service-exec <serviceID>      VoiceHome serviceID로 직접 제어 실행

[홈넷 / 기기 / 스마트모드 REST API 명령]
  spaces                        세대 공간 목록 조회 (/hiot-web/space/getspacelist)
  services [카테고리]           단지 지원 홈넷 서비스 목록 조회 (기본: 홈넷 전체 + LVNG)
  devices [devicetypecd]        세대 전체 등록 기기 목록 조회 (LGT, HTR, ACB, WSK 등)
  device <devicecd>             특정 기기 상세 상태 조회 (/hiot-web/device/getdevice)
  device-exec <devicecd> [res]  기기 직접 제어 (/hiot-web/device/exedevice, --config JSON)
  modes                         저장된 스마트모드 목록 보기
  mode-exec <modecd> [--dst]    스마트모드 실행 (/hiot-web/mode/exemode)
  web-fetch <대상> [--html]     인증 세션으로 제어 WebView JSP 조회 및 내부 AJAX 경로 추출
                                대상: ${Object.keys(WEB_CONTROLLER_PAGES).join(' | ')}
  bridge                        Home Assistant 연동 MQTT 브릿지 & 웹 대시보드 서버 실행 (포트 8099)

[공통 옵션]
  --session <경로>              세션 파일 경로 (기본값: ./.hiot-session.json)
  --qa                          운영 서버 대신 QA 서버(qa-home.hiot.autoever.com:8443) 사용
  --server <URL>                메인 API 서버 URL 직접 지정
  --voice-server <URL>          VoiceHome API 서버 URL 직접 지정
  --json                        결과를 원본 JSON 형태로 출력
  -h, --help                    도움말 출력

지원 기기 카테고리 (VoiceHome):
  ${SUPPORTED_VOICE_DEVICE_TYPES.join(', ')}
`.trim();

function parseOnOffOrTemp(val) {
  const normalized = String(val ?? '').trim().toLowerCase();
  if (['on', 'true', '켜', '켜기', '켜줘', '1'].includes(normalized)) {
    return { on: true };
  }
  if (['off', 'false', '꺼', '끄기', '꺼줘', '0'].includes(normalized)) {
    return { on: false };
  }
  const num = Number(normalized.replace(/도$/, ''));
  if (!Number.isNaN(num) && normalized !== '' && Number.isFinite(num)) {
    return { temperature: num };
  }
  throw new Error(`'${val}' 값을 해석할 수 없습니다. on, off 또는 숫자(희망온도)를 입력하세요.`);
}

function formatResultLines(res) {
  if (!res) return '';
  if (res.kind === 'control') {
    const lines = [];
    const action = res.commands?.[0]?.value === 'off' ? '끄기' : '켜기';
    lines.push(`  [기기 제어] ${res.label ?? '기기'} ${action} 완료 (대상: ${res.target})`);
    if (Array.isArray(res.targets) && res.targets.length > 0) {
      const names = res.targets
        .map((t) => `${t.devicenm || t.devicecd}${t.spacenm ? ` (${t.spacenm})` : ''}`)
        .join(', ');
      lines.push(`  [제어 대상] ${names}`);
    }
    if (Array.isArray(res.commands) && res.commands.length > 0) {
      const summary = res.commands
        .map((c) => `${c.devicecd}: ${c.resource}.${c.attribute}=${c.value}`)
        .join('; ');
      lines.push(`  [적용 명령] ${summary}`);
    }
    return lines.join('\n');
  }

  const lines = [];
  if (res.command) lines.push(`  [요청 명령] ${res.command}`);
  if (res.intent) {
    lines.push(`  [서버 응답] ${res.intent.result ?? '(메시지 없음)'}`);
    if (res.intent.intentType) lines.push(`  [의도 분류] ${res.intent.intentType}`);
    if (res.intent.serviceID) lines.push(`  [serviceID] ${res.intent.serviceID}`);
    if (res.intent.viewTypeData) {
      const cleanData = Object.fromEntries(
        Object.entries(res.intent.viewTypeData).filter(([, v]) => v !== null && v !== '')
      );
      if (Object.keys(cleanData).length > 0) {
        lines.push(`  [상세 상태] ${JSON.stringify(cleanData)}`);
      }
    }
  }
  if (res.needsControl) {
    if (res.executedControl) {
      lines.push(`  [제어 결과] 완료 (${res.control?.result ?? JSON.stringify(res.control)})`);
    } else {
      lines.push(`  [안내] --dry-run 모드로 실제 제어는 생략됨 (serviceID=${res.intent?.serviceID})`);
    }
  }
  return lines.join('\n');
}

const formatVoiceResultLines = formatResultLines;

function formatLightsTable(lights) {
  if (!Array.isArray(lights) || lights.length === 0) {
    return '  (조회된 조명이 없습니다)';
  }
  const lines = [];
  lines.push(`[조명 목록] 총 ${lights.length}개`);
  lines.push('------------------------------------------------------------');
  lines.push('공간      | 조명 이름    | 상태     | 기기 코드');
  lines.push('------------------------------------------------------------');
  for (const l of lights) {
    const space = (l.spacenm || '-').padEnd(8, ' ');
    const name = (l.devicenm || '-').padEnd(12, ' ');
    const status = l.attributevalu === 'on' ? 'ON 💡' : 'OFF 🌑';
    const code = l.devicecd;
    lines.push(`${space} | ${name} | ${status.padEnd(8, ' ')} | ${code}`);
  }
  lines.push('------------------------------------------------------------');
  return lines.join('\n');
}

function formatSessionBanner(client) {
  const info = client.state.loginInfo;
  if (!client.state.userId || !client.state.userKeyValu || !info) {
    return '[세션 상태] 미로그인 (로그인 후 집안 기기를 제어할 수 있습니다)';
  }
  const complex = info.complexnm ?? client.state.complexInfo?.complextitlenm ?? '단지정보없음';
  const dongHo =
    info.buildingno && info.householdno ? `${info.buildingno}동 ${info.householdno}호` : '';
  return `[세션 상태] ${info.usernm ?? info.userid} (${info.userid}) | ${complex} ${dongHo}`.trim();
}

/**
 * Interactive login workflow: prompts for missing ID, hidden password, and optional screen-lock PIN.
 */
async function performInteractiveLogin(client, prompter, opts = {}, writeLine = console.log) {
  let userId = opts.userId;
  let password = opts.password;
  let pin = opts.pin;

  if (!userId) {
    userId = await prompter.ask('Hi-oT 아이디', {
      defaultValue: client.state.userId || undefined,
    });
  }
  if (!password) {
    password = await prompter.askSecret('Hi-oT 비밀번호 (화면에 표시되지 않음)');
  }
  if (!userId || !password) {
    throw new Error('아이디와 비밀번호를 모두 입력해야 합니다.');
  }

  writeLine('서버에 로그인 요청 중...');
  const res = await client.login({ userId, password, pin });
  const info = client.state.loginInfo ?? {};

  // If account uses app screen lock PIN and PIN wasn't passed yet, offer interactive PIN unlock
  if (info.screenlockyn === 'Y' && !pin) {
    const inputPin = await prompter.askSecret(
      '앱 화면잠금(PIN) 설정 계정입니다. 잠금번호 입력 (건너뛰려면 Enter)'
    );
    if (inputPin) {
      await client.unlockScreen(inputPin);
      pin = inputPin;
    }
  }

  if (opts.jsonMode) {
    writeLine(JSON.stringify(res, null, 2));
  } else {
    writeLine(
      `\n로그인 성공: ${info.usernm ?? info.userid} (${info.complexnm ?? ''} ${info.buildingno ?? ''}동 ${info.householdno ?? ''}호)`
    );
    writeLine(`- clientId    : ${client.state.clientId}`);
    writeLine(`- householdcd : ${info.householdcd ?? '(없음)'}`);
    writeLine(`- 스마트모드  : ${client.state.smartModes.length}개 로드됨`);
    if (client.sessionFile) {
      writeLine(`- 세션 저장됨 : ${client.sessionFile}`);
    }
  }
  return res;
}

/**
 * Ensure user is logged in before running a control command.
 */
async function ensureAuthenticated(client, prompter, writeLine) {
  if (client.state.userId && client.state.userKeyValu) {
    return;
  }
  if (!prompter) {
    throw new Error(
      '저장된 로그인 세션이 없습니다. 먼저 `node hiot-cli.js login` 명령으로 로그인하세요.'
    );
  }
  const ok = await prompter.confirm('저장된 로그인 세션이 없습니다. 지금 로그인하시겠습니까?', true);
  if (!ok) {
    throw new Error('로그인이 취소되었습니다.');
  }
  await performInteractiveLogin(client, prompter, {}, writeLine);
}

/**
 * Helper to fetch household room names (or fall back to common Korean room names) for interactive selection.
 */
async function chooseSpaceName(client, prompter, writeLine, defaultRoom = '거실') {
  let spaces = [];
  try {
    const res = await client.getSpaces();
    if (Array.isArray(res?.spacelist)) {
      spaces = res.spacelist.map((s) => s.spacenm).filter(Boolean);
    }
  } catch {
    // Ignore space fetch errors and allow manual input
  }

  if (spaces.length > 0) {
    writeLine('\n[세대 공간 목록]');
    spaces.forEach((name, idx) => {
      writeLine(`  ${idx + 1}) ${name}`);
    });
    const raw = await prompter.ask('공간 번호 또는 공간명 직접 입력 (예: 거실, 안방, 전체)', {
      defaultValue: spaces[0] || defaultRoom,
    });
    const idx = Number(raw);
    if (Number.isInteger(idx) && idx >= 1 && idx <= spaces.length) {
      return spaces[idx - 1];
    }
    return raw;
  }

  return prompter.ask('제어할 공간명 입력 (예: 거실, 안방, 침실1, 전체)', {
    defaultValue: defaultRoom,
  });
}

/**
 * Interactive menu loop (`node hiot-cli.js` or `node hiot-cli.js menu`).
 */
async function runInteractiveMenu(client, prompter, writeLine) {
  writeLine('============================================================');
  writeLine('  Hi-oT Smart Home 대화형 제어 콘솔');
  writeLine('============================================================');

  while (true) {
    writeLine(`\n${formatSessionBanner(client)}`);
    writeLine('------------------------------------------------------------');
    writeLine('  [1] 로그인 / 계정 변경       [6] 가스밸브 / 환기 / 엘리베이터');
    writeLine('  [2] 집안 및 기기 상태 조회   [7] 스마트모드 조회 및 실행');
    writeLine('  [3] 조명 제어 (ON / OFF)     [8] 등록 기기 목록 및 직접 제어');
    writeLine('  [4] 난방 제어 (전원 / 온도)  [9] 한국어 자연어 연속 제어 모드');
    writeLine('  [5] 에어컨 제어 (전원 / 온도)[10] 로그아웃 (세션 삭제)');
    writeLine('  [0] 종료');
    writeLine('------------------------------------------------------------');

    const choice = (await prompter.ask('메뉴 번호 선택')).toLowerCase();
    if (!choice || choice === '0' || choice === 'q' || choice === 'exit') {
      writeLine('Hi-oT CLI를 종료합니다.');
      break;
    }

    try {
      switch (choice) {
        case '1': {
          await performInteractiveLogin(client, prompter, {}, writeLine);
          break;
        }

        case '2': {
          await ensureAuthenticated(client, prompter, writeLine);
          const target = await prompter.ask('상태를 조회할 대상 (예: 집안, 거실 조명, 안방 난방)', {
            defaultValue: '집안',
          });
          const res = await client.queryHomeStatus(target);
          writeLine('\n' + formatVoiceResultLines(res));
          break;
        }

        case '3': {
          await ensureAuthenticated(client, prompter, writeLine);
          try {
            const currentLights = await client.listLights();
            writeLine('\n' + formatLightsTable(currentLights));
          } catch {
            // Ignore if space/device listing fails
          }
          const space = await chooseSpaceName(client, prompter, writeLine, '거실');
          const stateStr = await prompter.ask(`${space} 조명 동작 (on=켜기 / off=끄기)`, {
            defaultValue: 'on',
          });
          const parsed = parseOnOffOrTemp(stateStr);
          if (parsed.on === undefined) {
            throw new Error('조명 동작은 on 또는 off로 입력하세요.');
          }
          const res = await client.setLight(space, parsed.on);
          writeLine('\n' + formatResultLines(res));
          break;
        }

        case '4': {
          await ensureAuthenticated(client, prompter, writeLine);
          const space = await chooseSpaceName(client, prompter, writeLine, '거실');
          const val = await prompter.ask(`${space} 난방 동작 (on / off / 희망온도 숫자 예: 24)`, {
            defaultValue: '24',
          });
          const res = await client.setHeating(space, parseOnOffOrTemp(val));
          writeLine('\n' + formatVoiceResultLines(res));
          break;
        }

        case '5': {
          await ensureAuthenticated(client, prompter, writeLine);
          const space = await chooseSpaceName(client, prompter, writeLine, '거실');
          const val = await prompter.ask(`${space} 에어컨 동작 (on / off / 희망온도 숫자 예: 25)`, {
            defaultValue: 'on',
          });
          const res = await client.setAirConditioner(space, parseOnOffOrTemp(val));
          writeLine('\n' + formatVoiceResultLines(res));
          break;
        }

        case '6': {
          await ensureAuthenticated(client, prompter, writeLine);
          writeLine('\n  1) 가스밸브 잠그기');
          writeLine('  2) 환기 켜기');
          writeLine('  3) 환기 끄기');
          writeLine('  4) 엘리베이터 호출하기');
          const sub = await prompter.ask('실행할 번호 선택', { defaultValue: '1' });
          let res;
          if (sub === '1') res = await client.closeGasValve();
          else if (sub === '2') res = await client.setVentilator(true);
          else if (sub === '3') res = await client.setVentilator(false);
          else if (sub === '4') res = await client.callElevator();
          else throw new Error('올바른 번호(1~4)를 선택하세요.');
          writeLine('\n' + formatVoiceResultLines(res));
          break;
        }

        case '7': {
          await ensureAuthenticated(client, prompter, writeLine);
          const modes = client.state.smartModes ?? [];
          if (modes.length > 0) {
            writeLine('\n[저장된 스마트모드 목록]');
            modes.forEach((m, idx) => {
              writeLine(
                `  ${idx + 1}) modecd=${m.modecd} (조건=${m.conditioncd ?? '-'}, 동작=${m.modeactiontypecd ?? '-'})`
              );
            });
          } else {
            writeLine('\n(로그인 응답에 저장된 스마트모드가 없습니다. modecd를 직접 입력할 수 있습니다.)');
          }
          const raw = await prompter.ask('실행할 번호 또는 modecd 입력 (취소하려면 Enter)');
          if (!raw) break;
          const idx = Number(raw);
          const modeCd =
            Number.isInteger(idx) && idx >= 1 && idx <= modes.length ? modes[idx - 1].modecd : raw;
          const res = await client.executeSmartMode(modeCd);
          writeLine(`\n[스마트모드 실행 결과] ${JSON.stringify(res)}`);
          break;
        }

        case '8': {
          await ensureAuthenticated(client, prompter, writeLine);
          const listRes = await client.getDevices('');
          const devices = Array.isArray(listRes?.device) ? listRes.device : [];
          if (devices.length === 0) {
            writeLine('\n조회된 등록 기기가 없습니다. 조명/난방 등 기본 세대 기기는 [3]~[6] 또는 [9] 메뉴를 이용하세요.');
            break;
          }
          writeLine('\n[등록 기기 목록]');
          devices.forEach((d, idx) => {
            writeLine(
              `  ${idx + 1}) [${d.spacenm ?? '-'}] ${d.devicenm ?? d.devicetypenm ?? '기기'} (devicecd=${d.devicecd}, type=${d.devicetypecd ?? '-'})`
            );
          });
          const sel = await prompter.ask('상세 조회/제어할 기기 번호 입력 (취소하려면 Enter)');
          if (!sel) break;
          const idx = Number(sel);
          const chosen =
            Number.isInteger(idx) && idx >= 1 && idx <= devices.length
              ? devices[idx - 1]
              : devices.find((d) => d.devicecd === sel);
          if (!chosen) throw new Error('선택한 기기를 찾을 수 없습니다.');

          const detail = await client.getDevice(chosen.devicecd);
          writeLine(`\n[기기 상세 정보]\n${JSON.stringify(detail, null, 2)}`);

          const doExec = await prompter.confirm('이 기기에 제어 요청(/exedevice)을 보내시겠습니까?', false);
          if (doExec) {
            const resource = await prompter.ask('resource 값 입력 (생략 시 Enter)');
            const configRaw = await prompter.ask('configuration JSON 입력 (예: {"power":"on"}, 생략 시 Enter)');
            const execRes = await client.executeDevice({
              deviceCd: chosen.devicecd,
              resource: resource || undefined,
              configuration: configRaw ? JSON.parse(configRaw) : undefined,
            });
            writeLine(`\n[제어 응답]\n${JSON.stringify(execRes, null, 2)}`);
          }
          break;
        }

        case '9': {
          await ensureAuthenticated(client, prompter, writeLine);
          writeLine('\n[자연어 연속 제어 모드] 명령어를 입력하세요 (메뉴로 돌아가려면 q 또는 빈 줄 입력)');
          writeLine('  예시: "거실 조명 켜줘", "전체 조명 꺼줘", "안방 난방 24도로 설정해줘", "집안 상태 알려줘"');
          while (true) {
            const cmdText = await prompter.ask('명령 입력');
            if (!cmdText || cmdText.toLowerCase() === 'q' || cmdText.toLowerCase() === 'exit') {
              break;
            }
            const res = await client.voiceCommand(cmdText);
            writeLine(formatVoiceResultLines(res) + '\n');
          }
          break;
        }

        case '10': {
          await client.logout();
          writeLine('로그아웃 및 로컬 세션(.hiot-session.json) 삭제가 완료되었습니다.');
          break;
        }

        default:
          writeLine(`알 수 없는 메뉴 번호입니다: '${choice}'`);
      }
    } catch (err) {
      if (err instanceof HiotApiError) {
        writeLine(`\n[Hi-oT API 오류] ${err.message}${err.code ? ` (코드: ${err.code})` : ''}`);
      } else {
        writeLine(`\n[오류] ${err.message || err}`);
      }
    }
  }
}

/**
 * Execute the CLI with given argv and optional custom streams (used by both terminal entrypoint and tests).
 *
 * @param {string[]} [argv]
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream, errorOutput?: NodeJS.WritableStream, interactive?: boolean }} [io]
 */
export async function runCli(argv = process.argv.slice(2), io = {}) {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const isInteractive = io.interactive ?? Boolean(input.isTTY && output.isTTY);
  const writeLine = (msg = '') => output.write(`${msg}\n`);
  const outJson = (data) => writeLine(JSON.stringify(data, null, 2));

  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      id: { type: 'string' },
      pw: { type: 'string' },
      pin: { type: 'string' },
      session: { type: 'string' },
      server: { type: 'string' },
      'voice-server': { type: 'string' },
      config: { type: 'string' },
      operation: { type: 'string' },
      'mqtt-host': { type: 'string' },
      'mqtt-port': { type: 'string' },
      port: { type: 'string' },
      qa: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      dst: { type: 'boolean', default: false },
      html: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    allowPositionals: true,
  });

  const [command, ...args] = positionals;
  if (values.help) {
    writeLine(HELP_TEXT);
    return;
  }

  const mainServerUrl =
    values.server ??
    process.env.HIOT_MAIN_SERVER_URL ??
    (values.qa ? 'https://qa-home.hiot.autoever.com:8443' : undefined);
  const voiceHomeServerUrl =
    values['voice-server'] ?? process.env.HIOT_VOICE_SERVER_URL ?? undefined;

  const client = new HiotClient({
    sessionFile: values.session,
    mainServerUrl,
    voiceHomeServerUrl,
  });
  await client.loadSession();

  // Launch interactive menu if `menu`/`shell` is passed, or no command was given on an interactive terminal
  if (command === 'menu' || command === 'shell' || (!command && isInteractive)) {
    const prompter = new CliPrompter({ input, output });
    try {
      await runInteractiveMenu(client, prompter, writeLine);
    } finally {
      prompter.close();
    }
    return;
  }

  if (!command) {
    writeLine(HELP_TEXT);
    return;
  }

  const prompter = isInteractive ? new CliPrompter({ input, output }) : null;
  const printVoice = (res) => {
    if (values.json) outJson(res);
    else writeLine(formatVoiceResultLines(res));
  };

  try {
    switch (command) {
      case 'login': {
        const userId = values.id ?? process.env.HIOT_USER_ID;
        const password = values.pw ?? process.env.HIOT_PASSWORD;
        const pin = values.pin ?? process.env.HIOT_PIN;

        if ((!userId || !password) && (prompter || io.input)) {
          const loginPrompter = prompter ?? new CliPrompter({ input, output });
          try {
            await performInteractiveLogin(
              client,
              loginPrompter,
              { userId, password, pin, jsonMode: values.json },
              writeLine
            );
          } finally {
            if (!prompter) loginPrompter.close();
          }
        } else {
          if (!userId || !password) {
            throw new Error(
              '로그인 아이디와 비밀번호가 필요합니다. `node hiot-cli.js login`을 터미널에서 실행해 대화형으로 입력하거나 `--id <ID> --pw <PW>` 옵션을 지정하세요.'
            );
          }
          const res = await client.login({ userId, password, pin });
          if (values.json) {
            outJson(res);
          } else {
            const info = client.state.loginInfo ?? {};
            writeLine(
              `로그인 성공: ${info.usernm ?? info.userid} (${info.complexnm ?? ''} ${info.buildingno ?? ''}동 ${info.householdno ?? ''}호)`
            );
            writeLine(`- clientId    : ${client.state.clientId}`);
            writeLine(`- householdcd : ${info.householdcd ?? '(없음)'}`);
            writeLine(
              `- 화면잠금여부: ${info.screenlockyn ?? 'N'}${info.screenlockyn === 'Y' && !pin ? ' (필요시 unlock 명령으로 잠금해제 가능)' : ''}`
            );
            writeLine(`- 세션 저장됨 : ${client.sessionFile}`);
          }
        }
        break;
      }

      case 'unlock': {
        await ensureAuthenticated(client, prompter, writeLine);
        let pin = values.pin ?? args[0] ?? process.env.HIOT_PIN;
        if (!pin && (prompter || io.input)) {
          const pinPrompter = prompter ?? new CliPrompter({ input, output });
          try {
            pin = await pinPrompter.askSecret('앱 화면잠금(PIN) 번호 입력');
          } finally {
            if (!prompter) pinPrompter.close();
          }
        }
        if (!pin) throw new Error('잠금번호(PIN)를 입력하거나 `--pin <번호>`를 지정하세요.');
        const res = await client.unlockScreen(pin);
        if (values.json) outJson(res);
        else writeLine('화면잠금(PIN) 인증 및 세션 쿠키 갱신이 완료되었습니다.');
        break;
      }

      case 'relogin': {
        const res = await client.relogin();
        if (values.json) outJson(res);
        else writeLine(`세션 토큰 갱신 완료 (${client.state.userId})`);
        break;
      }

      case 'whoami': {
        if (!client.state.userId) {
          writeLine('저장된 로그인 세션이 없습니다. 먼저 `node hiot-cli.js login`을 실행하세요.');
          return;
        }
        if (values.json) {
          outJson({
            userId: client.state.userId,
            clientId: client.state.clientId,
            cookieNames: Object.keys(client.state.cookies),
            loginInfo: client.state.loginInfo,
            complexInfo: client.state.complexInfo,
            smartModes: client.state.smartModes,
            updatedAt: client.state.updatedAt,
          });
        } else {
          writeLine(formatSessionBanner(client));
          writeLine(`- clientId    : ${client.state.clientId}`);
          writeLine(`- householdcd : ${client.state.loginInfo?.householdcd ?? '(없음)'}`);
          writeLine(`- 저장된 쿠키 : ${Object.keys(client.state.cookies).join(', ') || '(없음)'}`);
          writeLine(`- 스마트모드  : ${client.state.smartModes.length}개`);
          writeLine(`- 최근 갱신   : ${client.state.updatedAt ?? '-'}`);
        }
        break;
      }

      case 'logout': {
        await client.logout();
        writeLine('로그아웃 및 로컬 세션 삭제가 완료되었습니다.');
        break;
      }

      case 'cmd':
      case 'say': {
        await ensureAuthenticated(client, prompter, writeLine);
        const text = args.join(' ').trim();
        if (!text) throw new Error('실행할 명령어 텍스트를 입력하세요. 예: node hiot-cli.js cmd "거실 조명 켜줘"');
        const res = await client.voiceCommand(text, { autoControl: !values['dry-run'] });
        printVoice(res);
        break;
      }

      case 'lights': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [space] = args;
        const lights = await client.listLights(space);
        if (values.json) {
          outJson(lights);
        } else {
          writeLine(formatLightsTable(lights));
        }
        break;
      }

      case 'light': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [space, stateStr] = args;
        if (!space || !stateStr) throw new Error('사용법: node hiot-cli.js light <공간|기기명> <on|off>');
        const parsed = parseOnOffOrTemp(stateStr);
        if (parsed.on === undefined) throw new Error('조명 상태는 on 또는 off로 지정하세요.');
        printVoice(await client.setLight(space, parsed.on));
        break;
      }

      case 'outlet': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [space, stateStr] = args;
        if (!space || !stateStr) throw new Error('사용법: node hiot-cli.js outlet <공간|기기명> <on|off>');
        const parsed = parseOnOffOrTemp(stateStr);
        if (parsed.on === undefined) throw new Error('콘센트 상태는 on 또는 off로 지정하세요.');
        printVoice(await client.setOutlet(space, parsed.on));
        break;
      }

      case 'heat': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [space, val] = args;
        if (!space || !val) throw new Error('사용법: node hiot-cli.js heat <공간> <on|off|온도>');
        printVoice(await client.setHeating(space, parseOnOffOrTemp(val)));
        break;
      }

      case 'ac': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [space, val] = args;
        if (!space || !val) throw new Error('사용법: node hiot-cli.js ac <공간> <on|off|온도>');
        printVoice(await client.setAirConditioner(space, parseOnOffOrTemp(val)));
        break;
      }

      case 'gas-lock': {
        await ensureAuthenticated(client, prompter, writeLine);
        printVoice(await client.closeGasValve());
        break;
      }

      case 'vent': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [stateStr, space] = args;
        if (!stateStr) throw new Error('사용법: node hiot-cli.js vent <on|off> [공간]');
        const parsed = parseOnOffOrTemp(stateStr);
        if (parsed.on === undefined) throw new Error('환기 상태는 on 또는 off로 지정하세요.');
        printVoice(await client.setVentilator(parsed.on, { space }));
        break;
      }

      case 'elevator': {
        await ensureAuthenticated(client, prompter, writeLine);
        printVoice(await client.callElevator());
        break;
      }

      case 'home-status': {
        await ensureAuthenticated(client, prompter, writeLine);
        const target = args.join(' ').trim() || '집안';
        printVoice(await client.queryHomeStatus(target));
        break;
      }

      case 'service-exec': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [serviceId] = args;
        if (!serviceId) throw new Error('사용법: node hiot-cli.js service-exec <serviceID>');
        outJson(await client.controlByServiceId(serviceId));
        break;
      }

      case 'spaces': {
        await ensureAuthenticated(client, prompter, writeLine);
        outJson(await client.getSpaces());
        break;
      }

      case 'services': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [category] = args;
        const homenet = await client.getHomenetServices();
        const categoryServices = await client.getServices(category || 'LVNG');
        outJson({ homenetServices: homenet, categoryServices });
        break;
      }

      case 'devices': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [filter] = args;
        const types = filter ? [filter] : undefined;
        let devices = [];
        try {
          devices = await client.listAllDevices({ types });
        } catch {
          const res = await client.getDevices(filter || '');
          devices = Array.isArray(res?.device) ? res.device : [];
        }
        if (values.json) {
          outJson(devices);
        } else {
          if (devices.length === 0) {
            writeLine('등록된 기기가 없습니다.');
          } else {
            writeLine(`[등록 기기 목록] 총 ${devices.length}개`);
            for (const d of devices) {
              const typeName = DEVICE_TYPE_NAMES[d.devicetypecd] || d.devicetypecd || '기타';
              const status = d.attributevalu ? ` (상태: ${d.attributevalu})` : '';
              writeLine(`  - [${d.spacenm || '-'}] ${d.devicenm} [${typeName}]${status} (코드: ${d.devicecd})`);
            }
          }
        }
        break;
      }

      case 'device': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [deviceCd] = args;
        if (!deviceCd) throw new Error('사용법: node hiot-cli.js device <devicecd>');
        outJson(await client.getDevice(deviceCd));
        break;
      }

      case 'device-exec': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [deviceCd, resource] = args;
        if (!deviceCd) {
          throw new Error(
            '사용법: node hiot-cli.js device-exec <devicecd> [resource] [--config \'{"volume":"5"}\']'
          );
        }
        const configuration = values.config ? JSON.parse(values.config) : undefined;
        const operation = values.operation ? JSON.parse(values.operation) : undefined;
        outJson(
          await client.executeDevice({
            deviceCd,
            resource,
            configuration,
            operation,
          })
        );
        break;
      }

      case 'modes': {
        outJson(client.state.smartModes);
        break;
      }

      case 'mode-exec': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [modeCd] = args;
        if (!modeCd) throw new Error('사용법: node hiot-cli.js mode-exec <modecd> [--dst]');
        outJson(await client.executeSmartMode(modeCd, { useDstEndpoint: values.dst }));
        break;
      }

      case 'web-fetch': {
        await ensureAuthenticated(client, prompter, writeLine);
        const [target = 'space'] = args;
        const page = await client.fetchControllerPage(target);
        if (values.json || values.html) {
          outJson(page);
        } else {
          writeLine(`[조회 경로] ${page.path} (HTTP ${page.status}, ${page.html.length} bytes)`);
          writeLine('[발견된 내부 엔드포인트 목록]');
          if (page.discoveredEndpoints.length === 0) {
            writeLine('  (추출된 /hiot-web/ 또는 /hiot-app/ 경로 없음 — --html 옵션으로 본문을 확인하세요)');
          } else {
            for (const ep of page.discoveredEndpoints) {
              writeLine(`  - ${ep}`);
            }
          }
        }
        break;
      }

      case 'bridge': {
        await ensureAuthenticated(client, prompter, writeLine);
        const { HiotHaBridge } = await import('./src/hiot-ha-bridge.js');
        const bridge = new HiotHaBridge({
          sessionFile: client.sessionFile,
          mqttHost: values['mqtt-host'] || process.env.MQTT_HOST || '127.0.0.1',
          mqttPort: values['mqtt-port'] || process.env.MQTT_PORT || 1883,
          webPort: values.port ? Number(values.port) : 8099,
        });
        await bridge.start();
        break;
      }

      default:
        throw new Error(`알 수 없는 명령입니다: '${command}'. 도움말을 보려면 --help를 사용하세요.`);
    }
  } finally {
    prompter?.close();
  }
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectRun) {
  runCli().catch((err) => {
    if (err instanceof HiotApiError) {
      console.error(`[Hi-oT API 오류] ${err.message}`);
      if (err.code) console.error(`  코드: ${err.code}`);
      if (err.endpoint) console.error(`  경로: ${err.endpoint}`);
      if (err.payload) console.error(`  상세: ${JSON.stringify(err.payload)}`);
    } else {
      console.error(`[오류] ${err.message || err}`);
    }
    process.exitCode = 1;
  });
}
