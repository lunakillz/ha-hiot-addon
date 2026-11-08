# Hi-oT Smart Home Node.js 제어 스크립트

현대오토에버 **힐스테이트 Hi-oT Smart Home (`hea.iot.smarthome.app.hillstate` v1.0.101)** APK 정적 분석을 통해 구현한 **외부 패키지 무의존성(Zero-dependency) Node.js 클라이언트 및 CLI 도구**입니다.

본인의 정식 Hi-oT 계정(ID/비밀번호)으로 로그인하여 세션을 유지하고, 집안의 **조명, 난방, 에어컨, 가스밸브, 환기, 대기전력 콘센트, 가전기기, 엘리베이터 호출, 스마트모드** 등을 Node.js 코드나 터미널 명령어로 제어할 수 있습니다.

## 요구 사항

- **Node.js 18.0.0 이상** (별도 `npm install` 불필요 — Node 내장 모듈만 사용)

## 빠른 시작 (CLI)

프로젝트 폴더의 `.\hiot` (Windows) 또는 `node hiot-cli.js`로 실행할 수 있으며, **대화형 제어 콘솔 모드**와 **단일 명령어 모드**를 모두 지원합니다.

### 1. 대화형 로그인 & 제어 메뉴 실행 (추천)

인자 없이 실행하면 터미널에서 바로 번호를 골라 로그인(비밀번호 화면 숨김 처리)과 기기 제어를 수행하는 대화형 콘솔이 열립니다.

```powershell
.\hiot
# 또는
node hiot-cli.js
```

- `[1] 로그인 / 계정 변경`: 아이디, 비밀번호(마스킹), 앱 화면잠금(PIN) 설정 계정인 경우 PIN까지 대화형으로 안전하게 입력받아 `.hiot-session.json`에 저장합니다.
- `[2] 집안 및 기기 상태 조회`
- `[3] 조명 제어` (세대 공간 목록 자동 조회 및 선택 → 켜기/끄기)
- `[4] 난방 제어` (켜기 / 끄기 / 희망온도 설정)
- `[5] 에어컨 제어` (켜기 / 끄기 / 희망온도 설정)
- `[6] 가스밸브 잠금 / 환기 / 엘리베이터 호출`
- `[7] 스마트모드 조회 및 실행`
- `[8] 등록 기기 목록 조회 및 직접 제어` (`/device/*` API)
- `[9] 한국어 자연어 연속 제어 모드` (`"거실 조명 켜줘"`, `"전체 조명 꺼줘"` 등 연속 실행)
- `[10] 로그아웃`

### 2. 단일 CLI 명령어로 로그인 및 즉시 제어

스크립트 자동화나 단축키에 연결할 때는 하위 명령어로 바로 실행할 수 있습니다. (미로그인 상태에서 제어 명령을 실행하면 대화형 로그인 프롬프트가 자동으로 연결됩니다.)

```powershell
# 대화형 비밀번호 입력 로그인 (쉘 히스토리에 비밀번호가 남지 않음)
.\hiot login

# 옵션 지정 로그인
.\hiot login --id "내아이디" --pw "내비밀번호"

# 조명 목록 조회 (전체 또는 특정 공간)
.\hiot lights
.\hiot lights 거실

# 조명 / 콘센트 / 난방 / 에어컨 / 가스밸브 / 환기 / 엘리베이터 즉시 제어
.\hiot light 거실 off
.\hiot light 거실1 on
.\hiot outlet 거실 on
.\hiot heat 거실 24
.\hiot ac 거실 25
.\hiot gas-lock
.\hiot vent on
.\hiot elevator

# 세대 전체 등록 기기 목록 (28개 등 전 공간 일괄 조회)
.\hiot devices

# 상태 조회 및 자유 한국어 제어 명령
.\hiot home-status
.\hiot cmd "전체 조명 꺼줘"

# 로그인 정보 확인 / 로그아웃
.\hiot whoami
.\hiot logout
```

### 3. 공간 / 기기 / 스마트모드 직접 REST API 호출

```bash
# 세대 공간 목록 및 단지 홈넷 지원 서비스 조회
node hiot-cli.js spaces
node hiot-cli.js services

# 등록 기기 목록 / 상세 조회 / 제어
node hiot-cli.js devices
node hiot-cli.js device "<devicecd>"
node hiot-cli.js device-exec "<devicecd>" "<resource>" --config '{"volume":"5"}'

# 스마트모드 목록 확인 및 실행
node hiot-cli.js modes
node hiot-cli.js mode-exec "<modecd>"

# 서버 렌더링 제어 WebView JSP 조회 및 단지별 내부 AJAX 엔드포인트 추출
node hiot-cli.js web-fetch space
node hiot-cli.js web-fetch device
```

## 코드에서 모듈로 사용하기 (`HiotClient`)

```js
import { HiotClient } from './src/hiot-client.js';

const client = new HiotClient();
await client.loadSession();

if (!client.state.userKeyValu) {
  await client.login({
    userId: process.env.HIOT_USER_ID,
    password: process.env.HIOT_PASSWORD,
  });
}

// 1. 조명 / 난방 / 가스밸브 / 엘리베이터 제어
await client.setLight('거실', true);
await client.setHeating('안방', { temperature: 24 });
await client.closeGasValve();

// 2. 자연어 텍스트 명령으로 모든 기기 제어 또는 상태 조회
const status = await client.queryHomeStatus('집안');
console.log(status.intent?.result, status.intent?.viewTypeData);

// 3. 메인 서버 REST API 직접 호출
const spaces = await client.getSpaces();
const services = await client.getHomenetServices();
console.log({ spaces, services });
```

# 자체 테스트 실행

APK 내장 `KISA_SEED_ECB` 복호화 검증 및 로그인/세션 자동갱신/기기제어 모의 서버 통합 테스트를 실행합니다:

```bash
npm test
```

---

## Home Assistant (HA) 애드온 연동 가이드

Home Assistant에서 Hi-oT 세대의 조명, 난방, 시스템에어컨, 전열콘센트, 환기, 엘리베이터 호출을 제어할 수 있는 **공식 MQTT 브릿지 애드온**이 포함되어 있습니다.

### 1. 주요 특징
- **MQTT Discovery 자동 등록**: 별도 YAML 파일 작성 없이 HA의 `Mosquitto broker`와 연결되면 방(Area)별로 모든 기기가 자동 등록됩니다.
- **Ingress 대시보드 지원**: Home Assistant 사이드바 메뉴에서 실시간 기기 상태, 전원 토글, 온도 조절, 엘리베이터 호출, 동작 로그를 한눈에 볼 수 있습니다.
- **세션 자동 복구**: `/data/.hiot-session.json`에 인증 쿠키와 암호화 토큰이 보관되어 재시작 시에도 끊김 없이 동작합니다.

### 2. 애드온 설치 단계
1. Home Assistant **설정 > 애드온 > 애드온 스토어** 우측 상단 메뉴(⋮)에서 **저장소**를 클릭합니다.
2. 이 Git 저장소 URL을 추가합니다.
3. 목록에 표시되는 **Hi-oT Smart Home Bridge** 애드온을 설치합니다.
4. **구성** 탭에서 Hi-oT 아이디와 비밀번호를 입력합니다:
   ```yaml
   hiot_user_id: "내아이디"
   hiot_password: "내비밀번호"
   hiot_pin: "" # 앱 화면잠금 설정 시에만 입력
   mqtt_host: "core-mosquitto"
   mqtt_port: 1883
   ```
5. 애드온을 시작하고 **사이드바에 표시**를 활성화합니다.
6. Home Assistant의 **기기 및 서비스 > MQTT**에서 등록된 조명, 콘센트, 난방, 에어컨, 엘리베이터를 즉시 사용할 수 있습니다.

### 3. PC 또는 별도 서버에서 단독 브릿지로 실행
Docker나 Home Assistant OS 없이 로컬 PC/서버에서 MQTT 브릿지만 바로 구동할 수도 있습니다:
```bash
# 로컬 MQTT 브로커(127.0.0.1:1883)와 웹 UI(포트 8099) 구동
node hiot-cli.js bridge
# 또는
npm run bridge
```
브라우저에서 `http://localhost:8099`로 접속하면 실시간 제어 대시보드가 열립니다.
