/*
 * ============================================================
 *  RAR EV CHARGING HUB — BACKEND (Node.js + Express)
 *  Deploy on Railway — replaces or updates your existing server.js
 * ============================================================
 *  ENDPOINTS:
 *    POST /api/station-data   ← ESP32 Station (IR + INA219 + Relay)
 *    POST /api/car-data       ← ESP32-C3 Mini (TP4056 + battery)
 *    GET  /api/live           → Frontend real-time state
 *    GET  /api/history        → Frontend session log
 *    POST /api/book-slot      ← Frontend booking action
 *    POST /api/session/end    ← ESP32 or frontend
 * ============================================================
 *  npm install express cors
 * ============================================================
 */

const express = require('express');
const cors    = require('cors');
const app     = express();
const PORT    = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ──────────────────────────────────────────────
//  IN-MEMORY STATE  (replace with DB if needed)
// ──────────────────────────────────────────────
let stationState = {
  stationId      : 'A1',
  stationName    : 'RAR CHARGING Central Hub',
  carPresent     : false,
  relayOn        : false,
  voltage        : 0.0,
  current_mA     : 0.0,
  power_mW       : 0.0,
  bookingStatus  : 'available',   // "available" | "booked" | "busy"
  slotBooked     : false,
  sessionActive  : false,
  lastUpdated    : null,
};

let carState = {
  tp4056Status   : 'idle',        // "charging" | "full" | "idle"
  batteryVoltage : 0.0,
  batteryPercent : 0,
  lastUpdated    : null,
};

let sessionHistory = [];           // Array of past sessions
let currentSession = null;         // Active session object
let bookings       = [];           // Pending bookings from web

// ──────────────────────────────────────────────
//  ROOT — Health check
// ──────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'RAR EV Charging Hub Backend — Online ✅',
    endpoints: {
      'POST /api/station-data' : 'ESP Station → send IR + INA + Voltage',
      'POST /api/car-data'     : 'ESP Car (C3 Mini) → send TP4056 + battery',
      'GET  /api/live'         : 'Frontend → fetch combined live state',
      'GET  /api/history'      : 'Frontend → fetch session log',
      'POST /api/book-slot'    : 'Frontend → book a charging slot',
      'POST /api/session/end'  : 'ESP or frontend → mark session complete',
    }
  });
});

// ──────────────────────────────────────────────
//  POST /api/station-data
//  Called by: ESP32 Station every 3 seconds
// ──────────────────────────────────────────────
app.post('/api/station-data', (req, res) => {
  const {
    stationId, stationName,
    carPresent, relayOn,
    voltage, current_mA, power_mW,
    bookingStatus, sessionActive
  } = req.body;

  // Update station state
  stationState = {
    ...stationState,
    stationId    : stationId    || stationState.stationId,
    stationName  : stationName  || stationState.stationName,
    carPresent   : Boolean(carPresent),
    relayOn      : Boolean(relayOn),
    voltage      : parseFloat(voltage)    || 0,
    current_mA   : parseFloat(current_mA) || 0,
    power_mW     : parseFloat(power_mW)   || 0,
    sessionActive: Boolean(sessionActive),
    lastUpdated  : new Date().toISOString(),
  };

  // Auto-update bookingStatus based on car + session
  if (carPresent && sessionActive) {
    stationState.bookingStatus = 'busy';
  } else if (stationState.slotBooked) {
    stationState.bookingStatus = 'booked';
  } else {
    stationState.bookingStatus = 'available';
  }

  // Start session tracking if car just arrived
  if (carPresent && sessionActive && !currentSession) {
    currentSession = {
      id         : 'S' + Date.now(),
      stationId  : stationState.stationId,
      stationName: stationState.stationName,
      startTime  : new Date().toISOString(),
      endTime    : null,
      energyWh   : 0,
      status     : 'active',
    };
    console.log('[Session] Started:', currentSession.id);
  }

  // Accumulate energy (power_mW * 3sec interval → Wh)
  if (currentSession && power_mW > 0) {
    currentSession.energyWh += (power_mW / 1000) * (3 / 3600);
  }

  console.log('[Station Data]', JSON.stringify(stationState, null, 2));
  res.json({ ok: true, state: stationState });
});

// ──────────────────────────────────────────────
//  POST /api/car-data
//  Called by: ESP32-C3 Mini
// ──────────────────────────────────────────────
app.post('/api/car-data', (req, res) => {
  const { tp4056Status, batteryVoltage, batteryPercent } = req.body;

  carState = {
    tp4056Status  : tp4056Status   || 'idle',
    batteryVoltage: parseFloat(batteryVoltage)  || 0,
    batteryPercent: parseInt(batteryPercent)    || 0,
    lastUpdated   : new Date().toISOString(),
  };

  console.log('[Car Data]', JSON.stringify(carState, null, 2));
  res.json({ ok: true, state: carState });
});

// ──────────────────────────────────────────────
//  GET /api/live
//  Called by: Frontend every few seconds
// ──────────────────────────────────────────────
app.get('/api/live', (req, res) => {
  res.json({
    station    : stationState,
    car        : carState,
    session    : currentSession,
    bookings   : bookings,
    timestamp  : new Date().toISOString(),
  });
});

// ──────────────────────────────────────────────
//  GET /api/history
//  Called by: Frontend charging history page
// ──────────────────────────────────────────────
app.get('/api/history', (req, res) => {
  res.json({ sessions: sessionHistory });
});

// ──────────────────────────────────────────────
//  POST /api/book-slot
//  Called by: Frontend when user books a slot
// ──────────────────────────────────────────────
app.post('/api/book-slot', (req, res) => {
  const { userId, vehicleId, slotId, bookingTime } = req.body;

  if (stationState.bookingStatus === 'busy') {
    return res.status(409).json({ ok: false, message: 'Slot is currently busy.' });
  }

  const booking = {
    bookingId  : 'B' + Date.now(),
    userId     : userId     || 'unknown',
    vehicleId  : vehicleId  || 'unknown',
    slotId     : slotId     || stationState.stationId,
    bookingTime: bookingTime || new Date().toISOString(),
    status     : 'confirmed',
  };

  bookings.push(booking);
  stationState.slotBooked     = true;
  stationState.bookingStatus  = 'booked';

  console.log('[Booking] Confirmed:', booking.bookingId);
  res.json({ ok: true, booking });
});

// ──────────────────────────────────────────────
//  POST /api/session/end
//  Called by: ESP32 (car left) or frontend
// ──────────────────────────────────────────────
app.post('/api/session/end', (req, res) => {
  const { stationId, reason } = req.body;

  if (currentSession) {
    currentSession.endTime   = new Date().toISOString();
    currentSession.status    = 'complete';
    currentSession.reason    = reason || 'manual';
    sessionHistory.unshift(currentSession);   // Latest first
    if (sessionHistory.length > 100) sessionHistory.pop();  // Keep last 100
    console.log('[Session] Ended:', currentSession.id, '| Energy:', currentSession.energyWh.toFixed(3), 'Wh');
    currentSession = null;
  }

  // Reset station state
  stationState.sessionActive  = false;
  stationState.slotBooked     = false;
  stationState.bookingStatus  = 'available';
  bookings = bookings.filter(b => b.status !== 'confirmed');

  res.json({ ok: true, message: 'Session ended', history: sessionHistory[0] || null });
});

// ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`RAR EV Hub Backend running on port ${PORT}`);
});
