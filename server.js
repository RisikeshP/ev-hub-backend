/*
============================================================
 RAR EV CHARGING HUB — CLEAN BACKEND (RAILWAY READY)
============================================================
*/

const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================
// MIDDLEWARE
// ==========================
app.use(cors());
app.use(express.json());

// ==========================
// GLOBAL STATE (SINGLE SOURCE OF TRUTH)
// ==========================
let stationState = {
  stationId: "A1",
  stationName: "RAR Charging Hub",
  carPresent: false,
  relayOn: false,
  voltage: 0,
  current_mA: 0,
  power_mW: 0,
  bookingStatus: "available", // available | booked | busy
  slotBooked: false,
  sessionActive: false,
  lastUpdated: null,
};

let carState = {
  tp4056Status: "idle",
  batteryVoltage: 0,
  batteryPercent: 0,
  lastUpdated: null,
};

let bookings = [];
let sessionHistory = [];
let currentSession = null;

// ==========================
// ROOT CHECK
// ==========================
app.get("/", (req, res) => {
  res.send("EV IoT Backend Running 🚀");
});

// ==========================
// LIVE DASHBOARD API
// ==========================
app.get("/api/live", (req, res) => {
  res.json({
    station: stationState,
    car: carState,
    session: currentSession,
    bookings,
    timestamp: new Date().toISOString(),
  });
});

// ==========================
// ESP32 STATION DATA
// ==========================
app.post("/api/station-data", (req, res) => {
  const {
    stationId,
    stationName,
    carPresent,
    relayOn,
    voltage,
    current_mA,
    power_mW,
    sessionActive,
  } = req.body;

  stationState = {
    ...stationState,
    stationId: stationId || stationState.stationId,
    stationName: stationName || stationState.stationName,
    carPresent: Boolean(carPresent),
    relayOn: Boolean(relayOn),
    voltage: parseFloat(voltage) || 0,
    current_mA: parseFloat(current_mA) || 0,
    power_mW: parseFloat(power_mW) || 0,
    sessionActive: Boolean(sessionActive),
    lastUpdated: new Date().toISOString(),
  };

  // Booking logic
  if (stationState.carPresent && stationState.sessionActive) {
    stationState.bookingStatus = "busy";
  } else if (stationState.slotBooked) {
    stationState.bookingStatus = "booked";
  } else {
    stationState.bookingStatus = "available";
  }

  // Start session
  if (stationState.carPresent && stationState.sessionActive && !currentSession) {
    currentSession = {
      id: "S" + Date.now(),
      startTime: new Date().toISOString(),
      energyWh: 0,
      status: "active",
    };
  }

  // Energy calculation
  if (currentSession && stationState.power_mW > 0) {
    currentSession.energyWh += (stationState.power_mW / 1000) * (3 / 3600);
  }

  res.json({ ok: true, stationState });
});

// ==========================
// ESP32 CAR DATA
// ==========================
app.post("/api/car-data", (req, res) => {
  const { tp4056Status, batteryVoltage, batteryPercent } = req.body;

  carState = {
    tp4056Status: tp4056Status || "idle",
    batteryVoltage: parseFloat(batteryVoltage) || 0,
    batteryPercent: parseInt(batteryPercent) || 0,
    lastUpdated: new Date().toISOString(),
  };

  res.json({ ok: true, carState });
});

// ==========================
// BOOK SLOT (WEB)
// ==========================
app.post("/api/book-slot", (req, res) => {
  const { userId } = req.body;

  if (stationState.bookingStatus === "busy") {
    return res.status(409).json({
      ok: false,
      message: "Station is busy",
    });
  }

  const booking = {
    bookingId: "B" + Date.now(),
    userId: userId || "guest",
    status: "confirmed",
    time: new Date().toISOString(),
  };

  bookings.push(booking);

  stationState.slotBooked = true;
  stationState.bookingStatus = "booked";

  res.json({ ok: true, booking });
});

// ==========================
// END SESSION
// ==========================
app.post("/api/session/end", (req, res) => {
  if (currentSession) {
    currentSession.endTime = new Date().toISOString();
    currentSession.status = "completed";

    sessionHistory.unshift(currentSession);
    currentSession = null;
  }

  stationState.carPresent = false;
  stationState.slotBooked = false;
  stationState.bookingStatus = "available";

  res.json({ ok: true, message: "Session ended" });
});

// ==========================
// START SERVER (ONLY ONCE)
// ==========================
app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});