# RAR EV Charging Hub — Backend

Node.js + Express backend that acts as the bridge between your two ESPs and the Netlify frontend.

---

## Architecture

```
[Station ESP]  ──POST /api/station-data──►
                                           ◄── Railway Server (this) ──► GET /api/live ──► [Netlify Frontend]
[Car ESP-C3]   ──POST /api/car-data─────►
```

---

## Local Setup

```bash
npm install
npm run dev        # starts with nodemon (auto-restart on save)
```

Server runs on: http://localhost:3000

---

## Deploy to Railway

1. Push this folder to a GitHub repo (can be the same repo as your frontend or separate)
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Select the repo → Railway auto-detects Node.js
4. Set **Start Command**: `node server.js`
5. Railway gives you a public URL like: `https://your-app.up.railway.app`

---

## API Endpoints

### GET /
Health check — shows all available routes.

---

### POST /api/station-data
Called by your **Station ESP** (IR + INA + Voltage sensor side).

**Body:**
```json
{
  "esp_id": "STATION-ESP",
  "slot1": 1,
  "slot2": 0,
  "voltage": 12.4,
  "current": 3.2
}
```
- `slot1`, `slot2`: IR sensor (1 = car present, 0 = empty)
- `voltage`: reading from voltage sensor (V)
- `current`: reading from INA sensor (A)
- Power and alignment score are auto-calculated on the server

---

### POST /api/car-data
Called by your **Car ESP-C3 Mini** (TP4056 + battery side).

**Body:**
```json
{
  "esp_id": "CAR-ESP-C3",
  "battery_percent": 64,
  "charge_status": "charging",
  "cell_voltage": 3.82,
  "energy_added_wh": 320
}
```
- `charge_status`: one of `"charging"` | `"full"` | `"idle"` | `"error"`
- `energy_added_wh`: cumulative Wh added since session started

---

### GET /api/live
Called by the **Netlify frontend** every 2–3 seconds.

**Response:**
```json
{
  "station": {
    "slot1_occupied": true,
    "slot2_occupied": false,
    "voltage": 12.4,
    "current": 3.2,
    "power_w": 39.68,
    "alignment_score": 72,
    "last_updated": "2026-04-12T09:30:00Z"
  },
  "car": {
    "battery_percent": 64,
    "charge_status": "charging",
    "cell_voltage": 3.82,
    "energy_added_wh": 320,
    "energy_added_kwh": 0.32,
    "session_active": true,
    "session_start": "2026-04-12T09:00:00Z",
    "cost_inr": 8.56,
    "last_updated": "2026-04-12T09:30:00Z"
  },
  "summary": {
    "car_present": true,
    "alignment_ok": false,
    "guidance": {
      "message": "⚠️ Move forward slightly for better alignment.",
      "color": "yellow"
    },
    "charge_power_kw": 0.04
  }
}
```

---

### GET /api/history
Returns last 20 completed charging sessions.

---

### POST /api/session/end
Manually stop an active session from the web UI.

---

### POST /api/simulate  *(Testing only — remove in production)*
Simulate ESP data without hardware.

**Body:**
```json
{ "scenario": "charging_good" }
```

Available scenarios:
- `car_arriving` — IR triggers, low power (car just parked)
- `aligning` — medium power (car positioning)
- `charging_good` — high alignment, actively charging
- `charging_full` — battery full, TP4056 stops
- `empty_slot` — no car, no data

---

## Alignment Score Logic

The server calculates alignment from INA power reading:

```
alignment_score = (power_watts / MAX_POWER_W) × 100
```

Tune `MAX_POWER_W` in `server.js` to your wireless coil's peak output wattage.

| Score | Status |
|---|---|
| ≥ 85% | ✅ Perfect — charge at full power |
| 60–84% | ⚠️ Move slightly |
| 30–59% | 🔴 Poor alignment, reposition |
| < 30% | 🚫 No contact |

---

## ESP Arduino Code (quick reference)

### Station ESP — POST every 2s
```cpp
#include <WiFi.h>
#include <HTTPClient.h>

const char* ssid = "YOUR_WIFI";
const char* password = "YOUR_PASS";
const char* serverUrl = "https://your-app.up.railway.app/api/station-data";

void loop() {
  float voltage = readVoltageSensor();
  float current = readINASensor();
  int slot1 = digitalRead(IR_PIN_1) == LOW ? 1 : 0;
  int slot2 = digitalRead(IR_PIN_2) == LOW ? 1 : 0;

  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");

  String body = "{\"esp_id\":\"STATION-ESP\","
                "\"slot1\":" + String(slot1) + ","
                "\"slot2\":" + String(slot2) + ","
                "\"voltage\":" + String(voltage, 2) + ","
                "\"current\":" + String(current, 2) + "}";

  http.POST(body);
  http.end();
  delay(2000);
}
```

### Car ESP-C3 Mini — POST every 3s
```cpp
// TP4056 has CHRG pin (LOW when charging) and STDBY pin (LOW when full)
int chrg = digitalRead(CHRG_PIN);   // LOW = charging
int stdby = digitalRead(STDBY_PIN); // LOW = full

String status = "idle";
if (chrg == LOW) status = "charging";
else if (stdby == LOW) status = "full";

// Send to server...
String body = "{\"esp_id\":\"CAR-ESP-C3\","
              "\"battery_percent\":" + String(battPercent) + ","
              "\"charge_status\":\"" + status + "\","
              "\"cell_voltage\":" + String(cellVoltage, 2) + ","
              "\"energy_added_wh\":" + String(energyWh, 1) + "}";
```

---

## Netlify Frontend — Fetch Live Data

Add this to your existing frontend JS:

```javascript
async function fetchLiveData() {
  const res = await fetch('https://your-app.up.railway.app/api/live');
  const data = await res.json();

  // Update alignment
  document.getElementById('alignment-score').textContent = data.station.alignment_score + '%';
  document.getElementById('alignment-guidance').textContent = data.summary.guidance.message;

  // Update battery
  document.getElementById('battery-percent').textContent = data.car.battery_percent + '%';

  // Update slot status
  document.getElementById('slot1-status').textContent = data.station.slot1_occupied ? 'Occupied' : 'Available';
}

setInterval(fetchLiveData, 2500); // Poll every 2.5 seconds
fetchLiveData(); // Run immediately on load
```
