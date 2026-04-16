const express = require("express");
const cors = require("cors");

const app = express();

// ======================
// MIDDLEWARE
// ======================
app.use(cors());
app.use(express.json());

// ======================
// CENTRAL STATION STATE
// ======================
let station = {
  stationId: "EV-STATION-01",

  slot: {
    status: "FREE" // FREE | OCCUPIED
  },

  booking: {
    active: false,
    status: "IDLE", // IDLE | BOOKED | BUSY
    bookingId: null,
    time: null,
    user: {
      userId: null,
      name: null,
      vehicleNumber: null
    }
  },

  charging: {
    active: false,
    relay: false
  },

  telemetry: {
    voltage: 0,
    current: 0,
    power: 0
  },

  ui: {
    lastAction: null, // BOOK | START | STOP | SENSOR
    source: null      // web | esp32
  },

  lastUpdate: null
};

// booking log
let bookings = [];

// ======================
// ROOT TEST
// ======================
app.get("/", (req, res) => {
  res.send("EV Charging Backend Running 🚀");
});

// ======================
// FULL STATUS (WEB DASHBOARD)
// ======================
app.get("/api/status", (req, res) => {
  res.json({
    stationId: station.stationId,
    slot: station.slot.status,
    booking: station.booking,
    charging: station.charging,
    telemetry: station.telemetry,
    ui: station.ui,
    lastUpdate: station.lastUpdate
  });
});

// ======================
// BOOK SLOT (WEB INPUT)
// ======================
app.post("/api/book", (req, res) => {
  const { userId, name, vehicleNumber } = req.body;

  if (station.booking.active) {
    return res.status(409).json({
      ok: false,
      message: "Station already booked"
    });
  }

  const bookingId = "B" + Date.now();

  station.booking = {
    active: true,
    status: "BOOKED",
    bookingId,
    time: new Date().toISOString(),
    user: {
      userId: userId || "guest",
      name: name || "unknown",
      vehicleNumber: vehicleNumber || "NA"
    }
  };

  bookings.push(station.booking);

  station.ui = {
    lastAction: "BOOK",
    source: "web"
  };

  res.json({
    ok: true,
    message: "Booking successful",
    station
  });
});

// ======================
// START CHARGING
// ======================
app.post("/api/start", (req, res) => {
  if (!station.booking.active) {
    return res.status(403).json({
      ok: false,
      message: "No active booking"
    });
  }

  station.charging = {
    active: true,
    relay: true
  };

  station.booking.status = "BUSY";

  station.ui = {
    lastAction: "START",
    source: "web"
  };

  res.json({
    ok: true,
    message: "Charging started",
    station
  });
});

// ======================
// STOP CHARGING
// ======================
app.post("/api/stop", (req, res) => {
  station.charging = {
    active: false,
    relay: false
  };

  station.booking = {
    active: false,
    status: "IDLE",
    bookingId: null,
    time: null,
    user: {
      userId: null,
      name: null,
      vehicleNumber: null
    }
  };

  station.ui = {
    lastAction: "STOP",
    source: "web"
  };

  res.json({
    ok: true,
    message: "Charging stopped",
    station
  });
});

// ======================
// ESP32 UPDATE (IR + SENSOR DATA)
// ======================
app.post("/api/esp/update", (req, res) => {
  const { slot, voltage, current, power } = req.body;

  if (slot) {
    station.slot.status = slot; // FREE | OCCUPIED
  }

  if (voltage !== undefined) station.telemetry.voltage = voltage;
  if (current !== undefined) station.telemetry.current = current;
  if (power !== undefined) station.telemetry.power = power;

  station.ui = {
    lastAction: "SENSOR",
    source: "esp32"
  };

  station.lastUpdate = new Date().toISOString();

  res.json({
    ok: true,
    message: "ESP data updated",
    station
  });
});

// ======================
// BOOKING HISTORY (DEBUG / JOURNAL PROOF)
// ======================
app.get("/api/bookings", (req, res) => {
  res.json(bookings);
});

// ======================
// RESET SYSTEM (OPTIONAL TEST)
// ======================
app.post("/api/reset", (req, res) => {
  station = {
    stationId: "EV-STATION-01",
    slot: { status: "FREE" },
    booking: {
      active: false,
      status: "IDLE",
      bookingId: null,
      time: null,
      user: { userId: null, name: null, vehicleNumber: null }
    },
    charging: {
      active: false,
      relay: false
    },
    telemetry: {
      voltage: 0,
      current: 0,
      power: 0
    },
    ui: {
      lastAction: null,
      source: null
    },
    lastUpdate: new Date().toISOString()
  };

  res.json({ ok: true, station });
});

// ======================
// START SERVER
// ======================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("EV Charging Backend running on port", PORT);
});