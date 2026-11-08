# Home Assistant용 Hi-oT Smart Home 브릿지 애드온

현대오토에버 **힐스테이트 Hi-oT 스마트홈** 세대의 조명, 난방, 시스템에어컨, 전열콘센트, 환기시스템, 엘리베이터 호출을 **Home Assistant (HA)**와 실시간으로 연동하는 공식 브릿지 애드온입니다.

Home Assistant의 **MQTT Discovery** 표준 규격을 지원하여, 별도의 YAML 엔티티 작성 없이 설치 및 계정 입력 즉시 **Home Assistant 대시보드(Lovelace)에 모든 기기가 방(Area)별로 자동 생성**됩니다.

---

## 사전 준비 사항

1. **Home Assistant OS** 또는 **Home Assistant Supervised**
2. **Mosquitto broker 애드온**
   - Home Assistant 설정 > 애드온 > 애드온 스토어에서 `Mosquitto broker` 설치 및 시작
   - Home Assistant 설정 > 기기 및 서비스 > `MQTT` 통합구성요소가 연결되어 있어야 합니다.

---

## 설치 방법

### 1. 애드온 저장소 등록
1. Home Assistant에서 **설정(Settings)** > **애드온(Add-ons)** > **애드온 스토어(Add-on Store)**로 이동합니다.
2. 우측 상단의 **점 3개(⋮)** 메뉴를 누르고 **저장소(Repositories)**를 선택합니다.
3. 이 GitHub 저장소 URL을 입력하고 **추가(Add)**를 클릭합니다.
4. 애드온 스토어 목록을 새로고침하면 **Hi-oT Smart Home Bridge** 애드온이 표시됩니다.

### 2. 애드온 설치 및 설정
1. **Hi-oT Smart Home Bridge**를 클릭하고 **설치(Install)**를 누릅니다.
2. 설치 완료 후 **구성(Configuration)** 탭으로 이동하여 설정을 입력합니다:

```yaml
hiot_user_id: "본인의 Hi-oT 아이디"
hiot_password: "본인의 Hi-oT 비밀번호"
hiot_pin: "" # 앱 화면잠금(PIN) 번호가 설정된 계정인 경우에만 4자리 입력
mqtt_host: "core-mosquitto" # HA 내장 Mosquitto 브로커인 경우 그대로 유지
mqtt_port: 1883
mqtt_user: "" # Mosquitto에 별도 계정을 둔 경우 입력
mqtt_password: ""
discovery_prefix: "homeassistant"
topic_prefix: "hiot"
polling_interval_sec: 30 # 기기 상태 동기화 주기 (초)
```

3. **정보(Info)** 탭으로 돌아와:
   - **부팅 시 시작 (Start on boot)**: 활성화
   - **사이드바에 표시 (Show in sidebar)**: 활성화 (Ingress 웹 대시보드 연동)
   - **시작 (Start)** 버튼을 클릭합니다.

---

## 연동되는 기기 및 엔티티 목록

애드온이 시작되면 세대 등록 기기(최대 28개+)가 방(Area)별로 HA에 자동 등록됩니다:

| 기기 종류 | HA 엔티티 유형 | 지원 기능 |
| :--- | :--- | :--- |
| **조명 (LGT)** | `light` | 방별 조명 전원 ON / OFF 제어 및 실시간 상태 동기화 |
| **콘센트 (WSK)** | `switch` (outlet) | 대기전력 차단 콘센트 ON / OFF 제어 |
| **난방 (HTR)** | `climate` | 보일러 전원 (off / heat) 및 희망온도 설정, 현재온도 표시 |
| **시스템에어컨 (ACB)** | `climate` | 에어컨 전원 (off / cool) 및 희망온도 설정, 현재온도 표시 |
| **환기 (VNT)** | `fan` | 세대 환기장비 전원 ON / OFF |
| **일괄스위치 (SWT)** | `switch` | 현관 일괄소등 스위치 상태 및 제어 |
| **엘리베이터 호출** | `button` | 클릭 시 엘리베이터 호출 API 즉시 실행 |
| **스마트모드** | `button` | 외출모드, 취침모드 등 단지 설정 모드 실행 |

---

## Ingress 웹 대시보드 기능

Home Assistant 좌측 사이드바의 **Hi-oT 홈제어** 메뉴를 클릭하면:
- Hi-oT 서버 및 MQTT 브로커 실시간 연결 상태
- 세대 정보 (단지명, 동, 호수, 로그인 계정)
- 공간(거실, 침실, 주방 등)별 등록 기기 카드와 실시간 토글 스위치
- 온도 조절 및 엘리베이터 즉시 호출 버튼
- 실시간 브릿지 동작 로그를 한눈에 볼 수 있습니다.

---

## Lovelace 대시보드 카드 예시

### 1. 거실 조명 및 난방 카드
```yaml
type: entities
title: 거실 제어
entities:
  - entity: light.geosil1
    name: 거실 1 조명
  - entity: light.geosil2
    name: 거실 2 조명
  - entity: switch.geosil1_konxenteu
    name: 거실 1 콘센트
  - entity: climate.geosil_nanbang
    name: 거실 난방
  - entity: climate.geosil_eeokeon
    name: 거실 에어컨
```

### 2. 엘리베이터 원클릭 호출 버튼
```yaml
type: button
name: 엘리베이터 호출
icon: mdi:elevator-passenger
tap_action:
  action: call-service
  service: button.press
  target:
    entity_id: button.hiot_elevator
```

---

## 문제 해결 및 로그 확인

- 애드온의 **로그(Log)** 탭에서 Hi-oT 로그인 및 MQTT 통신 로그를 실시간으로 확인할 수 있습니다.
- 세션 토큰은 `/data/.hiot-session.json`에 안전하게 보관되므로 애드온이 재시작되어도 재로그인 없이 빠르게 복구됩니다.
