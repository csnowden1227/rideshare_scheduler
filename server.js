/*****************************************************
 🚀 SERVER.JS - GO HIGH LEVEL SAAS BACKEND
*****************************************************/
import express from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg; 
import dotenv from 'dotenv';
import { Client as GoogleMapsClient } from "@googlemaps/google-maps-services-js";
import { google } from 'googleapis'; // Add this to fix the OAuth error!
import https from 'https'; // Required for your getTravelTime function

dotenv.config();

const app = express(); // ✅ ADD THIS

/*****************************************************
 1️⃣ DATABASE CONFIGURATION
*****************************************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // <--- This line is mandatory for cloud deploys
});

// Initialize the Google Maps Client for the Backend
const googleMapsClient = new GoogleMapsClient({});

app.use(cors());
app.use(express.json());

/*****************************************************
 2️⃣ GLOBAL OAUTH2 CLIENT FOR GOOGLE
*****************************************************/
// This allows your app to connect to users' Google Calendars
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_OAUTH_CLIENT_ID,
  process.env.GOOGLE_OAUTH_CLIENT_SECRET,
  process.env.GOOGLE_OAUTH_REDIRECT_URL
);

/*****************************************************
 3️⃣ HELPER FUNCTIONS
*****************************************************/

// Travel time cache to save money on API calls
const travelTimeCache = new Map();

/* 🔐 Get Maps API Key from Database */
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
            const minutes = Math.ceil(json.rows[0].elements[0].duration.value / 60 / 5) * 5;
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

/*****************************************************
 4️⃣ SAVE SETTINGS ROUTE
*****************************************************/
app.post('/api/save-settings', async (req, res) => {
    const { userId, mapsApiKey, taxRate, businessName } = req.body;

    try {
        // 1. Validate the Maps Key before saving
        const isValid = await validateMapsKey(mapsApiKey);
        if (!isValid) {
            return res.status(400).json({ 
                success: false, 
                error: "Invalid Google Maps API Key. Please check your console." 
            });
        }

        // 2. Update the user record in the database
        // We use COALESCE so we don't overwrite the business name with NULL if it's missing
        const query = `
            UPDATE users 
            SET maps_api_key = $1, 
                tax_rate = $2, 
                business_name = COALESCE($3, business_name)
            WHERE id = $4
            RETURNING id;
        `;

        const result = await pool.query(query, [mapsApiKey, taxRate, businessName, userId]);

        if (result.rows.length === 0) {
            // If the user doesn't exist yet, create them
            await pool.query(
                "INSERT INTO users (id, maps_api_key, tax_rate, business_name) VALUES ($1, $2, $3, $4)",
                [userId, mapsApiKey, taxRate, businessName]
            );
        }

        res.json({ success: true, message: "Settings saved and API key validated!" });

    } catch (error) {
        console.error("❌ Save Settings Error:", error);
        res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

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

app.get('/api/test', (req, res) => {
    const host = req.get('host'); 
    const fullUrl = `${req.protocol}://${host}${req.originalUrl}`;
});

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
app.post('/api/update-profile-full', async (req, res) => {
  const {
    userId, // The GHL/CRM location_id
    fleet,
    fixed_rates,
    events,
    maps_api_key,
    crm_api_key, // Incoming API Key/Token
    tax_rate,
    is_booking_enabled, // (unused here, but kept)
    peak_windows // was referenced later but not destructured
  } = req.body;

  // THE BRIDGE: Map CRM names to SaaS Database names
  const saas_location_id = userId;
  const crm_token = crm_api_key;

  try {
    await pool.query('BEGIN');

    // 1. UPDATE MAIN PROFILE (The "Business Profile")
    await pool.query(
      `
      INSERT INTO profiles (
        location_id,
        crm_token,
        maps_api_key,
        fleet,
        fixed_routes,
        tax_rate
      )
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (location_id)
      DO UPDATE SET
        crm_token = EXCLUDED.crm_token,
        maps_api_key = EXCLUDED.maps_api_key,
        fleet = EXCLUDED.fleet,
        fixed_routes = EXCLUDED.fixed_routes,
        tax_rate = EXCLUDED.tax_rate
      `,
      [
        saas_location_id,
        crm_token,
        maps_api_key,
        JSON.stringify(fleet),
        JSON.stringify(fixed_rates),
        tax_rate || 0
      ]
    );

    // 2. REFRESH SERVICES (The "Booking Slots")
    await pool.query('DELETE FROM services WHERE saas_location_id = $1', [saas_location_id]);

    if (fleet && fleet.length > 0) {
      for (const vehicle of fleet) {
        // We use saas_location_staff_id to satisfy your DB unique constraint
        const staffId = `${saas_location_id}-${String(vehicle.vehicle_type || 'vehicle')
          .replace(/\s+/g, '-')
          .toLowerCase()}`;

        await pool.query(
          `
          INSERT INTO services (
            saas_location_id,
            vehicle_slot_id,
            name,
            base_rate,
            per_mile_rate,
            saas_location_staff_id
          )
          VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            saas_location_id,
            vehicle.vehicle_slot_id || staffId,
            vehicle.vehicle_type,
            vehicle.base_rate,
            vehicle.mile_rate,
            staffId
          ]
        );
      }
    }

    // 3. UPSERT FLEET SLOTS (New Slot Logic)
    // This ensures vehicle_id (e.g., LOC-vehicle-1) is the permanent anchor
    if (fleet && fleet.length > 0) {
      for (const vehicle of fleet) {
        await pool.query(
          `
          INSERT INTO fleet (location_id, vehicle_id, vehicle_type, base_rate, mile_rate)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (vehicle_id)
          DO UPDATE SET
            vehicle_type = EXCLUDED.vehicle_type,
            base_rate = EXCLUDED.base_rate,
            mile_rate = EXCLUDED.mile_rate
          `,
          [userId, vehicle.vehicle_id, vehicle.vehicle_type, vehicle.base_rate, vehicle.mile_rate]
        );
      }
    }

    // 4. REFRESH FIXED ROUTES (Old Functionality)
    await pool.query('DELETE FROM fixed_rates WHERE location_id = $1', [userId]);
    if (fixed_rates && fixed_rates.length > 0) {
      for (const route of fixed_rates) {
        await pool.query(
          `
          INSERT INTO fixed_rates (pickup, dropoff, price, location_id)
          VALUES ($1, $2, $3, $4)
          `,
          [route.pickup, route.dropoff, route.price, userId]
        );
      }
    }

    // 5. REFRESH PEAK WINDOWS (Old Functionality)
    await pool.query('DELETE FROM peak_windows WHERE location_id = $1', [userId]);
    if (peak_windows && peak_windows.length > 0) {
      for (const window of peak_windows) {
        await pool.query(
          `
          INSERT INTO peak_windows (label, start_time, end_time, multiplier, location_id)
          VALUES ($1, $2, $3, $4, $5)
          `,
          [window.label, window.start_time, window.end_time, window.multiplier, userId]
        );
      }
    }

    // 6. REFRESH SPECIAL EVENTS (Old Functionality)
    await pool.query('DELETE FROM events WHERE location_id = $1', [userId]);
    if (events && events.length > 0) {
      for (const event of events) {
        await pool.query(
          `
          INSERT INTO events (name, event_date, multiplier, location_id)
          VALUES ($1, $2, $3, $4)
          `,
          [event.name, event.date, event.multiplier, userId]
        );
      }
    }

    // 7. COMMIT EVERYTHING
    await pool.query('COMMIT');

    console.log(`✅ Blended Profile saved for: ${userId}`);
    res.json({ success: true, message: 'All settings and slots saved!' });
  } catch (err) {
      await pool.query('ROLLBACK');
    console.error('❌ Blended Save Error:', err);
    res.status(500).json({ error: err.message });
  }
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
app.post('/api/sync-fleet', async (req, res) => {
    const { userId, token } = req.body;

    if (!userId || !token) {
        return res.status(400).json({ success: false, error: "Missing Location ID or Access Token" });
    }

    try {
        // 1. CALL THE CRM API (GHL Example)
        // Adjust the URL based on your specific CRM's vehicle/custom field endpoint
        const crmResponse = await fetch(`https://services.leadconnectorhq.com/locations/${userId}/customFields`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Version': '2021-07-28',
                'Accept': 'application/json'
            }
        });

        const data = await crmResponse.json();
        
        // This is where you filter for your specific "Vehicles" custom field or object
        // For this example, we assume 'data.vehicles' is an array of { id, name }
        const vehicles = data.customFields || []; 

        // 2. SYNC TO DATABASE
        for (const v of vehicles) {
            // We use 'ON CONFLICT' to avoid duplicate errors
            await client.query(`
                INSERT INTO services (name, saas_location_vehicle_id, user_id, is_active)
                VALUES ($1, $2, $3, true)
                ON CONFLICT (saas_location_vehicle_id) 
                DO UPDATE SET name = EXCLUDED.name
            `, [v.name, v.id, userId]);
        }

        console.log(`✅ Fleet synced for Location: ${userId}`);
        res.json({ success: true, message: "Fleet synced successfully!" });

} catch (error) {
  console.error("❌ Sync Error:", error);
  return res
    .status(500)
    .json({ success: false, error: "Failed to sync fleet from CRM" });
}
});

// 9️⃣ GET PROFILE SETTINGS

// 1. Get Profile Route
app.get("/api/get-profile/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const result = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [userId]
    );

    if (result.rows.length === 0) {
      return res.json({
        maps_api_key: "",
        crm_api_key: "",
        tax_rate: 0,
        is_booking_enabled: true
      });
    }

    return res.json(result.rows[0]);

  } catch (err) {
    console.error("Error fetching profile:", err.message);
    return res.status(500).json({ error: "Failed to load settings." });
  }
});

// 2. Get Quote Route
app.post('/api/get-quote', async (req, res) => {
    try {
        const { locationId, distance, serviceType } = req.body;
        const baseRate = 2.50; 
        const multiplier = await getCurrentMultiplier(locationId);
        const totalPrice = (distance * baseRate) * multiplier;
        
        res.json({ 
            quote: totalPrice.toFixed(2), 
            appliedMultiplier: multiplier 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}); // <--- Correctly closes get-quote

// 3. DB Check Route
app.get("/api/db-check", async (req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    
    return res.json({
      status: "Connected",
      timestamp: result.rows[0].now
    });

  } catch (err) {
    console.error("DB Check Error:", err);
    return res.status(500).json({
      status: "Error",
      error: err.message
    });
  }
}); // ✅ closes db-check

/* =========================================================
   ⚠️ FIX: REMOVE DUPLICATE APP/EXPRESS RE-DECLARATIONS BELOW
   - You already have: const app = express(); app.use(...)
   - You already have: pool (Postgres)
   - This block was causing redeclare + duplicate route conflicts
   ========================================================= */

// ❌ REMOVE THESE (they break your server file):
// const express = require('express');
// const axios = require('axios');
// const app = express();
// app.use(express.json());

// 1. ENDPOINT FOR THE WIDGET: Fetch specific configuration (by locationId)
// ✅ Keep ONE version of /api/get-profile. If you need BOTH "userId" and "locationId",
// rename one of them to avoid route collision.
// 1. ENDPOINT FOR THE WIDGET: Fetch specific configuration
app.get("/api/get-profile-widget/:locationId", async (req, res) => {
  try {
    const { locationId } = req.params;

    // Use pool (your Postgres connection), not db
    const profile = await pool.query(
      "SELECT * FROM profiles WHERE location_id = $1",
      [locationId]
    );

    const fleet = await pool.query(
      "SELECT * FROM fleet_vehicles WHERE location_id = $1",
      [locationId]
    );

    if (profile.rows.length === 0) {
      return res.status(404).json({ error: "Location Not Found" });
    }

    // Map data to return to widget
    return res.json({
      maps_key: profile.rows[0].maps_api_key,
      tax_rate: profile.rows[0].tax_rate,
      fleet: fleet.rows,
      fixed_rates: profile.rows[0].fixed_rates,
      peak_windows: profile.rows[0].peak_windows,
      events: profile.rows[0].events
    });

  } catch (err) {
    console.error("Database Error:", err);
    return res.status(500).send("Database Error");
  }
});

// 2. ENDPOINT FOR BOOKING: Map vehicle and CRM token
app.post("/api/create-booking", async (req, res) => {
  try {
    const {
      saas_location_id,
      vehicle_slot_id,
      first_name,
      last_name,
      email,
      phone,
      pickup_address,
      pickup_coords,
      dropoff_address,
      dropoff_coords,
      start_time,
      total_price
    } = req.body;

    await pool.query(
      `
      INSERT INTO bookings (
        saas_location_id, vehicle_slot_id, first_name, last_name,
        email, phone, pickup_address, pickup_coords,
        dropoff_address, dropoff_coords, start_time, total_price
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `,
      [
        saas_location_id,
        vehicle_slot_id,
        first_name,
        last_name,
        email,
        phone,
        pickup_address,
        pickup_coords,
        dropoff_address,
        dropoff_coords,
        start_time,
        total_price
      ]
    );

    return res.json({ success: true });

  } catch (err) {
    console.error("Booking Error:", err);
    return res.status(500).json({ error: "Routing failed" });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Chauffeur SaaS Backend running on port ${PORT}`);
});