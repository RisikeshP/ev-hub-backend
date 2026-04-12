const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────
//  IN-MEMORY STATE  (resets on server restart)
//  When ESP sends data, this gets updated.
// ─────────────────────────────────────────

let stationData = {
  // IR Sensor
  slot1_occupied: false,
  slot2_occupied: false,

  // INA + Voltage sensor
  voltage: 0,        // Volts
  current: 0,        // Amps
  power: 0,          // Watts  (calculated: V × I)
  alignment_score: 0, // 0–100% (derived from power)

  // Metadata
  last_updated: null,
  esp_id: "STATION-ESP"
};

let carData = {
  // TP4056 module
  battery_percent: 0,      // 0–100
  charge_status: "idle",   // "charging" | "full" | "idle" | "error"
  cell_voltage: 0,         // 3.7V cell voltage

  // Session
  energy_added_wh: 0,      // Wh added this session
  session_active: false,
  session_start: null,

  // Metadata
  last_updated: null,
  esp_id: "CAR-ESP-C3"
};

let sessionLog = [];       // Array of completed sessions

// ─────────────────────────────────────────
//  HELPER — alignment score from power
//  Your INA sensor reads more power when
//  coil alignment is better.
//  Tune MAX_POWER_W to your coil's peak watt.
// ─────────────────────────────────────────
const MAX_POWER_W = 11000; // 11 kW wireless pad max
function calcAlignment(watts) {
  if (watts <= 0) return 0;
  return Math.min(100, Math.round((watts / MAX_POWER_W) * 100));
}

// ─────────────────────────────────────────
//  ROOT — health check
// ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'RAR EV Charging Hub Backend — Online ✅',
    endpoints: {
      'POST /api/station-data': 'ESP Station → send IR + INA + Voltage',
      'POST /api/car-data':     'ESP Car (C3 Mini) → send TP4056 + battery',
      'GET  /api/live':         'Frontend → fetch combined live state',
      'GET  /api/history':      'Frontend → fetch session log',
      'POST /api/session/end':  'ESP or frontend → mark session complete'
    }
  });
});

// ─────────────────────────────────────────
//  POST /api/station-data
//  Called by Station ESP every ~2 seconds
//
//  Expected JSON body:
//  {
//    "esp_id": "STATION-ESP",
//    "slot1": 1,          ← IR sensor 1 (1=occupied, 0=free)
//    "slot2": 0,          ← IR sensor 2
//    "voltage": 12.4,     ← Voltage sensor reading (V)
//    "current": 3.2       ← INA sensor reading (A)
//  }
// ─────────────────────────────────────────
app.post('/api/station-data', (req, res) => {
  const { esp_id, slot1, slot2, voltage, current } = req.body;

  if (voltage === undefined || current === undefined) {
    return res.status(400).json({ error: 'Missing voltage or current field' });
  }

  const power = parseFloat((voltage * current).toFixed(2));

  stationData = {
    slot1_occupied: slot1 === 1 || slot1 === true,
    slot2_occupied: slot2 === 1 || slot2 === true,
    voltage: parseFloat(voltage),
    current: parseFloat(current),
    power,
    alignment_score: calcAlignment(power),
    last_updated: new Date().toISOString(),
    esp_id: esp_id || 'STATION-ESP'
  };

  console.log(`[STATION] V=${voltage}V  I=${current}A  P=${power}W  Align=${stationData.alignment_score}%  Slot1=${slot1} Slot2=${slot2}`);
  res.json({ ok: true, received: stationData });
});

// ─────────────────────────────────────────
//  POST /api/car-data
//  Called by Car ESP-C3 Mini every ~3 seconds
//
//  Expected JSON body:
//  {
//    "esp_id": "CAR-ESP-C3",
//    "battery_percent": 64,
//    "charge_status": "charging",   ← "charging"|"full"|"idle"|"error"
//    "cell_voltage": 3.82,
//    "energy_added_wh": 320
//  }
// ─────────────────────────────────────────
app.post('/api/car-data', (req, res) => {
  const { esp_id, battery_percent, charge_status, cell_voltage, energy_added_wh } = req.body;

  if (battery_percent === undefined || charge_status === undefined) {
    return res.status(400).json({ error: 'Missing battery_percent or charge_status' });
  }

  const wasIdle = !carData.session_active;
  const nowCharging = charge_status === 'charging';

  // Auto start session when charging begins
  if (wasIdle && nowCharging) {
    carData.session_start = new Date().toISOString();
    carData.session_active = true;
  }

  // Auto end session when full or stops
  if (carData.session_active && (charge_status === 'full' || charge_status === 'idle')) {
    sessionLog.unshift({
      end_time: new Date().toISOString(),
      start_time: carData.session_start,
      energy_wh: energy_added_wh || carData.energy_added_wh,
      battery_start: carData.battery_percent,
      battery_end: battery_percent,
      status: charge_status
    });
    carData.session_active = false;
    carData.session_start = null;
  }

  carData = {
    ...carData,
    battery_percent: parseInt(battery_percent),
    charge_status,
    cell_voltage: parseFloat(cell_voltage || 0),
    energy_added_wh: parseFloat(energy_added_wh || 0),
    last_updated: new Date().toISOString(),
    esp_id: esp_id || 'CAR-ESP-C3'
  };

  console.log(`[CAR]  Batt=${battery_percent}%  Status=${charge_status}  Vcel=${cell_voltage}V  Energy=${energy_added_wh}Wh`);
  res.json({ ok: true, received: carData });
});

// ─────────────────────────────────────────
//  GET /api/live
//  Frontend polls this every 2–3 seconds
//  Returns merged station + car state
// ─────────────────────────────────────────
app.get('/api/live', (req, res) => {
  const cost_per_kwh = 26.75; // ₹ — you can make this dynamic later
  const cost = parseFloat(((carData.energy_added_wh / 1000) * cost_per_kwh).toFixed(2));

  res.json({
    // Station side
    station: {
      slot1_occupied: stationData.slot1_occupied,
      slot2_occupied: stationData.slot2_occupied,
      voltage: stationData.voltage,
      current: stationData.current,
      power_w: stationData.power,
      alignment_score: stationData.alignment_score,
      last_updated: stationData.last_updated
    },
    // Car side
    car: {
      battery_percent: carData.battery_percent,
      charge_status: carData.charge_status,
      cell_voltage: carData.cell_voltage,
      energy_added_wh: carData.energy_added_wh,
      energy_added_kwh: parseFloat((carData.energy_added_wh / 1000).toFixed(3)),
      session_active: carData.session_active,
      session_start: carData.session_start,
      cost_inr: cost,
      last_updated: carData.last_updated
    },
    // Summary for dashboard cards
    summary: {
      car_present: stationData.slot1_occupied || stationData.slot2_occupied,
      alignment_ok: stationData.alignment_score >= 85,
      guidance: getAlignmentGuidance(stationData.alignment_score),
      charge_power_kw: parseFloat((stationData.power / 1000).toFixed(2))
    }
  });
});

// ─────────────────────────────────────────
//  Alignment guidance text for customer UI
// ─────────────────────────────────────────
function getAlignmentGuidance(score) {
  if (score >= 85) return { message: '✅ Perfect alignment! Charging at full power.', color: 'green' };
  if (score >= 60) return { message: '⚠️ Move forward slightly for better alignment.', color: 'yellow' };
  if (score >= 30) return { message: '🔴 Poor alignment. Reposition your vehicle.', color: 'orange' };
  return { message: '🚫 No contact detected. Please park over the charging pad.', color: 'red' };
}

// ─────────────────────────────────────────
//  GET /api/history
//  Returns last 20 completed sessions
// ─────────────────────────────────────────
app.get('/api/history', (req, res) => {
  res.json({ sessions: sessionLog.slice(0, 20) });
});

// ─────────────────────────────────────────
//  POST /api/session/end
//  Manually end a session (from web UI)
// ─────────────────────────────────────────
app.post('/api/session/end', (req, res) => {
  if (carData.session_active) {
    sessionLog.unshift({
      end_time: new Date().toISOString(),
      start_time: carData.session_start,
      energy_wh: carData.energy_added_wh,
      battery_end: carData.battery_percent,
      status: 'stopped_by_user'
    });
    carData.session_active = false;
    carData.session_start = null;
    return res.json({ ok: true, message: 'Session ended by user' });
  }
  res.json({ ok: false, message: 'No active session' });
});

// ─────────────────────────────────────────
//  POST /api/simulate
//  TEST ONLY — simulate ESP data without hardware
//  Remove this in production
// ─────────────────────────────────────────
app.post('/api/simulate', (req, res) => {
  const { scenario } = req.body;

  const scenarios = {
    car_arriving: {
      station: { slot1: 1, slot2: 0, voltage: 5.2, current: 0.3 },
      car: { battery_percent: 42, charge_status: 'idle', cell_voltage: 3.65, energy_added_wh: 0 }
    },
    aligning: {
      station: { slot1: 1, slot2: 0, voltage: 11.8, current: 4.1 },
      car: { battery_percent: 42, charge_status: 'idle', cell_voltage: 3.65, energy_added_wh: 0 }
    },
    charging_good: {
      station: { slot1: 1, slot2: 0, voltage: 12.1, current: 9.8 },
      car: { battery_percent: 58, charge_status: 'charging', cell_voltage: 3.82, energy_added_wh: 640 }
    },
    charging_full: {
      station: { slot1: 1, slot2: 0, voltage: 12.4, current: 0.1 },
      car: { battery_percent: 100, charge_status: 'full', cell_voltage: 4.18, energy_added_wh: 1480 }
    },
    empty_slot: {
      station: { slot1: 0, slot2: 0, voltage: 0, current: 0 },
      car: { battery_percent: 0, charge_status: 'idle', cell_voltage: 0, energy_added_wh: 0 }
    }
  };

  const s = scenarios[scenario] || scenarios['empty_slot'];

  // Apply station data
  stationData = {
    slot1_occupied: s.station.slot1 === 1,
    slot2_occupied: s.station.slot2 === 1,
    voltage: s.station.voltage,
    current: s.station.current,
    power: parseFloat((s.station.voltage * s.station.current).toFixed(2)),
    alignment_score: calcAlignment(s.station.voltage * s.station.current),
    last_updated: new Date().toISOString(),
    esp_id: 'SIMULATED'
  };

  // Apply car data
  carData = {
    ...carData,
    battery_percent: s.car.battery_percent,
    charge_status: s.car.charge_status,
    cell_voltage: s.car.cell_voltage,
    energy_added_wh: s.car.energy_added_wh,
    session_active: s.car.charge_status === 'charging',
    last_updated: new Date().toISOString(),
    esp_id: 'SIMULATED'
  };

  res.json({ ok: true, scenario, stationData, carData });
});

// ─────────────────────────────────────────
//  START
// ─────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 RAR EV Charging Hub Backend running on port ${PORT}`);
  console.log(`   Station ESP  → POST /api/station-data`);
  console.log(`   Car ESP      → POST /api/car-data`);
  console.log(`   Frontend     → GET  /api/live\n`);
});
