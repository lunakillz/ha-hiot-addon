import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { HiotHaBridge } from '../src/hiot-ha-bridge.js';

test('HiotHaBridge correctly formats HA MQTT Discovery configs', async () => {
  const bridge = new HiotHaBridge({
    hiotUserId: 'tester',
    discoveryPrefix: 'homeassistant',
    topicPrefix: 'hiot',
  });

  const sampleLight = {
    devicecd: 'LGT_TEST_01',
    devicenm: '거실1',
    devicetypecd: 'LGT',
    spacenm: '거실',
    attributevalu: 'on',
  };

  const info = bridge.getDeviceInfo(sampleLight);
  assert.equal(info.suggested_area, '거실');
  assert.equal(info.name, '거실 조명 1');

  // Verify MQTT message simulation
  const commandsSent = [];
  bridge.client.executeDeviceBatch = async (cmds) => {
    commandsSent.push(...cmds);
    return { result: 'OK' };
  };

  const publishedMessages = [];
  bridge.publish = async (topic, payload, opts) => {
    publishedMessages.push({ topic, payload, opts });
  };

  bridge.devices.set('LGT_TEST_01', sampleLight);

  // Simulate HA turning light off
  await bridge.handleMqttMessage('hiot/light/LGT_TEST_01/set', 'OFF');

  assert.equal(commandsSent.length, 1);
  assert.equal(commandsSent[0].devicecd, 'LGT_TEST_01');
  assert.equal(commandsSent[0].value, 'off');

  const statePub = publishedMessages.find((m) => m.topic === 'hiot/light/LGT_TEST_01/state');
  assert.equal(statePub.payload, 'OFF');

  // Simulate HA setting climate temperature
  const sampleHtr = {
    devicecd: 'HTR_TEST_01',
    devicenm: '거실',
    devicetypecd: 'HTR',
    spacenm: '거실',
    attributevalu: 'on',
  };
  bridge.devices.set('HTR_TEST_01', sampleHtr);

  // 1. Setting mode to heat
  await bridge.handleMqttMessage('hiot/climate/HTR_TEST_01/mode_set', 'heat');
  const heatCmd = commandsSent.find((c) => c.devicecd === 'HTR_TEST_01' && c.value === 'on');
  assert.ok(heatCmd);
  const modePub = publishedMessages.find((m) => m.topic === 'hiot/climate/HTR_TEST_01/mode_state');
  assert.equal(modePub.payload, 'heat');

  // 2. Setting temperature
  await bridge.handleMqttMessage('hiot/climate/HTR_TEST_01/temp_set', '25');
  const tempCmd = commandsSent.find((c) => c.resource === 'temperature');
  assert.equal(tempCmd.devicecd, 'HTR_TEST_01');
  assert.equal(tempCmd.value, 25);
  const tempPub = publishedMessages.find((m) => m.topic === 'hiot/climate/HTR_TEST_01/temp_state');
  assert.equal(tempPub.payload, '25');

  // 3. Setting mode to off
  await bridge.handleMqttMessage('hiot/climate/HTR_TEST_01/mode_set', 'off');
  const offCmd = commandsSent.find((c) => c.devicecd === 'HTR_TEST_01' && c.value === 'off');
  assert.ok(offCmd);
});

test('HiotHaBridge Web API provides status and handles control requests', async () => {
  const bridge = new HiotHaBridge({
    hiotUserId: 'tester',
    webPort: 0, // random free port
  });

  bridge.client.state.userId = 'tester';
  bridge.devices.set('LGT_01', {
    devicecd: 'LGT_01',
    devicenm: '테스트 조명',
    devicetypecd: 'LGT',
    spacenm: '거실',
    attributevalu: 'on',
  });

  const executed = [];
  bridge.client.executeDeviceBatch = async (cmds) => {
    executed.push(...cmds);
    return { ok: true };
  };
  bridge.refreshDevices = async () => {};

  await bridge.initHttp();
  const address = bridge.httpServer.address();
  const port = address.port;

  try {
    // 1. GET /api/status
    const statusRes = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.status, 'online');
    assert.equal(statusData.user, 'tester');
    assert.equal(statusData.deviceCount, 1);

    // 2. POST /api/control
    const ctrlRes = await fetch(`http://127.0.0.1:${port}/api/control`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        devicecd: 'LGT_01',
        value: 'off',
      }),
    });
    assert.equal(ctrlRes.status, 200);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].value, 'off');

    // 3. GET / (Dashboard HTML)
    const htmlRes = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /Hi-oT Smart Home Bridge/);
    assert.match(html, /spacesContainer/);
    assert.equal(statusData.devices[0].devicenm, '테스트 조명');
  } finally {
    await bridge.stop();
  }
});
