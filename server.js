/*****************************************************
 🚀 SERVER.JS - GO HIGH LEVEL SAAS BACKEND
*****************************************************/
import dotenv from "dotenv";
dotenv.config();

import express from "express";
import cors from "cors";
import https from "https";
import pg from "pg";
import fetch from "node-fetch";
import { google } from "googleapis";
import { Client } from "@microsoft/microsoft-graph-client";
import "isomorphic-fetch";

const { Pool } = pg;
const app = express();
app.use(cors());
app.use(express.json());

// This tells the server to look in the 'public' folder for HTML/JS files
app.use(express.static('public'));

/*****************************************************
 1️⃣ DATABASE CONFIGURATION
*****************************************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

/*****************************************************
 2️⃣ GLOBAL OAUTH2 CLIENT FOR GOOGLE
*****************************************************/
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URL
);

/*****************************************************
 3️⃣ HELPER FUNCTIONS
*****************************************************/

// Travel time cache
const travelTimeCache = new Map();

/* 🔐 Get Maps API Key (Fail Hard) */
async function getMapsKey(locationId) {
  const res = await pool.query(
    "SELECT maps_api_key FROM users WHERE id = $1",
    [locationId]
  );

  if (!res.rows.length || !res.rows[0].maps_api_key) {
    throw new Error("Maps API key not configured.");
  }

  return res.rows[0].maps_api_key;
}

/* 🔎 Validate Maps API Key */
async function validateMapsKey(key) {
  try {
    const testUrl = `https://maps.googleapis.com/maps/api/geocode/json?address=New+York&key=${key}`;
    const resp = await fetch(testUrl);
    const data = await resp.json();
    return data.status === "OK" || data.status === "ZERO_RESULTS";
  } catch {
    return false;
  }
}

/* 🚗 Travel Time Calculation */
async function getTravelTime(origin, destination, mapsApiKey) {
  if (!origin || !destination || !mapsApiKey) return 15;

  const cacheKey = `${origin}|${destination}`;
  if (travelTimeCache.has(cacheKey)) {
    return travelTimeCache.get(cacheKey);
  }

  const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&departure_time=now&key=${mapsApiKey}`;

  return new Promise((resolve) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.rows?.[0]?.elements?.[0]?.status === "OK") {
            const minutes =
              Math.ceil(
                json.rows[0].elements[0].duration.value / 60 / 5
              ) * 5;
            travelTimeCache.set(cacheKey, minutes);
            resolve(minutes);
          } else resolve(15);
        } catch {
          resolve(15);
        }
      });
    }).on("error", () => resolve(15));
  });
}

/* 📈 Peak Multiplier Logic (Rush Hour: 6:30-10 AM & 3:30-7 PM) */
function getPeakMultiplier(dateISO, customMultiplier) {
  const date = new Date(dateISO);
  const hour = date.getHours();
  const minutes = date.getMinutes();
  const day = date.getDay();
  const timeDecimal = hour + (minutes / 60);

  const isMorningPeak = (timeDecimal >= 6.5 && timeDecimal <= 10);
  const isEveningPeak = (timeDecimal >= 15.5 && timeDecimal <= 19);

  if (day >= 1 && day <= 5) { // Weekdays
    if (isMorningPeak || isEveningPeak) {
      return parseFloat(customMultiplier || 1.35);
    }
  }

  if (day === 0 || day === 6) return 1.15; // Weekends
  return 1.0;
}

function addPeakTimeRow(label = '', start = '', end = '', mult = '1.5') {
    const container = document.getElementById('peak-times-body');
    const tr = document.createElement('tr');
    tr.className = "peak-time-row border-b border-gray-50";
    tr.innerHTML = `
        <td class="py-4 pr-2"><input type="text" class="peak-label input-mini" value="${label}" placeholder="Morning Rush"></td>
        <td class="py-4 pr-2"><input type="time" class="peak-start input-mini" value="${start}"></td>
        <td class="py-4 pr-2"><input type="time" class="peak-end input-mini" value="${end}"></td>
        <td class="py-4 pr-2"><input type="number" step="0.1" class="peak-multiplier input-mini" value="${mult}"></td>
        <td class="py-4 text-right"><button type="button" onclick="this.closest('tr').remove()" class="text-red-400 font-bold">×</button></td>
    `;
    container.appendChild(tr);
}

// 1. Generate the code when the page loads
window.onload = () => {
    const embedCode = `<script src="${BACKEND_URL}/widget.js?loc=${locationId}"><\/script>`;
    document.getElementById('embed-code-box').innerText = embedCode;
};

// 2. Add the Copy to Clipboard logic
function copyEmbedCode() {
    const code = document.getElementById('embed-code-box').innerText;
    navigator.clipboard.writeText(code).then(() => {
        alert("Embed code copied to clipboard!");
    });
}

async function syncFleet() {
    const res = await fetch(`${BACKEND_URL}/api/sync-fleet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: locationId })
    });
    const data = await resp.json();
    if (data.success) {
        alert(`Synced ${data.count} vehicles from CRM!`);
        location.reload(); // Refresh to show new rows
    }
}

async function saveSettings() {
    const btn = document.getElementById('save-settings-btn');
    btn.innerText = "SAVING...";

    // 1. Collect Fleet / Service Pricing
    const fleet = Array.from(document.querySelectorAll('.fleet-row')).map(row => ({
        serviceId: row.dataset.id,
        base_rate: row.querySelector('.base-rate').value,
        per_mile: row.querySelector('.per-mile').value,
        min_fare: row.querySelector('.min-fare').value
    }));

    // 2. Collect Daily Peak Windows
    const peakTimes = Array.from(document.querySelectorAll('.peak-time-row')).map(row => ({
        label: row.querySelector('.peak-label').value,
        start_time: row.querySelector('.peak-start').value,
        end_time: row.querySelector('.peak-end').value,
        multiplier: row.querySelector('.peak-multiplier').value
    }));

    // 3. Collect Special Events
    const events = Array.from(document.querySelectorAll('.event-row')).map(row => ({
        name: row.querySelector('.event-name').value,
        date: row.querySelector('.event-date').value,
        multiplier: row.querySelector('.event-multiplier').value
    }));

    // 4. Collect Fixed Routes (Geofencing)
    const routes = Array.from(document.querySelectorAll('.route-row')).map(row => ({
        pickup: row.querySelector('.route-from').value,
        dropoff: row.querySelector('.route-to').value,
        price: row.querySelector('.route-price').value
    }));

    // 5. Construct Final Payload
    const payload = {
        userId: locationId,
        maps_api_key: document.getElementById('maps_key').value,
        crm_api_key: document.getElementById('CRM_key')?.value, // Added safety
        tax_rate: document.getElementById('tax_rate')?.value || 0,
        fleet: fleet,
        peak_windows: peakTimes,
        events: events,
        fixed_rates: routes
    };

    try {
        const res = await fetch(`${BACKEND_URL}/api/update-profile`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            alert("✅ All settings, fleet info, and surge pricing saved!");
        } else {
            const errorData = await res.json();
            alert("❌ Save failed: " + errorData.error);
        }
    } catch (err) {
        console.error("Save Error:", err);
        alert("❌ Network error. Check if backend is running.");
    } finally {
        btn.innerText = "SAVE ALL SETTINGS";
    }
}

/*****************************************************
 4️⃣ BUSINESS PROFILE (MAPS API, TAX, & KILL SWITCH)
*****************************************************/
app.post("/api/update-profile", async (req, res) => {
  const { 
    userId, 
    business_name, 
    maps_api_key, 
    tax_rate, 
    peak_windows, 
    events 
  } = req.body;

  if (!userId) return res.status(400).json({ error: "Missing userId" });

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // 1. Update User Table
    await client.query(`
      INSERT INTO users (id, business_name, maps_api_key, tax_rate)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET
        business_name = EXCLUDED.business_name,
        maps_api_key = EXCLUDED.maps_api_key,
        tax_rate = EXCLUDED.tax_rate
    `, [userId, business_name, maps_api_key, tax_rate]);

    // 2. Update Peak Windows (Rush Hours)
    await client.query('DELETE FROM service_peak_multipliers WHERE location_id = $1', [userId]);
    if (peak_windows && Array.isArray(peak_windows)) {
      for (const window of peak_windows) {
        if (!window.start_time || !window.end_time) continue;
        await client.query(`
          INSERT INTO service_peak_multipliers (location_id, label, start_time, end_time, multiplier) 
          VALUES ($1, $2, $3, $4, $5)
        `, [userId, window.label, window.start_time, window.end_time, window.multiplier]);
      }
    }

    // 3. Update Special Events
    await client.query('DELETE FROM event_multipliers WHERE location_id = $1', [userId]);
    if (events && Array.isArray(events)) {
      for (const event of events) {
        if (!event.date) continue;
        await client.query(`
          INSERT INTO event_multipliers (location_id, event_name, event_date, multiplier) 
          VALUES ($1, $2, $3, $4)
        `, [userId, event.name, event.date, event.multiplier]);
      }
    }

    await client.query('COMMIT');
    res.json({ success: true });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error("Save Error:", err.message);
    res.status(500).json({ error: "Failed to save settings" });
  } finally {
    client.release();
  }
});

    // 3. UPDATE SPECIAL EVENTS
    // Wipe old ones and insert new ones
    await client.query('DELETE FROM event_multipliers WHERE location_id = $1', [userId]);
    if (events && Array.isArray(events)) {
      for (const event of events) {
        await client.query(
          `INSERT INTO event_multipliers (location_id, event_name, event_date, multiplier) 
           VALUES ($1, $2, $3, $4)`,
          [userId, event.name, event.date, event.multiplier]
        );
      }
    }

  await client.query('COMMIT'); // Finalize all changes
    res.json({ 
      success: true, 
      message: "Profile, Peak Windows, and Events updated successfully" 
    });

  
/*****************************************************
 5️⃣ AVAILABILITY ENGINE
*****************************************************/
app.post("/api/availability", async (req, res) => {
  try {
    const { saas_location_staff_id, pickup, dropoff, date } = req.body;

    if (!saas_location_staff_id || !date) {
      return res.status(400).json({
        slots: [],
        error: "Missing required data.",
      });
    }

    const [saas_location_id] = saas_location_staff_id.split("_");

    const userRes = await pool.query(
      "SELECT * FROM users WHERE id=$1",
      [saas_location_id]
    );

    if (!userRes.rows.length) {
      return res.json({ slots: [], error: "User not found" });
    }

    const userConfig = userRes.rows[0];

    // KILL SWITCH CHECK
    if (!userConfig.is_booking_enabled) {
      return res.json({ slots: [], error: "Online booking is temporarily disabled by the provider." });
    }

    if (!userConfig.maps_api_key) {
      return res.status(400).json({
        slots: [],
        error: "Google Maps API key missing. Please add it in Business Profile.",
      });
    }

    const svcRes = await pool.query(
      "SELECT * FROM services WHERE saas_location_staff_id=$1 LIMIT 1",
      [saas_location_staff_id]
    );

    if (!svcRes.rows.length) {
      return res.json({ slots: [], error: "Service not found" });
    }

    const service = svcRes.rows[0];

    const durationMin = service.duration_min || 60;
    const minNotice = service.min_notice_min || 120;

    const slots = [];
    const dayStart = new Date(`${date}T00:00:00`);
    const dayEnd = new Date(`${date}T23:59:59`);
    const earliestAllowed = new Date(Date.now() + minNotice * 60000);

    for (
      let t = new Date(dayStart);
      new Date(t.getTime() + durationMin * 60000) <= dayEnd;
      t.setMinutes(t.getMinutes() + 30)
    ) {
      const start = new Date(t);
      if (start < earliestAllowed) continue;

      slots.push({
        time: start.toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        }),
        startISO: start.toISOString(),
      });
    }

    res.json({ slots, waitlist: slots.length === 0 });
  } catch (err) {
    console.error("Availability Error:", err);
    res.status(500).json({ error: err.message });
  }
});

/*****************************************************
 6️⃣ PRICING SIMULATOR (QUOTE CALCULATION)
*****************************************************/
app.post("/api/calculate-quote", async (req, res) => {
  const { userId, serviceId, pickup, dropoff, startISO } = req.body;

  try {
    const userRes = await pool.query("SELECT tax_rate, maps_api_key, peak_multiplier FROM users WHERE id = $1", [userId]);
    const serviceRes = await pool.query("SELECT * FROM services WHERE id = $1", [serviceId]);

    if (!userRes.rows.length || !serviceRes.rows.length) {
      return res.status(404).json({ error: "Config not found" });
    }

async function getCurrentMultiplier(locationId) {
    try {
        // 1. Check for Special Events First (Date-based)
        const eventResult = await pool.query(
            "SELECT multiplier FROM event_multipliers WHERE location_id = $1 AND event_date = CURRENT_DATE",
            [locationId]
        );
        if (eventResult.rows.length > 0) return parseFloat(eventResult.rows[0].multiplier);

        // 2. Check for Daily Peak Windows (Time-based Rush Hours)
        const peakResult = await pool.query(
            `SELECT multiplier FROM service_peak_multipliers 
             WHERE location_id = $1 
             AND CURRENT_TIME AT TIME ZONE 'UTC' BETWEEN start_time AND end_time`, 
             [locationId]
        );
        // Note: Change 'UTC' to the SaaS owner's timezone if needed!

        if (peakResult.rows.length > 0) return parseFloat(peakResult.rows[0].multiplier);

        // 3. Default Multiplier if nothing matches
        return 1.0; 
    } catch (err) {
        console.error("Error fetching multiplier:", err);
        return 1.0;
    }
}

    const user = userRes.rows[0];
    const service = serviceRes.rows[0];
    
    // Check for fixed rate
    const fixedPrice = await checkFixedRate(userId, serviceId, pickup, dropoff);
    let fareBeforeTax = 0;
    let miles = 0;

    if (fixedPrice) {
      fareBeforeTax = fixedPrice;
    } else {
      const mapsUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(pickup)}&destinations=${encodeURIComponent(dropoff)}&key=${user.maps_api_key}`;
      const mapsResp = await fetch(mapsUrl);
      const mapsData = await mapsResp.json();
      
      if (mapsData.rows?.[0]?.elements?.[0]?.status === "OK") {
        miles = mapsData.rows[0].elements[0].distance.value / 1609.34;
      }
      
      fareBeforeTax = parseFloat(service.base_rate || 0) + (miles * parseFloat(service.per_mile_rate || 0));
    }

    const multiplier = getPeakMultiplier(startISO || new Date().toISOString(), service.peak_multiplier || user.peak_multiplier);
    let subtotal = fareBeforeTax * multiplier;
    if (subtotal < parseFloat(service.minimum_fare || 0)) subtotal = parseFloat(service.minimum_fare);

    const taxAmount = subtotal * (parseFloat(user.tax_rate || 0) / 100);
    
    res.json({
      subtotal: subtotal.toFixed(2),
      tax: taxAmount.toFixed(2),
      total: (subtotal + taxAmount).toFixed(2),
      miles: miles.toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/*****************************************************
 7️⃣ BOOKING ENGINE
*****************************************************/
app.post("/api/book", async (req, res) => {
  const client = await pool.connect();

  try {
    const {
      saas_location_staff_id,
      startISO,
      pickup,
      dropoff,
      email,
      firstName,
      lastName,
      phone,
    } = req.body;

    const [saas_location_id] = saas_location_staff_id.split("_");

    const userRes = await client.query(
      "SELECT * FROM users WHERE id=$1",
      [saas_location_id]
    );

    const userConfig = userRes.rows[0];

    // KILL SWITCH CHECK
    if (!userConfig.is_booking_enabled) {
      return res.status(403).json({ error: "Booking is currently disabled." });
    }

    const svcQuery = await client.query(
      "SELECT * FROM services WHERE saas_location_staff_id=$1 LIMIT 1",
      [saas_location_staff_id]
    );

    const service = svcQuery.rows[0];

    await client.query("BEGIN");

    const mapsApiKey = await getMapsKey(saas_location_id);

    // 1. Check for Fixed Rate match first
    const fixedPrice = await checkFixedRate(saas_location_id, service.id, pickup, dropoff);

    let fareBeforeTax = 0;
    let miles = 0;

    if (fixedPrice) {
      fareBeforeTax = fixedPrice;
    } else {
      // 2. Fallback to Distance Calculation
      const mapsUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(pickup)}&destinations=${encodeURIComponent(dropoff)}&departure_time=now&key=${mapsApiKey}`;
      const mapsResp = await fetch(mapsUrl);
      const mapsData = await mapsResp.json();

      if (mapsData.rows?.[0]?.elements?.[0]?.status === "OK") {
        miles = mapsData.rows[0].elements[0].distance.value / 1609.34;
      }

      fareBeforeTax = parseFloat(service.base_rate || 50) + (miles * parseFloat(service.per_mile_rate || 3));
    }

    // 3. Apply Peak Multiplier
    const multiplier = getPeakMultiplier(startISO, service.peak_multiplier || userConfig.peak_multiplier);
    let totalFare = fareBeforeTax * multiplier;

    // 4. Minimum Fare Check
    if (service.minimum_fare && totalFare < parseFloat(service.minimum_fare)) {
      totalFare = parseFloat(service.minimum_fare);
    }

    // 5. TAX CALCULATION
    const taxRate = parseFloat(userConfig.tax_rate || 0) / 100;
    const taxAmount = totalFare * taxRate;
    const totalPrice = Math.ceil(totalFare + taxAmount);

    const startTime = new Date(startISO);
    const endTime = new Date(
      startTime.getTime() + (service.duration_min || 60) * 60000
    );

    await client.query(
      `INSERT INTO bookings (
        user_id, service_id, start_time, end_time,
        pickup_address, dropoff_address,
        customer_email, first_name, last_name,
        phone, status, total_price
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'confirmed',$11)`,
      [
        saas_location_id,
        service.id,
        startTime,
        endTime,
        pickup,
        dropoff,
        email,
        firstName,
        lastName,
        phone,
        totalPrice,
      ]
    );

    await client.query("COMMIT");

    res.json({
      success: true,
      message: "Booking confirmed.",
      totalPrice: totalPrice,
      subtotal: totalFare.toFixed(2),
      tax: taxAmount.toFixed(2),
      miles: miles.toFixed(2)
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Booking Error:", err);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

/*****************************************************
 8️⃣ CRM_One_Source STAFF SYNC (FLEET GENERATION)
*****************************************************/
app.post("/api/sync-fleet", async (req, res) => {
    const { userId } = req.body;

    try {
        // 1. Get the user's CRM_One_Sourcece API Key/Access Token from DB
        const userRes = await pool.query("SELECT CRM_One_Source_api_key FROM users WHERE id = $1", [userId]);
        const apiKey = userRes.rows[0]?.CRM_One_Source_api_key;

        if (!apiKey) {
            return res.status(400).json({ error: "CRM_One_Source API Key not found. Please connect CRM_One_Source first." });
        }

        // 2. Fetch Staff from CRM_One_Source API
        const CRM_One_SourceResponse = await fetch(`https://services.leadconnectorhq.com/staff/?locationId=${userId}`, {
            headers: { 
                'Authorization': `Bearer ${apiKey}`,
                'Version': '2021-07-28' 
            }
        });
        const CRM_One_SourceData = await CRM_One_SourceResponse.json();

        if (!CRM_One_SourceData.staff) throw new Error("Could not retrieve staff list.");

        // 3. Sync each staff member as a "Service/Vehicle"
        for (const staff of CRM_One_SourceData.staff) {
            const staffId = `${userId}_${staff.id}`;
            await pool.query(
                `INSERT INTO services (saas_location_staff_id, name, base_rate, per_mile_rate)
                 VALUES ($1, $2, 50, 3)
                 ON CONFLICT (saas_location_staff_id) 
                 DO UPDATE SET name = EXCLUDED.name`,
                [staffId, staff.name]
            );
        }

        res.json({ success: true, count: CRM_One_SourceData.staff.length });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Fleet sync failed: " + err.message });
    }
});

// 9️⃣ GET PROFILE SETTINGS
app.get("/api/get-profile/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [userId]);
    
    if (result.rows.length === 0) {
      // If user doesn't exist yet, send back empty defaults
      return res.json({ 
        maps_api_key: "", 
        CRM_One_Source_api_key: "", 
        tax_rate: 0, 
        is_booking_enabled: true 
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching profile:", err.message);
    res.status(500).json({ error: "Failed to load settings." });
  }

  app.post('/api/get-quote', async (req, res) => {
    const { locationId, distance, serviceType } = req.body;
    
    // Get the base rate from service_types table
    const baseRate = 2.50; // (or fetch from DB)
    
    // Get the active multiplier (Rush Hour or Event)
    const multiplier = await getCurrentMultiplier(locationId);
    
    // Calculate final price
    const totalPrice = (distance * baseRate) * multiplier;
    
    res.json({ 
        quote: totalPrice.toFixed(2), 
        appliedMultiplier: multiplier 
    });
});

});

/*****************************************************
 🔟 START SERVER
*****************************************************/
const PORT = process.env.PORT || 8080;

app.listen(PORT, () =>
  console.log(`🚀 SaaS Backend running on ${PORT}`)
);
