import http from 'node:http';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import mqtt from 'mqtt';
import {
  HiotClient,
  HiotApiError,
  DEVICE_TYPE_NAMES,
  LIGHT_DEVICE_TYPES,
} from './hiot-client.js';

export class HiotHaBridge {
  constructor(options = {}) {
    this.options = {
      hiotUserId: options.hiotUserId || process.env.HIOT_USER_ID || '',
      hiotPassword: options.hiotPassword || process.env.HIOT_PASSWORD || '',
      hiotPin: options.hiotPin || process.env.HIOT_PIN || '',
      mqttHost: options.mqttHost || process.env.MQTT_HOST || '127.0.0.1',
      mqttPort: Number(options.mqttPort || process.env.MQTT_PORT || 1883),
      mqttUser: options.mqttUser || process.env.MQTT_USER || '',
      mqttPassword: options.mqttPassword || process.env.MQTT_PASSWORD || '',
      discoveryPrefix: options.discoveryPrefix || process.env.DISCOVERY_PREFIX || 'homeassistant',
      topicPrefix: options.topicPrefix || process.env.TOPIC_PREFIX || 'hiot',
      pollingIntervalSec: Number(options.pollingIntervalSec || process.env.POLLING_INTERVAL_SEC || 30),
      sessionFile: options.sessionFile || process.env.HIOT_SESSION_FILE || (existsSync('/data') ? '/data/.hiot-session.json' : './.hiot-session.json'),
      webPort: Number(options.webPort || process.env.INGRESS_PORT || process.env.PORT || 8099),
      ...options,
    };

    this.client = new HiotClient({ sessionFile: this.options.sessionFile });
    this.mqttClient = null;
    this.httpServer = null;
    this.devices = new Map(); // devicecd -> device info & state
    this.climateDetails = new Map(); // devicecd -> { currentTemp, desiredTemp, power }
    this.pollingTimer = null;
    this.isRunning = false;
    this.logs = [];
    this.maxLogs = 100;
  }

  log(level, message, meta = null) {
    const time = new Date().toISOString().substring(11, 19);
    const entry = { time, level, message, meta };
    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) this.logs.shift();
    const metaStr = meta ? ` ${typeof meta === 'object' ? JSON.stringify(meta) : meta}` : '';
    console.log(`[${time}] [${level.toUpperCase()}] ${message}${metaStr}`);
  }

  /**
   * Load add-on options from /data/options.json if available (Home Assistant Add-on runtime)
   */
  static loadHaOptions() {
    const haOptionsPath = '/data/options.json';
    if (existsSync(haOptionsPath)) {
      try {
        const raw = readFileSync(haOptionsPath, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          hiotUserId: parsed.hiot_user_id,
          hiotPassword: parsed.hiot_password,
          hiotPin: parsed.hiot_pin,
          mqttHost: parsed.mqtt_host,
          mqttPort: parsed.mqtt_port,
          mqttUser: parsed.mqtt_user,
          mqttPassword: parsed.mqtt_password,
          discoveryPrefix: parsed.discovery_prefix,
          topicPrefix: parsed.topic_prefix,
          pollingIntervalSec: parsed.polling_interval_sec,
        };
      } catch (err) {
        console.error('Failed to parse /data/options.json:', err.message);
      }
    }
    return {};
  }

  async start() {
    this.isRunning = true;
    this.log('info', 'Starting Hi-oT Home Assistant Bridge...');

    // 1. Authenticate with Hi-oT
    await this.initHiot();

    // 2. Connect to MQTT Broker
    await this.initMqtt();

    // 3. Start Web UI / Ingress HTTP Server
    await this.initHttp();

    // 4. Initial device scan & publish discovery
    await this.refreshDevices(true);

    // 5. Start Polling Loop
    const intervalMs = Math.max(10, this.options.pollingIntervalSec) * 1000;
    this.pollingTimer = setInterval(() => {
      this.refreshDevices(false).catch((err) => {
        this.log('error', `Periodic device refresh failed: ${err.message}`);
      });
    }, intervalMs);

    this.log('info', `Hi-oT HA Bridge is active. Polling every ${this.options.pollingIntervalSec}s.`);
  }

  async stop() {
    this.isRunning = false;
    if (this.pollingTimer) clearInterval(this.pollingTimer);

    if (this.mqttClient) {
      const willTopic = `${this.options.topicPrefix}/status`;
      await new Promise((resolve) => {
        this.mqttClient.publish(willTopic, 'offline', { retain: true }, () => {
          this.mqttClient.end(false, resolve);
        });
      });
    }

    if (this.httpServer) {
      await new Promise((resolve) => this.httpServer.close(resolve));
    }

    this.log('info', 'Hi-oT HA Bridge stopped.');
  }

  async initHiot() {
    const hasSession = await this.client.loadSession();
    if (hasSession && this.client.state.userId) {
      this.log('info', `Loaded existing Hi-oT session for user: ${this.client.state.userId}`);
      return;
    }

    const { hiotUserId, hiotPassword, hiotPin } = this.options;
    if (!hiotUserId || !hiotPassword) {
      throw new Error(
        'Hi-oT credentials missing. Please set hiot_user_id and hiot_password in add-on options or environment variables.'
      );
    }

    this.log('info', `Logging into Hi-oT as ${hiotUserId}...`);
    await this.client.login({
      userId: hiotUserId,
      password: hiotPassword,
      pin: hiotPin,
    });
    this.log('info', `Hi-oT login successful: ${this.client.state.loginInfo?.usernm || hiotUserId}`);
  }

  async initMqtt() {
    const { mqttHost, mqttPort, mqttUser, mqttPassword, topicPrefix } = this.options;
    const url = `mqtt://${mqttHost}:${mqttPort}`;
    this.log('info', `Connecting to MQTT broker at ${url}...`);

    return new Promise((resolve, reject) => {
      const client = mqtt.connect(url, {
        username: mqttUser || undefined,
        password: mqttPassword || undefined,
        will: {
          topic: `${topicPrefix}/status`,
          payload: 'offline',
          retain: true,
          qos: 1,
        },
        reconnectPeriod: 5000,
      });

      let initialResolved = false;

      client.on('connect', () => {
        this.log('info', `Connected to MQTT broker: ${url}`);
        client.publish(`${topicPrefix}/status`, 'online', { retain: true, qos: 1 });

        // Subscribe to all command topics
        const commandSub = `${topicPrefix}/+/+/set`;
        const subCommandSub = `${topicPrefix}/+/+/+/set`;
        const buttonSub = `${topicPrefix}/button/+/press`;

        client.subscribe([commandSub, subCommandSub, buttonSub], (err) => {
          if (err) this.log('error', `Failed to subscribe to MQTT commands: ${err.message}`);
          else this.log('info', `Subscribed to command topics: ${commandSub}, ${subCommandSub}, ${buttonSub}`);
        });

        if (!initialResolved) {
          initialResolved = true;
          this.mqttClient = client;
          resolve();
        }
      });

      client.on('message', (topic, payload) => {
        this.handleMqttMessage(topic, payload.toString().trim()).catch((err) => {
          this.log('error', `Error processing MQTT message on ${topic}: ${err.message}`);
        });
      });

      client.on('error', (err) => {
        this.log('error', `MQTT error: ${err.message}`);
        if (!initialResolved) {
          initialResolved = true;
          reject(err);
        }
      });

      client.on('offline', () => {
        this.log('warn', 'MQTT connection offline.');
      });
    });
  }

  async publish(topic, payload, options = {}) {
    if (!this.mqttClient) return;
    const msg = typeof payload === 'object' ? JSON.stringify(payload) : String(payload);
    return new Promise((resolve, reject) => {
      this.mqttClient.publish(topic, msg, { qos: 0, ...options }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Scan all household devices and publish Home Assistant MQTT discovery payloads
   */
  async refreshDevices(isFirstDiscovery = false) {
    try {
      const list = await this.client.listAllDevices();
      const updatedCodes = new Set();

      for (const d of list) {
        updatedCodes.add(d.devicecd);
        const oldState = this.devices.get(d.devicecd);
        this.devices.set(d.devicecd, d);

        if (isFirstDiscovery) {
          await this.publishDiscovery(d);
        }

        // Publish state if changed or on initial discovery
        if (isFirstDiscovery || !oldState || oldState.attributevalu !== d.attributevalu) {
          await this.publishDeviceState(d);
        }

        // For climate devices (HTR, ACB), fetch detailed temperature on first discovery or periodically
        if (['HTR', 'ACB', 'VNT'].includes(d.devicetypecd)) {
          this.fetchClimateDetail(d.devicecd).catch(() => {});
        }
      }

      if (isFirstDiscovery) {
        // Publish Elevator button discovery
        await this.publishElevatorDiscovery();

        // Publish Smart Mode buttons
        await this.publishSmartModeDiscovery();
      }
    } catch (err) {
      this.log('error', `Failed to list devices: ${err.message}`);
    }
  }

  async fetchClimateDetail(devicecd) {
    try {
      const detail = await this.client.getDevice(devicecd);
      const tempObj = detail?.temperature?.[0];
      const opObj = detail?.operation?.[0];
      const modeObj = detail?.mode?.[0];
      const windObj = detail?.wind?.[0];

      const currentTemp = tempObj?.current ? Number(tempObj.current) : null;
      const desiredTemp = tempObj?.desired ? Number(tempObj.desired) : null;
      const power = opObj?.power || 'off';

      this.climateDetails.set(devicecd, {
        currentTemp,
        desiredTemp,
        power,
        mode: modeObj?.mode,
        speed: windObj?.speedlevel || modeObj?.airvolume,
      });

      const dev = this.devices.get(devicecd);
      if (dev) {
        await this.publishDeviceState(dev);
      }
    } catch {
      // Ignore individual detail fetch errors
    }
  }

  getDeviceInfo(d) {
    const household = this.client.state.loginInfo?.householdcd || 'home';
    const complex = this.client.state.loginInfo?.complexnm || 'Hillstate';
    const typeName = DEVICE_TYPE_NAMES[d.devicetypecd] || d.devicetypecd;
    return {
      identifiers: [`hiot_${household}_${d.devicecd}`],
      name: `${d.spacenm ? `[${d.spacenm}] ` : ''}${d.devicenm}`,
      model: `Hi-oT ${typeName}`,
      manufacturer: 'Hyundai AutoEver',
      suggested_area: d.spacenm || undefined,
    };
  }

  async publishDiscovery(d) {
    const { discoveryPrefix, topicPrefix } = this.options;
    const type = d.devicetypecd;

    // 1. LIGHTS (LGT, DLT, CLT)
    if (LIGHT_DEVICE_TYPES.includes(type)) {
      const configTopic = `${discoveryPrefix}/light/hiot_${d.devicecd}/config`;
      const payload = {
        name: d.devicenm,
        unique_id: `hiot_${d.devicecd}`,
        state_topic: `${topicPrefix}/light/${d.devicecd}/state`,
        command_topic: `${topicPrefix}/light/${d.devicecd}/set`,
        payload_on: 'ON',
        payload_off: 'OFF',
        availability_topic: `${topicPrefix}/status`,
        payload_available: 'online',
        payload_not_available: 'offline',
        device: this.getDeviceInfo(d),
      };
      await this.publish(configTopic, payload, { retain: true });
      return;
    }

    // 2. OUTLETS / WALL SOCKETS (WSK)
    if (type === 'WSK') {
      const configTopic = `${discoveryPrefix}/switch/hiot_${d.devicecd}/config`;
      const payload = {
        name: `${d.devicenm} 콘센트`,
        unique_id: `hiot_${d.devicecd}`,
        state_topic: `${topicPrefix}/switch/${d.devicecd}/state`,
        command_topic: `${topicPrefix}/switch/${d.devicecd}/set`,
        payload_on: 'ON',
        payload_off: 'OFF',
        device_class: 'outlet',
        availability_topic: `${topicPrefix}/status`,
        device: this.getDeviceInfo(d),
      };
      await this.publish(configTopic, payload, { retain: true });
      return;
    }

    // 3. HEATING / THERMOSTAT (HTR)
    if (type === 'HTR') {
      const configTopic = `${discoveryPrefix}/climate/hiot_${d.devicecd}/config`;
      const payload = {
        name: `${d.spacenm || ''} 난방`,
        unique_id: `hiot_${d.devicecd}`,
        mode_state_topic: `${topicPrefix}/climate/${d.devicecd}/mode_state`,
        mode_command_topic: `${topicPrefix}/climate/${d.devicecd}/mode_set`,
        temperature_state_topic: `${topicPrefix}/climate/${d.devicecd}/temp_state`,
        temperature_command_topic: `${topicPrefix}/climate/${d.devicecd}/temp_set`,
        current_temperature_topic: `${topicPrefix}/climate/${d.devicecd}/cur_temp`,
        modes: ['off', 'heat'],
        min_temp: 5,
        max_temp: 35,
        temp_step: 1,
        temperature_unit: 'C',
        availability_topic: `${topicPrefix}/status`,
        device: this.getDeviceInfo(d),
      };
      await this.publish(configTopic, payload, { retain: true });
      return;
    }

    // 4. AIR CONDITIONER (ACB)
    if (type === 'ACB') {
      const configTopic = `${discoveryPrefix}/climate/hiot_${d.devicecd}/config`;
      const payload = {
        name: `${d.spacenm || ''} 에어컨`,
        unique_id: `hiot_${d.devicecd}`,
        mode_state_topic: `${topicPrefix}/climate/${d.devicecd}/mode_state`,
        mode_command_topic: `${topicPrefix}/climate/${d.devicecd}/mode_set`,
        temperature_state_topic: `${topicPrefix}/climate/${d.devicecd}/temp_state`,
        temperature_command_topic: `${topicPrefix}/climate/${d.devicecd}/temp_set`,
        current_temperature_topic: `${topicPrefix}/climate/${d.devicecd}/cur_temp`,
        modes: ['off', 'cool'],
        min_temp: 18,
        max_temp: 30,
        temp_step: 1,
        temperature_unit: 'C',
        availability_topic: `${topicPrefix}/status`,
        device: this.getDeviceInfo(d),
      };
      await this.publish(configTopic, payload, { retain: true });
      return;
    }

    // 5. VENTILATION (VNT)
    if (type === 'VNT') {
      const configTopic = `${discoveryPrefix}/fan/hiot_${d.devicecd}/config`;
      const payload = {
        name: `${d.spacenm || ''} 환기`,
        unique_id: `hiot_${d.devicecd}`,
        state_topic: `${topicPrefix}/fan/${d.devicecd}/state`,
        command_topic: `${topicPrefix}/fan/${d.devicecd}/set`,
        payload_on: 'ON',
        payload_off: 'OFF',
        availability_topic: `${topicPrefix}/status`,
        device: this.getDeviceInfo(d),
      };
      await this.publish(configTopic, payload, { retain: true });
      return;
    }

    // 6. GENERAL SWITCH (SWT)
    if (type === 'SWT') {
      const configTopic = `${discoveryPrefix}/switch/hiot_${d.devicecd}/config`;
      const payload = {
        name: `${d.spacenm || ''} ${d.devicenm} 일괄스위치`,
        unique_id: `hiot_${d.devicecd}`,
        state_topic: `${topicPrefix}/switch/${d.devicecd}/state`,
        command_topic: `${topicPrefix}/switch/${d.devicecd}/set`,
        payload_on: 'ON',
        payload_off: 'OFF',
        availability_topic: `${topicPrefix}/status`,
        device: this.getDeviceInfo(d),
      };
      await this.publish(configTopic, payload, { retain: true });
      return;
    }
  }

  async publishElevatorDiscovery() {
    const { discoveryPrefix, topicPrefix } = this.options;
    const household = this.client.state.loginInfo?.householdcd || 'home';
    const configTopic = `${discoveryPrefix}/button/hiot_elevator/config`;
    const payload = {
      name: '엘리베이터 호출',
      unique_id: `hiot_${household}_elevator`,
      command_topic: `${topicPrefix}/button/elevator/press`,
      payload_press: 'PRESS',
      icon: 'mdi:elevator-passenger',
      availability_topic: `${topicPrefix}/status`,
      device: {
        identifiers: [`hiot_${household}_homenet`],
        name: 'Hi-oT 홈넷 시스템',
        model: 'Hi-oT HomeNet',
        manufacturer: 'Hyundai AutoEver',
      },
    };
    await this.publish(configTopic, payload, { retain: true });
  }

  async publishSmartModeDiscovery() {
    const { discoveryPrefix, topicPrefix } = this.options;
    const household = this.client.state.loginInfo?.householdcd || 'home';
    const modes = this.client.state.smartModes || [];

    for (const m of modes) {
      const modeCd = m.modecd;
      const configTopic = `${discoveryPrefix}/button/hiot_mode_${modeCd}/config`;
      const payload = {
        name: `스마트모드 ${modeCd}`,
        unique_id: `hiot_${household}_mode_${modeCd}`,
        command_topic: `${topicPrefix}/button/mode_${modeCd}/press`,
        payload_press: 'PRESS',
        icon: 'mdi:home-automation',
        availability_topic: `${topicPrefix}/status`,
        device: {
          identifiers: [`hiot_${household}_homenet`],
          name: 'Hi-oT 홈넷 시스템',
          model: 'Hi-oT HomeNet',
          manufacturer: 'Hyundai AutoEver',
        },
      };
      await this.publish(configTopic, payload, { retain: true });
    }
  }

  async publishDeviceState(d) {
    const { topicPrefix } = this.options;
    const type = d.devicetypecd;
    const isOn = d.attributevalu === 'on';

    if (LIGHT_DEVICE_TYPES.includes(type)) {
      await this.publish(`${topicPrefix}/light/${d.devicecd}/state`, isOn ? 'ON' : 'OFF', { retain: true });
      return;
    }

    if (['WSK', 'SWT'].includes(type)) {
      await this.publish(`${topicPrefix}/switch/${d.devicecd}/state`, isOn ? 'ON' : 'OFF', { retain: true });
      return;
    }

    if (type === 'VNT') {
      await this.publish(`${topicPrefix}/fan/${d.devicecd}/state`, isOn ? 'ON' : 'OFF', { retain: true });
      return;
    }

    if (['HTR', 'ACB'].includes(type)) {
      const detail = this.climateDetails.get(d.devicecd) || {};
      const activeMode = type === 'HTR' ? 'heat' : 'cool';
      const mode = (detail.power || d.attributevalu) === 'on' ? activeMode : 'off';

      await this.publish(`${topicPrefix}/climate/${d.devicecd}/mode_state`, mode, { retain: true });
      if (detail.desiredTemp !== undefined && detail.desiredTemp !== null) {
        await this.publish(`${topicPrefix}/climate/${d.devicecd}/temp_state`, String(detail.desiredTemp), {
          retain: true,
        });
      }
      if (detail.currentTemp !== undefined && detail.currentTemp !== null) {
        await this.publish(`${topicPrefix}/climate/${d.devicecd}/cur_temp`, String(detail.currentTemp), {
          retain: true,
        });
      }
    }
  }

  async handleMqttMessage(topic, payload) {
    const { topicPrefix } = this.options;
    this.log('info', `Received MQTT Command: ${topic} => ${payload}`);

    // Elevator Button: hiot/button/elevator/press
    if (topic === `${topicPrefix}/button/elevator/press`) {
      await this.client.callElevator();
      this.log('info', 'Elevator called successfully via MQTT button');
      return;
    }

    // Smart Mode Button: hiot/button/mode_{modecd}/press
    const modeMatch = topic.match(new RegExp(`^${topicPrefix}/button/mode_([^/]+)/press$`));
    if (modeMatch) {
      const modeCd = modeMatch[1];
      await this.client.executeSmartMode(modeCd);
      this.log('info', `Smart Mode ${modeCd} executed via MQTT button`);
      return;
    }

    // Device Controls: hiot/{component}/{devicecd}/{action}
    const match = topic.match(new RegExp(`^${topicPrefix}/([^/]+)/([^/]+)/([^/]+)$`));
    if (!match) return;

    const [, component, devicecd, action] = match;
    const device = this.devices.get(devicecd);

    // 1. LIGHT
    if (component === 'light' && action === 'set') {
      const on = payload.toUpperCase() === 'ON';
      await this.client.executeDeviceBatch([
        { devicecd, resource: 'operation', attribute: 'power', value: on ? 'on' : 'off' },
      ]);
      if (device) device.attributevalu = on ? 'on' : 'off';
      await this.publish(`${topicPrefix}/light/${devicecd}/state`, on ? 'ON' : 'OFF', { retain: true });
      this.log('info', `Light ${devicecd} turned ${on ? 'ON' : 'OFF'}`);
      return;
    }

    // 2. SWITCH / OUTLET
    if (component === 'switch' && action === 'set') {
      const on = payload.toUpperCase() === 'ON';
      await this.client.executeDeviceBatch([
        { devicecd, resource: 'operation', attribute: 'power', value: on ? 'on' : 'off' },
      ]);
      if (device) device.attributevalu = on ? 'on' : 'off';
      await this.publish(`${topicPrefix}/switch/${devicecd}/state`, on ? 'ON' : 'OFF', { retain: true });
      this.log('info', `Switch ${devicecd} turned ${on ? 'ON' : 'OFF'}`);
      return;
    }

    // 3. FAN / VENTILATION
    if (component === 'fan' && action === 'set') {
      const on = payload.toUpperCase() === 'ON';
      await this.client.executeDeviceBatch([
        { devicecd, resource: 'operation', attribute: 'power', value: on ? 'on' : 'off' },
      ]);
      if (device) device.attributevalu = on ? 'on' : 'off';
      await this.publish(`${topicPrefix}/fan/${devicecd}/state`, on ? 'ON' : 'OFF', { retain: true });
      this.log('info', `Fan ${devicecd} turned ${on ? 'ON' : 'OFF'}`);
      return;
    }

    // 4. CLIMATE (HTR / ACB)
    if (component === 'climate') {
      if (action === 'mode_set') {
        const mode = payload.toLowerCase();
        const turnOn = mode !== 'off';
        await this.client.executeDeviceBatch([
          { devicecd, resource: 'operation', attribute: 'power', value: turnOn ? 'on' : 'off' },
        ]);
        const detail = this.climateDetails.get(devicecd) || {};
        detail.power = turnOn ? 'on' : 'off';
        this.climateDetails.set(devicecd, detail);
        if (device) device.attributevalu = turnOn ? 'on' : 'off';
        await this.publish(`${topicPrefix}/climate/${devicecd}/mode_state`, mode, { retain: true });
        this.log('info', `Climate ${devicecd} mode set to ${mode}`);
        return;
      }

      if (action === 'temp_set') {
        const temp = Number(payload);
        if (Number.isFinite(temp)) {
          await this.client.executeDeviceBatch([
            { devicecd, resource: 'operation', attribute: 'power', value: 'on' },
            { devicecd, resource: 'temperature', attribute: 'desired', value: temp },
          ]);
          const detail = this.climateDetails.get(devicecd) || {};
          detail.power = 'on';
          detail.desiredTemp = temp;
          this.climateDetails.set(devicecd, detail);
          if (device) device.attributevalu = 'on';
          await this.publish(`${topicPrefix}/climate/${devicecd}/temp_state`, String(temp), { retain: true });
          this.log('info', `Climate ${devicecd} target temperature set to ${temp}°C`);
        }
        return;
      }
    }
  }

  // ===========================================================================
  // Web UI & Ingress HTTP Server
  // ===========================================================================

  async initHttp() {
    const port = this.options.webPort;
    this.httpServer = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    await new Promise((resolve) => {
      this.httpServer.listen(port, '0.0.0.0', () => {
        this.log('info', `Ingress / Web UI server listening on port ${port}`);
        resolve();
      });
    });
  }

  handleHttpRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // CORS & JSON helpers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname.endsWith('/api/status')) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      const deviceList = Array.from(this.devices.values()).map((d) => ({
        ...d,
        climate: this.climateDetails.get(d.devicecd),
      }));
      res.end(
        JSON.stringify({
          status: 'online',
          user: this.client.state.userId,
          loginInfo: this.client.state.loginInfo,
          mqttConnected: Boolean(this.mqttClient?.connected),
          deviceCount: this.devices.size,
          devices: deviceList,
          smartModes: this.client.state.smartModes || [],
          logs: this.logs.slice(-30),
        })
      );
      return;
    }

    if (pathname.endsWith('/api/control') && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          const { devicecd, resource = 'operation', attribute = 'power', value } = data;
          await this.client.executeDeviceBatch([{ devicecd, resource, attribute, value }]);
          await this.refreshDevices(false);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (pathname.endsWith('/api/sync') && req.method === 'POST') {
      this.refreshDevices(false)
        .then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, count: this.devices.size }));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      return;
    }

    if (pathname.endsWith('/api/elevator') && req.method === 'POST') {
      this.client
        .callElevator()
        .then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, result }));
        })
        .catch((err) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        });
      return;
    }

    // Serve HTML Dashboard
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(this.renderDashboardHtml());
  }

  renderDashboardHtml() {
    const complex = this.client.state.loginInfo?.complexnm || '힐스테이트';
    const dong = this.client.state.loginInfo?.buildingno || '';
    const ho = this.client.state.loginInfo?.householdno || '';
    const user = this.client.state.loginInfo?.usernm || this.client.state.userId || '사용자';

    return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Hi-oT Smart Home Bridge</title>
  <style>
    :root {
      --bg: #0f172a;
      --card-bg: #1e293b;
      --card-border: #334155;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0ea5e9;
      --success: #22c55e;
      --danger: #ef4444;
      --card-active: #1e3a5f;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
    body { background: var(--bg); color: var(--text); padding: 20px; line-height: 1.5; }
    .header { display: flex; justify-content: space-between; align-items: center; padding-bottom: 16px; border-bottom: 1px solid var(--card-border); margin-bottom: 20px; flex-wrap: wrap; gap: 10px; }
    .title-group h1 { font-size: 1.4rem; font-weight: 700; color: var(--primary); display: flex; align-items: center; gap: 8px; }
    .title-group p { font-size: 0.85rem; color: var(--text-muted); }
    .badge-group { display: flex; gap: 8px; align-items: center; }
    .badge { padding: 4px 10px; border-radius: 9999px; font-size: 0.75rem; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; }
    .badge-success { background: rgba(34, 197, 94, 0.2); color: var(--success); border: 1px solid var(--success); }
    .btn { background: var(--primary); color: #000; border: none; padding: 8px 14px; border-radius: 6px; font-weight: 600; cursor: pointer; transition: 0.2s; font-size: 0.85rem; }
    .btn:hover { background: var(--primary-hover); }
    .btn-secondary { background: #334155; color: var(--text); }
    .btn-secondary:hover { background: #475569; }
    .btn-danger { background: var(--danger); color: #fff; }
    .space-section { margin-bottom: 24px; }
    .space-title { font-size: 1.1rem; font-weight: 600; margin-bottom: 12px; display: flex; align-items: center; gap: 6px; color: #e2e8f0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 14px; }
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 10px; padding: 14px; display: flex; flex-direction: column; justify-content: space-between; transition: 0.2s; }
    .card:hover { border-color: var(--primary); }
    .card.active { border-color: var(--primary); background: var(--card-active); }
    .card-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px; }
    .card-name { font-size: 0.95rem; font-weight: 600; }
    .card-type { font-size: 0.75rem; color: var(--text-muted); }
    .toggle-btn { padding: 6px 12px; border-radius: 6px; border: none; font-weight: 700; cursor: pointer; font-size: 0.8rem; }
    .toggle-on { background: var(--success); color: #fff; }
    .toggle-off { background: #475569; color: #cbd5e1; }
    .temp-control { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    .temp-display { font-size: 1.2rem; font-weight: 700; color: #f59e0b; }
    .log-panel { background: #000; border: 1px solid var(--card-border); border-radius: 8px; padding: 12px; font-family: monospace; font-size: 0.75rem; max-height: 200px; overflow-y: auto; color: #a3e635; margin-top: 30px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="title-group">
      <h1>⚡ Hi-oT Smart Home Bridge</h1>
      <p>${complex} ${dong ? `${dong}동 ${ho}호` : ''} | 세션 계정: ${user}</p>
    </div>
    <div class="badge-group">
      <span class="badge badge-success" id="mqttBadge">● MQTT 연동됨</span>
      <button class="btn btn-secondary" onclick="triggerElevator()">🛗 EV 호출</button>
      <button class="btn" onclick="syncDevices()">🔄 동기화</button>
    </div>
  </div>

  <div id="spacesContainer">불러오는 중...</div>

  <div style="margin-top: 30px;">
    <h3 style="font-size: 0.9rem; color: var(--text-muted); margin-bottom: 6px;">실시간 브릿지 로그 (최근 30건)</h3>
    <div class="log-panel" id="logPanel">로그 불러오는 중...</div>
  </div>

  <script>
    async function fetchStatus() {
      try {
        const res = await fetch('./api/status');
        const data = await res.json();
        renderDashboard(data);
      } catch (err) {
        console.error(err);
      }
    }

    function renderDashboard(data) {
      const container = document.getElementById('spacesContainer');
      const logPanel = document.getElementById('logPanel');
      
      // Update logs
      if (Array.isArray(data.logs)) {
        logPanel.innerHTML = data.logs.map(l => '<div>[' + l.time + '] [' + l.level.toUpperCase() + '] ' + l.message + '</div>').join('');
        logPanel.scrollTop = logPanel.scrollHeight;
      }

      // Group devices by space
      const bySpace = {};
      data.devices.forEach(d => {
        const sp = d.spacenm || '기타';
        if (!bySpace[sp]) bySpace[sp] = [];
        bySpace[sp].push(d);
      });

      let html = '';
      for (const [space, items] of Object.entries(bySpace)) {
        html += '<div class="space-section">';
        html += '<div class="space-title">📍 ' + space + ' (' + items.length + '개 기기)</div>';
        html += '<div class="grid">';
        for (const item of items) {
          const isOn = item.attributevalu === 'on';
          const type = item.devicetypecd;
          const isClimate = ['HTR', 'ACB'].includes(type);
          const climate = item.climate || {};

          html += '<div class="card ' + (isOn ? 'active' : '') + '">';
          html += '  <div class="card-head">';
          html += '    <div>';
          html += '      <div class="card-name">' + item.devicenm + '</div>';
          html += '      <div class="card-type">' + type + ' | ' + item.devicecd.substring(0, 16) + '...</div>';
          html += '    </div>';
          html += '    <button class="toggle-btn ' + (isOn ? 'toggle-on' : 'toggle-off') + '" onclick="toggleDevice(\'' + item.devicecd + '\', \'' + (isOn ? 'off' : 'on') + '\')">';
          html += isOn ? 'ON 💡' : 'OFF';
          html += '    </button>';
          html += '  </div>';

          if (isClimate) {
            html += '<div class="temp-control">';
            html += '  <span>희망:</span> <strong class="temp-display">' + (climate.desiredTemp || '-') + '°C</strong>';
            if (climate.currentTemp) {
              html += '  <span style="font-size:0.75rem; color:#94a3b8;">(현재: ' + climate.currentTemp + '°C)</span>';
            }
            html += '</div>';
          }

          html += '</div>';
        }
        html += '</div></div>';
      }

      container.innerHTML = html;
    }

    async function toggleDevice(devicecd, targetState) {
      await fetch('./api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ devicecd, value: targetState })
      });
      fetchStatus();
    }

    async function triggerElevator() {
      if (confirm('엘리베이터를 호출하시겠습니까?')) {
        const res = await fetch('./api/elevator', { method: 'POST' });
        const data = await res.json();
        alert(data.success ? '엘리베이터를 호출했습니다!' : '호출 실패: ' + data.error);
        fetchStatus();
      }
    }

    async function syncDevices() {
      await fetch('./api/sync', { method: 'POST' });
      fetchStatus();
    }

    fetchStatus();
    setInterval(fetchStatus, 5000);
  </script>
</body>
</html>`;
  }
}

// Standalone execution entrypoint
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (isDirectRun) {
  const haOpts = HiotHaBridge.loadHaOptions();
  const bridge = new HiotHaBridge(haOpts);

  bridge.start().catch((err) => {
    console.error('[Hi-oT HA Bridge Fatal Error]', err.message);
    process.exit(1);
  });

  const handleExit = () => {
    bridge.stop().then(() => process.exit(0));
  };
  process.on('SIGINT', handleExit);
  process.on('SIGTERM', handleExit);
}
