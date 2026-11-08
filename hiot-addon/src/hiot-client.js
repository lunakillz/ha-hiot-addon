import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Default server base URLs decrypted from hea.iot.smarthome.app.hillstate.common.Settings (APK v1.0.101).
 */
export const DEFAULT_ENDPOINTS = Object.freeze({
  mainServerUrl: 'https://home.hiot.autoever.com:8443',
  qaMainServerUrl: 'https://qa-home.hiot.autoever.com:8443',
  voiceHomeServerUrl: 'https://voicehome.autoever.com',
});

/**
 * Server-hosted WebView controller JSP paths from Settings$WebURL.
 */
export const WEB_CONTROLLER_PAGES = Object.freeze({
  space: '/hiot-app/hiot/contents/control/space/HD-KMA-31-01.jsp',
  device: '/hiot-app/hiot/contents/control/space/HD-KMA-34-00.jsp',
  mode: '/hiot-app/hiot/contents/setup/HD-KMA-77-01.jsp?link=control',
  elevator: '/hiot-app/hiot/contents/main/HD-KMA-11-01.jsp',
  inquiryHistory: '/hiot-app/hiot/contents/inquiry/HD-KMA-50-00.jsp',
});

/**
 * Home device categories supported by VoiceHomeIconManager in the APK.
 */
export const SUPPORTED_VOICE_DEVICE_TYPES = Object.freeze([
  'light',           // 조명
  'heater',          // 난방 / 보일러
  'airconditioner',  // 시스템 에어컨
  'gasvalve',        // 가스밸브
  'ventilator',      // 환기
  'wallsocket',      // 대기전력 콘센트
  'airpurifier',     // 공기청정기
  'washer',          // 세탁기
  'dryer',           // 건조기
  'dishwasher',      // 식기세척기
  'robotcleaner',    // 로봇청소기
  'refrigerator',    // 냉장고
  'ricecooker',      // 전기밥솥
  'oven',            // 오븐
  'microwave',       // 전자레인지
]);

export const SESSION_EXPIRED_CODE = 'smarthome.error.auth.00001';

/**
 * `devicetypecd` → Korean label (from server-hosted HD-KMA-31-01.js / HD-KMA-34-00.jsp).
 */
export const DEVICE_TYPE_NAMES = Object.freeze({
  LGT: '조명',
  LGD: '디밍조명',
  LGE: '색온도조명',
  LGS: '조명',
  SWT: '일괄스위치',
  MSW: '멀티스위치',
  WSK: '콘센트',
  HTR: '난방',
  ACB: '시스템에어컨',
  VNT: '환기',
  GDK: '가스밸브',
  APF: '공기청정기',
  WSH: '세탁기',
  RFR: '냉장고',
  RFK: '김치냉장고',
  RCL: '로봇청소기',
  OVN: '오븐',
  RNG: '레인지',
  RCC: '밥솥',
  STY: '스타일러',
  TVS: 'TV',
  AIS: 'AI스피커',
  FAN: '선풍기',
});

/** Light device types controlled together by the app's "조명 통합제어" page (HD-KMA-34-01). */
export const LIGHT_DEVICE_TYPES = Object.freeze(['LGT', 'LGD', 'LGE', 'LGS']);

export class HiotApiError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, endpoint?: string, payload?: unknown }} [details]
   */
  constructor(message, details = {}) {
    super(message);
    this.name = 'HiotApiError';
    this.code = details.code ?? null;
    this.status = details.status ?? null;
    this.endpoint = details.endpoint ?? null;
    this.payload = details.payload ?? null;
  }
}

/**
 * Format a Date as `yyyyMMddHHmmss` in Korea Standard Time (`Asia/Seoul`),
 * matching `Utils.C()` used by `VoiceHomeFragment`.
 * @param {Date} [date]
 * @returns {string}
 */
export function formatKstTimestamp(date = new Date()) {
  const kstMs = date.getTime() + 9 * 60 * 60 * 1000;
  const kst = new Date(kstMs);
  const yyyy = String(kst.getUTCFullYear()).padStart(4, '0');
  const MM = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(kst.getUTCDate()).padStart(2, '0');
  const HH = String(kst.getUTCHours()).padStart(2, '0');
  const mm = String(kst.getUTCMinutes()).padStart(2, '0');
  const ss = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${MM}${dd}${HH}${mm}${ss}`;
}

/**
 * Extract candidate AJAX / REST endpoints referenced in server-rendered JSP HTML/JS.
 * @param {string} html
 * @returns {string[]}
 */
export function extractAjaxEndpointsFromHtml(html) {
  if (typeof html !== 'string' || !html) return [];
  const regex = /(?:\/hiot-web\/|\/hiot-app\/)[A-Za-z0-9_./?=&%-]+/g;
  const matches = html.match(regex) ?? [];
  return [...new Set(matches)].sort();
}

function parseSetCookieHeaders(headers) {
  let rawList = [];
  if (typeof headers.getSetCookie === 'function') {
    rawList = headers.getSetCookie();
  } else {
    const combined = headers.get('set-cookie');
    if (combined) {
      rawList = combined.split(/,(?=\s*[!#$%&'*+\-.^_`|~0-9A-Za-z]+=)/);
    }
  }

  const parsed = {};
  for (const line of rawList) {
    const firstPart = line.split(';')[0]?.trim();
    if (!firstPart) continue;
    const eqIdx = firstPart.indexOf('=');
    if (eqIdx <= 0) continue;
    const name = firstPart.slice(0, eqIdx).trim();
    const value = firstPart.slice(eqIdx + 1).trim();
    parsed[name] = value;
  }
  return parsed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Extract `errorcode` / `errormessage` from either top-level `BaseResponseDTO` fields
 * or nested list DTOs such as `SignInResponseDTO.login[0]` (`SignInFragment$9` behavior).
 * @param {any} data
 * @returns {{ code: string, message: string } | null}
 */
export function extractHiotError(data) {
  if (!data || typeof data !== 'object') return null;

  const topCode = typeof data.errorcode === 'string' ? data.errorcode.trim() : '';
  if (topCode) {
    return {
      code: topCode,
      message: typeof data.errormessage === 'string' ? data.errormessage.trim() : '',
    };
  }

  for (const value of Object.values(data)) {
    if (Array.isArray(value) && value.length > 0 && value[0] && typeof value[0] === 'object') {
      const nestedCode = typeof value[0].errorcode === 'string' ? value[0].errorcode.trim() : '';
      if (nestedCode) {
        return {
          code: nestedCode,
          message: typeof value[0].errormessage === 'string' ? value[0].errormessage.trim() : '',
        };
      }
    }
  }
  return null;
}

/**
 * Hi-oT Smart Home API Client (Hyundai AutoEver Hillstate).
 *
 * Implements the native Retrofit + OkHttp session/header protocol and VoiceHome NLU / device
 * control endpoints observed in `hea.iot.smarthome.app.hillstate` v1.0.101.
 */
export class HiotClient {
  /**
   * @param {object} [options]
   * @param {string} [options.mainServerUrl]
   * @param {string} [options.voiceHomeServerUrl]
   * @param {string|null} [options.sessionFile] Path to persist session JSON (null disables disk persistence)
   * @param {string} [options.clientId] Installation UUID (`ICInstallation_UUID`)
   * @param {typeof fetch} [options.fetchImpl] Custom fetch implementation (for testing)
   * @param {number} [options.reloginRetryDelayMs] Delay between auto-relogin attempts (APK default: 2000ms)
   * @param {number} [options.maxReloginAttempts] Max auto-relogin attempts on `smarthome.error.auth.00001` (APK: 3)
   */
  constructor(options = {}) {
    this.mainServerUrl = (options.mainServerUrl ?? DEFAULT_ENDPOINTS.mainServerUrl).replace(/\/+$/, '');
    this.voiceHomeServerUrl = (options.voiceHomeServerUrl ?? DEFAULT_ENDPOINTS.voiceHomeServerUrl).replace(/\/+$/, '');
    this.sessionFile =
      options.sessionFile === undefined
        ? path.resolve(process.cwd(), '.hiot-session.json')
        : options.sessionFile;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.reloginRetryDelayMs = options.reloginRetryDelayMs ?? 2000;
    this.maxReloginAttempts = options.maxReloginAttempts ?? 3;

    this.state = {
      clientId: options.clientId ?? crypto.randomUUID(),
      userId: null,
      userKeyValu: null,
      cookies: {},
      loginInfo: null,
      complexInfo: null,
      smartModes: [],
      updatedAt: null,
    };
  }

  /**
   * Load persisted session state from disk if present.
   * @returns {Promise<boolean>} true if a session file was loaded
   */
  async loadSession() {
    if (!this.sessionFile) return false;
    try {
      const raw = await fs.readFile(this.sessionFile, 'utf8');
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        this.state = {
          ...this.state,
          ...data,
          clientId: data.clientId || this.state.clientId,
          cookies: data.cookies && typeof data.cookies === 'object' ? data.cookies : {},
          smartModes: Array.isArray(data.smartModes) ? data.smartModes : [],
        };
        return true;
      }
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        throw err;
      }
    }
    return false;
  }

  /**
   * Persist current session state (`clientId`, `cookies`, `userKeyValu`, household metadata) to disk.
   */
  async saveSession() {
    if (!this.sessionFile) return;
    this.state.updatedAt = new Date().toISOString();
    const serialized = JSON.stringify(this.state, null, 2);
    await fs.writeFile(this.sessionFile, serialized, { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * Clear local session file and in-memory tokens (preserving installation `clientId`).
   */
  async clearSession() {
    const { clientId } = this.state;
    this.state = {
      clientId,
      userId: null,
      userKeyValu: null,
      cookies: {},
      loginInfo: null,
      complexInfo: null,
      smartModes: [],
      updatedAt: null,
    };
    if (this.sessionFile) {
      try {
        await fs.unlink(this.sessionFile);
      } catch (err) {
        if (err?.code !== 'ENOENT') throw err;
      }
    }
  }

  /**
   * Build HTTP headers matching `AddCookiesInterceptor` in the Android app.
   * Sent to both `mainServerUrl` and `voiceHomeServerUrl` because `NetRetrofit.b()` and `NetRetrofit.c()`
   * share the same `OkHttpClient` instance.
   * @param {Record<string, string>} [extraHeaders]
   * @returns {Record<string, string>}
   */
  buildHeaders(extraHeaders = {}) {
    const cookieEntries = Object.entries(this.state.cookies);
    const headers = {
      'x-hiot-clientId': this.state.clientId,
      clientKey: this.state.clientId,
      Accept: 'application/json, text/plain, */*',
      'User-Agent': 'okhttp/4.9.3',
      ...extraHeaders,
    };
    if (cookieEntries.length > 0) {
      headers.Cookie = cookieEntries.map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return headers;
  }

  /**
   * Low-level authenticated HTTP request with cookie capture and automatic `smarthome.error.auth.00001` recovery.
   *
   * @param {string} method
   * @param {string} urlOrPath
   * @param {object} [options]
   * @param {'main'|'voice'} [options.server='main']
   * @param {unknown} [options.body]
   * @param {Record<string, string>} [options.headers]
   * @param {'json'|'text'} [options.responseType='json']
   * @param {boolean} [options.allowAutoRelogin=true]
   * @returns {Promise<any>}
   */
  async rawRequest(method, urlOrPath, options = {}) {
    const {
      server = 'main',
      body,
      headers: customHeaders = {},
      responseType = 'json',
      allowAutoRelogin = true,
    } = options;

    const baseUrl = server === 'voice' ? this.voiceHomeServerUrl : this.mainServerUrl;
    const url = /^https?:\/\//i.test(urlOrPath)
      ? urlOrPath
      : `${baseUrl}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`;

    const reqHeaders = this.buildHeaders(customHeaders);
    let payloadBody;
    if (body !== undefined && body !== null && method.toUpperCase() !== 'GET') {
      if (typeof body === 'string' || Buffer.isBuffer(body)) {
        payloadBody = body;
      } else {
        reqHeaders['Content-Type'] = reqHeaders['Content-Type'] ?? 'application/json; charset=UTF-8';
        payloadBody = JSON.stringify(body);
      }
    }

    const res = await this.fetchImpl(url, {
      method: method.toUpperCase(),
      headers: reqHeaders,
      body: payloadBody,
      redirect: 'manual',
    });

    const newCookies = parseSetCookieHeaders(res.headers);
    if (Object.keys(newCookies).length > 0) {
      this.state.cookies = { ...this.state.cookies, ...newCookies };
      await this.saveSession();
    }

    const text = await res.text();
    if (responseType === 'text') {
      if (!res.ok) {
        throw new HiotApiError(`HTTP ${res.status} from ${url}`, {
          status: res.status,
          endpoint: url,
          payload: text,
        });
      }
      return { status: res.status, headers: res.headers, text };
    }

    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new HiotApiError(`Expected JSON from ${url} (HTTP ${res.status}), received non-JSON body`, {
        status: res.status,
        endpoint: url,
        payload: text.slice(0, 500),
      });
    }

    // Check BaseResponseDTO & nested DTO errorcode (`RetrofitCallBack` + `SignInFragment$9` logic)
    const apiErr = extractHiotError(data);
    if (apiErr) {
      if (
        apiErr.code.toLowerCase() === SESSION_EXPIRED_CODE &&
        allowAutoRelogin &&
        this.state.userId &&
        this.state.userKeyValu
      ) {
        await this.autoReloginWithRetry();
        return this.rawRequest(method, urlOrPath, { ...options, allowAutoRelogin: false });
      }

      throw new HiotApiError(
        apiErr.message || `Hi-oT API error (${apiErr.code})`,
        {
          code: apiErr.code,
          status: res.status,
          endpoint: url,
          payload: data,
        }
      );
    }

    if (!res.ok) {
      throw new HiotApiError(`HTTP ${res.status} from ${url}`, {
        status: res.status,
        endpoint: url,
        payload: data,
      });
    }

    return data;
  }

  /**
   * Retry `relogin()` up to `maxReloginAttempts` times (`HApplication.d()` + `RetrofitCallBack` behavior).
   */
  async autoReloginWithRetry() {
    let lastError;
    for (let attempt = 1; attempt <= this.maxReloginAttempts; attempt++) {
      try {
        return await this.relogin();
      } catch (err) {
        lastError = err;
        if (attempt < this.maxReloginAttempts && this.reloginRetryDelayMs > 0) {
          await sleep(this.reloginRetryDelayMs);
        }
      }
    }
    throw lastError;
  }

  /**
   * Initial user login using ID & password (`SignInFragment.J()` -> `POST /hiot-web/login/exelogin`).
   *
   * Note: In APK v1.0.101, `passwordvalu` is sent trimmed over HTTPS without client-side hashing.
   * If the account has screen-lock PIN enabled (`screenlockyn === 'Y'`) and `pin` is provided,
   * `unlockScreen(pin)` is automatically executed to finalize session cookies.
   *
   * @param {object} credentials
   * @param {string} credentials.userId
   * @param {string} credentials.password
   * @param {string} [credentials.pin] Optional 4-6 digit app lock PIN if `screenlockyn === 'Y'`
   * @param {string} [credentials.pushToken='']
   */
  async login({ userId, password, pin, pushToken = '' }) {
    if (!userId || !password) {
      throw new TypeError('Both userId and password are required for login()');
    }

    const body = {
      condition: {
        userid: String(userId).trim(),
        passwordvalu: String(password).trim(),
        mobiledeviceostype: 'android',
        pushregistrationtoken: pushToken,
      },
    };

    const res = await this.rawRequest('POST', '/hiot-web/login/exelogin', {
      body,
      allowAutoRelogin: false,
    });

    const loginEntry = Array.isArray(res?.login) ? res.login[0] : null;
    if (!loginEntry || (!loginEntry.userkeyvalu && !loginEntry.userid)) {
      throw new HiotApiError('로그인 응답에 유효한 사용자 인증 토큰(userkeyvalu)이 없습니다.', {
        endpoint: `${this.mainServerUrl}/hiot-web/login/exelogin`,
        payload: res,
      });
    }

    this.#applySignInResponse(res, String(userId).trim());
    await this.saveSession();

    if (this.state.loginInfo?.screenlockyn === 'Y' && pin) {
      await this.unlockScreen(pin);
    }

    return res;
  }

  /**
   * Token-based session refresh using saved `userkeyvalu` (`HApplication.d()` -> `POST /hiot-web/login/exelogin`).
   * @param {string} [pushToken='']
   */
  async relogin(pushToken = '') {
    if (!this.state.userId || !this.state.userKeyValu) {
      throw new HiotApiError('No saved userId/userKeyValu in session; run login() first');
    }

    const body = {
      condition: {
        userid: this.state.userId,
        userkeyvalu: this.state.userKeyValu,
        mobiledeviceostype: 'android',
        pushregistrationtoken: pushToken,
      },
    };

    const res = await this.rawRequest('POST', '/hiot-web/login/exelogin', {
      body,
      allowAutoRelogin: false,
    });

    this.#applySignInResponse(res, this.state.userId);
    await this.saveSession();
    return res;
  }

  #applySignInResponse(res, fallbackUserId) {
    const loginEntry = Array.isArray(res?.login) ? res.login[0] : null;
    const complexEntry = Array.isArray(res?.complex) ? res.complex[0] : null;

    if (loginEntry) {
      this.state.userId = loginEntry.userid || fallbackUserId;
      if (loginEntry.userkeyvalu) {
        this.state.userKeyValu = loginEntry.userkeyvalu;
      }
      if (loginEntry.clientid) {
        this.state.clientId = loginEntry.clientid;
      }
      this.state.loginInfo = loginEntry;
    }
    if (complexEntry) {
      this.state.complexInfo = complexEntry;
    }
    if (Array.isArray(res?.smartmodelist)) {
      this.state.smartModes = res.smartmodelist;
    }
  }

  /**
   * Unlock screen PIN (`SimpleLoginFragment.V()` -> `POST /hiot-web/login/exeunlockingscreen`).
   * Also updates session cookies via `Set-Cookie`.
   * @param {string} pin
   */
  async unlockScreen(pin) {
    if (!this.state.userId) {
      throw new HiotApiError('userId is not set; login first');
    }
    return this.rawRequest('POST', '/hiot-web/login/exeunlockingscreen', {
      body: {
        condition: {
          userid: this.state.userId,
          screenlockpasswordvalu: String(pin).trim(),
        },
      },
      allowAutoRelogin: false,
    });
  }

  /**
   * Server logout (`POST /hiot-web/login/exelogout`) and local session cleanup.
   */
  async logout() {
    try {
      if (this.state.userId) {
        await this.rawRequest('POST', '/hiot-web/login/exelogout', {
          body: { condition: { userid: this.state.userId } },
          allowAutoRelogin: false,
        });
      }
    } finally {
      await this.clearSession();
    }
  }

  // ===========================================================================
  // 1. VoiceHome Natural-Language & serviceID Control API (voicehome.autoever.com)
  // ===========================================================================

  /**
   * Send a Korean natural-language command or status query to VoiceHome (`VoiceHomeFragment.n0()`),
   * and automatically execute the follow-up device control (`VoiceHomeFragment.h0()`) when
   * `HAEvhRes[0].addControlRequest === "true"`.
   *
   * Examples of `text`:
   * - `"거실 조명 켜줘"` / `"거실 조명 꺼줘"`
   * - `"안방 난방 24도로 설정해줘"` / `"거실 에어컨 켜줘"`
   * - `"가스밸브 잠가줘"` / `"환기 켜줘"`
   * - `"엘리베이터 호출해줘"`
   * - `"집안 상태 알려줘"` / `"거실 조명 상태 알려줘"`
   *
   * @param {string} text Korean command string (`recogText`)
   * @param {object} [options]
   * @param {boolean} [options.autoControl=true] Automatically invoke `/voicehome/device/control` when `addControlRequest` is `"true"`
   * @param {number} [options.latitude=0.0]
   * @param {number} [options.longitude=0.0]
   * @param {string} [options.spaceType]
   */
  async voiceCommand(text, options = {}) {
    const {
      autoControl = true,
      latitude = 0.0,
      longitude = 0.0,
      spaceType,
    } = options;

    if (typeof text !== 'string' || !text.trim()) {
      throw new TypeError('voiceCommand(text) requires a non-empty Korean command string');
    }

    const sttBody = {
      HAEvhReq: [
        {
          messageType: 'conversation',
          devType: 'MOB',
          devID: this.state.clientId,
          mac: '',
          swVersion: '0.6',
          timeStamp: formatKstTimestamp(),
          recogText: text.trim(),
          location: {
            latitude: Number(latitude) || 0.0,
            longitude: Number(longitude) || 0.0,
          },
        },
      ],
    };

    const conversationResponse = await this.rawRequest('POST', '/voicehome/cvs/request', {
      server: 'voice',
      body: sttBody,
    });

    const intentItem = Array.isArray(conversationResponse?.HAEvhRes)
      ? conversationResponse.HAEvhRes[0]
      : null;

    if (intentItem?.errCode) {
      throw new HiotApiError(
        intentItem.errMsg || `VoiceHome error (${intentItem.errCode})`,
        {
          code: intentItem.errCode,
          endpoint: `${this.voiceHomeServerUrl}/voicehome/cvs/request`,
          payload: conversationResponse,
        }
      );
    }

    const needsControl =
      String(intentItem?.addControlRequest ?? '').toLowerCase() === 'true' &&
      Boolean(intentItem?.serviceID);

    let controlResponse = null;
    if (autoControl && needsControl) {
      controlResponse = await this.controlByServiceId(intentItem.serviceID, { spaceType });
    }

    return {
      command: text.trim(),
      intent: intentItem,
      needsControl,
      executedControl: Boolean(controlResponse),
      control: Array.isArray(controlResponse?.HAEvhRes)
        ? controlResponse.HAEvhRes[0]
        : controlResponse,
      raw: {
        conversation: conversationResponse,
        control: controlResponse,
      },
    };
  }

  /**
   * Execute a home device control directly by VoiceHome `serviceID`
   * (`VoiceHomeFragment.h0()` -> `POST /voicehome/device/control`).
   *
   * @param {string} serviceId
   * @param {{ spaceType?: string }} [options]
   */
  async controlByServiceId(serviceId, options = {}) {
    if (!serviceId) {
      throw new TypeError('serviceId is required');
    }

    const reqEntry = {
      messageType: 'device',
      devType: 'MOB',
      devID: this.state.clientId,
      mac: '',
      serviceID: String(serviceId),
      swVersion: '0.6',
      timeStamp: formatKstTimestamp(),
    };
    if (options.spaceType !== undefined) {
      reqEntry.spaceType = options.spaceType;
    }

    const res = await this.rawRequest('POST', '/voicehome/device/control', {
      server: 'voice',
      body: { HAEvhReq: [reqEntry] },
    });

    const item = Array.isArray(res?.HAEvhRes) ? res.HAEvhRes[0] : null;
    if (item?.errCode) {
      throw new HiotApiError(item.errMsg || `VoiceHome control error (${item.errCode})`, {
        code: item.errCode,
        endpoint: `${this.voiceHomeServerUrl}/voicehome/device/control`,
        payload: res,
      });
    }

    return res;
  }

  // ===========================================================================
  // 1-B. Space / Device REST control (same calls as the server-hosted WebView
  //      controller pages HD-KMA-34-01..09: /space/getspace, /device/getdevices,
  //      /device/exedevicebatch). Works even when the complex has VoiceHome
  //      disabled (complex.voicesupportyn === 'N').
  // ===========================================================================

  /**
   * List devices placed in a single space (`POST /hiot-web/space/getspace`).
   * @param {number|string} spaceSq
   * @returns {Promise<Array<object>>}
   */
  async getSpaceDevices(spaceSq) {
    const res = await this.rawRequest('POST', '/hiot-web/space/getspace', {
      body: { condition: { spacesq: spaceSq } },
    });
    return Array.isArray(res?.space) ? res.space : [];
  }

  /**
   * List every device in the household (all spaces), annotated with `spacenm` / `spacesq`.
   * @param {{ types?: string[] }} [options] Optional `devicetypecd` filter (e.g. `LIGHT_DEVICE_TYPES`)
   * @returns {Promise<Array<object>>}
   */
  async listAllDevices({ types } = {}) {
    const spacesRes = await this.getSpaces();
    const spaces = Array.isArray(spacesRes?.spacelist) ? spacesRes.spacelist : [];
    const perSpace = await Promise.all(
      spaces.map(async (space) => {
        const devices = await this.getSpaceDevices(space.spacesq);
        return devices.map((d) => ({ ...d, spacenm: space.spacenm, spacesq: space.spacesq }));
      })
    );
    const all = perSpace.flat();
    if (Array.isArray(types) && types.length > 0) {
      const wanted = new Set(types.map((t) => t.toUpperCase()));
      return all.filter((d) => wanted.has(String(d.devicetypecd).toUpperCase()));
    }
    return all;
  }

  /**
   * List all lights (일반/디밍/색온도 조명) with their current on/off state.
   * @param {string} [space] Optional space name filter (e.g. `'거실'`)
   */
  async listLights(space) {
    const lights = await this.listAllDevices({ types: LIGHT_DEVICE_TYPES });
    return space ? lights.filter((d) => d.spacenm === space) : lights;
  }

  /**
   * Query detailed live status of several devices (`POST /hiot-web/device/getdevices`).
   * @param {string[]} deviceCds
   */
  async getDevicesStatus(deviceCds) {
    return this.rawRequest('POST', '/hiot-web/device/getdevices', {
      body: { device: deviceCds.map((devicecd) => ({ devicecd })) },
    });
  }

  /**
   * Batch control (`POST /hiot-web/device/exedevicebatch`), exactly as the WebView controller pages send it.
   * @param {Array<{ devicecd: string, resource: string, attribute: string, value: string|number }>} commands
   */
  async executeDeviceBatch(commands) {
    if (!Array.isArray(commands) || commands.length === 0) {
      throw new TypeError('executeDeviceBatch requires at least one command');
    }
    return this.rawRequest('POST', '/hiot-web/device/exedevicebatch', {
      body: { device: commands },
    });
  }

  /**
   * Resolve a user-friendly target into concrete devices.
   * Matching order: `devicecd` → exact `devicenm` → space name → partial `devicenm`.
   * `'전체'` / `'all'` / `'*'` selects every device of the given types.
   *
   * @param {string} target
   * @param {string[]} [types]
   */
  async resolveDevices(target, types) {
    const devices = await this.listAllDevices({ types });
    const t = String(target ?? '').trim();
    if (!t || ['전체', 'all', '*', '모두', '집안'].includes(t.toLowerCase())) return devices;

    const byCode = devices.filter((d) => d.devicecd === t);
    if (byCode.length) return byCode;
    const byName = devices.filter((d) => d.devicenm === t);
    if (byName.length) return byName;
    const bySpace = devices.filter((d) => d.spacenm === t);
    if (bySpace.length) return bySpace;
    return devices.filter((d) => String(d.devicenm).includes(t));
  }

  async #controlTargets(target, types, buildCommands, label) {
    const targets = await this.resolveDevices(target, types);
    if (targets.length === 0) {
      throw new HiotApiError(`'${target}'에 해당하는 ${label} 기기를 찾을 수 없습니다.`);
    }
    const commands = targets.flatMap(buildCommands);
    const response = await this.executeDeviceBatch(commands);
    return { kind: 'control', label, target, targets, commands, response };
  }

  /**
   * Generic power on/off for any device type.
   * @param {string} target devicecd / device name / space name / '전체'
   * @param {boolean} on
   * @param {string[]} [types]
   */
  async setPower(target, on, types) {
    return this.#controlTargets(
      target,
      types,
      (d) => [{ devicecd: d.devicecd, resource: 'operation', attribute: 'power', value: on ? 'on' : 'off' }],
      '전원'
    );
  }

  /**
   * Turn lights on/off (e.g. `setLight('거실', false)` turns off 거실1 & 거실2).
   * @param {string} target space name, light name (`'침실1-2'`), devicecd, or `'전체'`
   * @param {boolean} on
   */
  async setLight(target, on) {
    const res = await this.setPower(target, on, LIGHT_DEVICE_TYPES);
    return { ...res, label: '조명' };
  }

  /**
   * Turn wall sockets (전열콘센트) on/off.
   */
  async setOutlet(target, on) {
    const res = await this.setPower(target, on, ['WSK']);
    return { ...res, label: '콘센트' };
  }

  #climateCommands(on, temperature) {
    return (d) => {
      const turnOn = temperature !== undefined && temperature !== null ? true : Boolean(on);
      const cmds = [
        { devicecd: d.devicecd, resource: 'operation', attribute: 'power', value: turnOn ? 'on' : 'off' },
      ];
      if (turnOn && temperature !== undefined && temperature !== null) {
        cmds.push({ devicecd: d.devicecd, resource: 'temperature', attribute: 'desired', value: Number(temperature) });
      }
      return cmds;
    };
  }

  /**
   * Control heating power / desired temperature (HD-KMA-34-03 payload).
   * @param {string} target space name / device name / '전체'
   * @param {{ on?: boolean, temperature?: number }} options
   */
  async setHeating(target, { on, temperature } = {}) {
    return this.#controlTargets(target, ['HTR'], this.#climateCommands(on, temperature), '난방');
  }

  /**
   * Control system air conditioner power / desired temperature (HD-KMA-34-04 payload).
   */
  async setAirConditioner(target, { on, temperature } = {}) {
    return this.#controlTargets(target, ['ACB'], this.#climateCommands(on, temperature), '에어컨');
  }

  /**
   * Control ventilator power / air volume (HD-KMA-34-09 payload, airvolume 1=약, 2=중, 3=강).
   * @param {boolean} on
   * @param {{ space?: string, airVolume?: number }} [options]
   */
  async setVentilator(on, { space = '전체', airVolume } = {}) {
    return this.#controlTargets(
      space || '전체',
      ['VNT'],
      (d) => {
        const cmds = [{ devicecd: d.devicecd, resource: 'operation', attribute: 'power', value: on ? 'on' : 'off' }];
        if (on && airVolume) {
          cmds.push({ devicecd: d.devicecd, resource: 'mode', attribute: 'airvolume', value: Number(airVolume) });
        }
        return cmds;
      },
      '환기'
    );
  }

  /**
   * Close the gas valve (HD-KMA-32-03 payload: `/device/exedevice` with `valve.lock = "off"`,
   * which is what the app sends when the user switches an open valve OFF).
   */
  async closeGasValve() {
    const targets = await this.listAllDevices({ types: ['GDK'] });
    if (targets.length === 0) {
      throw new HiotApiError('이 세대에 등록된 가스밸브(GDK) 기기가 없습니다.');
    }
    const responses = [];
    for (const d of targets) {
      responses.push(
        await this.rawRequest('POST', '/hiot-web/device/exedevice', {
          body: { device: { devicecd: d.devicecd, resource: 'valve' }, valve: { lock: 'off' } },
        })
      );
    }
    return { kind: 'control', label: '가스밸브', target: '전체', targets, response: responses };
  }

  /**
   * Call the elevator (`POST /hiot-web/homenet/execallelevator`, HD-KMA-11-01).
   */
  async callElevator() {
    const response = await this.rawRequest('POST', '/hiot-web/homenet/execallelevator', { body: {} });
    return { kind: 'control', label: '엘리베이터 호출', target: '-', targets: [], response };
  }

  /**
   * Household status snapshot: every device grouped by space with on/off state.
   * @param {string} [target='집안'] '집안' for everything, or a space / device name
   */
  async queryHomeStatus(target = '집안') {
    const devices = await this.resolveDevices(target);
    return { kind: 'status', target, devices };
  }

  // ===========================================================================
  // 2. Direct REST Endpoints on Main Server (home.hiot.autoever.com:8443)
  // ===========================================================================

  /**
   * List household spaces (`POST /hiot-web/space/getspacelist`).
   */
  async getSpaces() {
    const body = this.state.userId ? { condition: { userid: this.state.userId } } : {};
    return this.rawRequest('POST', '/hiot-web/space/getspacelist', { body });
  }

  /**
   * List supported homenet services for the apartment complex (`GET /hiot-web/homenet/gethomenetservicelist`).
   */
  async getHomenetServices() {
    return this.rawRequest('GET', '/hiot-web/homenet/gethomenetservicelist');
  }

  /**
   * List services by category (`POST /hiot-web/homenet/getservicelist`, e.g. `'LVNG'` or `'CARS'`).
   * @param {string} [serviceCategoryCd='LVNG']
   */
  async getServices(serviceCategoryCd = 'LVNG') {
    return this.rawRequest('POST', '/hiot-web/homenet/getservicelist', {
      body: { condition: { servicecategorycd: serviceCategoryCd } },
    });
  }

  /**
   * List registered devices (`POST /hiot-web/device/getdevicelist`).
   * @param {string} [deviceTypeCd=''] Optional filter by `devicetypecd`
   */
  async getDevices(deviceTypeCd = '') {
    return this.rawRequest('POST', '/hiot-web/device/getdevicelist', {
      body: { condition: { devicetypecd: deviceTypeCd } },
    });
  }

  /**
   * Query detailed state & configuration of a specific device (`POST /hiot-web/device/getdevice`).
   * @param {string} deviceCd
   */
  async getDevice(deviceCd) {
    if (!deviceCd) throw new TypeError('deviceCd is required');
    return this.rawRequest('POST', '/hiot-web/device/getdevice', {
      body: { device: { devicecd: String(deviceCd) } },
    });
  }

  /**
   * Execute direct device control/configuration (`POST /hiot-web/device/exedevice`).
   *
   * @param {object} params
   * @param {string} params.deviceCd
   * @param {string} [params.resource]
   * @param {Record<string, unknown>} [params.configuration]
   * @param {Record<string, unknown>} [params.operation]
   * @param {Record<string, unknown>} [params.extra] Additional top-level payload properties if needed
   */
  async executeDevice({ deviceCd, resource, configuration, operation, extra = {} }) {
    if (!deviceCd) throw new TypeError('deviceCd is required');
    const deviceObj = { devicecd: String(deviceCd) };
    if (resource !== undefined) {
      deviceObj.resource = String(resource);
    }

    const body = {
      ...extra,
      device: deviceObj,
    };
    if (configuration !== undefined) body.configuration = configuration;
    if (operation !== undefined) body.operation = operation;

    return this.rawRequest('POST', '/hiot-web/device/exedevice', { body });
  }

  /**
   * Execute a Smart Mode (`POST /hiot-web/mode/exemode` or `POST /hiot-web/mode/exedstmode`).
   * Smart mode codes (`modecd`) are returned in `login().smartmodelist` (`this.state.smartModes`).
   *
   * @param {string} modeCd
   * @param {{ useDstEndpoint?: boolean }} [options]
   */
  async executeSmartMode(modeCd, { useDstEndpoint = false } = {}) {
    if (!modeCd) throw new TypeError('modeCd is required');
    if (useDstEndpoint) {
      return this.rawRequest('POST', '/hiot-web/mode/exedstmode', {
        body: { condition: { operandvalu: String(modeCd) } },
      });
    }
    return this.rawRequest('POST', '/hiot-web/mode/exemode', {
      body: { condition: { modecd: String(modeCd) } },
    });
  }

  // ===========================================================================
  // 3. Server-Hosted WebView Controller Inspector
  // ===========================================================================

  /**
   * Fetch one of the server-hosted WebView JSP controller pages (`space`, `device`, `mode`, `elevator`)
   * or a custom `/hiot-app/*` path using the active authenticated session cookies, and extract
   * any complex-specific AJAX endpoints referenced inside the HTML/JS.
   *
   * @param {keyof typeof WEB_CONTROLLER_PAGES | string} pageKeyOrPath
   */
  async fetchControllerPage(pageKeyOrPath) {
    const targetPath = WEB_CONTROLLER_PAGES[pageKeyOrPath] ?? pageKeyOrPath;
    const { status, text } = await this.rawRequest('GET', targetPath, {
      responseType: 'text',
    });
    return {
      path: targetPath,
      status,
      discoveredEndpoints: extractAjaxEndpointsFromHtml(text),
      html: text,
    };
  }
}
