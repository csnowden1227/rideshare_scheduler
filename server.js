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

// 1. Define it at the top
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/Je8HE3oHLu0Moe22PIGt";

// 2. Find your booking endpoint
app.post('/api/create-booking', async (req, res) => {
    const bookingData = req.body;

    try {
        // ... (Your code to save booking to Postgres) ...

        // 3. TRIGGER THE WEBHOOK HERE
        await fetch(CRM_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                customer_name: bookingData.name,
                pickup: bookingData.pickup,
                dropoff: bookingData.dropoff,
                // Ensure your formula is used here
                total_price: (bookingData.base + (bookingData.miles * bookingData.rate)) * bookingData.multiplier,
                timestamp: new Date()
            })
        });

        res.status(200).json({ success: true });
    } catch (error) {
        console.error("Webhook failed", error);
        res.status(500).json({ error: "Booking saved but CRM sync failed" });
    }
});

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

async function checkFixedRate(saas_location_id, pickupAddr, dropoffAddr) {
  // 1. Fetch all fixed routes for this specific location
  const result = await pool.query(
    "SELECT pickup_keyword, dropoff_keyword, fixed_price FROM fixed_rates WHERE user_id = $1 AND is_active = true",
    [saas_location_id]
  );

  const activeRoutes = result.rows;

  // 2. Loop through routes to see if the customer's addresses "contain" the keywords
  for (const route of activeRoutes) {
    const pickupMatch = pickupAddr.toLowerCase().includes(route.pickup_keyword.toLowerCase());
    const dropoffMatch = dropoffAddr.toLowerCase().includes(route.dropoff_keyword.toLowerCase());

    if (pickupMatch && dropoffMatch) {return parseFloat(route.fixed_price);

    }
  }

  // 3. Return null if no geofence matches (logic will then fall back to distance-based pricing)
  return null;
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
        saas_location_id: document.getElementById('CRM_WEBHOOK_URL')?.value, // Added safety
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

app.post('/api/update-profile-full', async (req, res) => {
    const {
        saas_location_id,
        crm_webhook_url, // This is your Webhook URL from the frontend
        maps_api_key,
        tax_rate,
        fleet,
        fixed_rates,
        peak_windows,
        events
    } = req.body;

    const client = await pool.connect();

    console.log('Database Connected. Listening for profile signals...');
  
  client.query('LISTEN profile_updated');
  
  client.on('notification', async (msg) => {
    const locationId = msg.payload;
    console.log(`Signal received for: ${locationId}`);
    
    // This is the bridge that connects the DB signal to the Webhook action
    await triggerCrmWebhook(locationId); 
});
      
  });

    try {
        await client.query('BEGIN');
        

        // 1. UPSERT THE MAIN PROFILE
        // Note: Using 'crm_webhook_url' and 'location_id' to match your schema
        await client.query(
            `INSERT INTO profiles (
                location_id, crm_webhook_url, maps_api_key, tax_rate, fleet, special_events, peak_windows
            ) VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (location_id) 
            DO UPDATE SET 
                crm_webhook_url = EXCLUDED.crm_webhook_url,
                maps_api_key = EXCLUDED.maps_api_key,
                tax_rate = EXCLUDED.tax_rate,
                fleet = EXCLUDED.fleet,
                special_events = EXCLUDED.special_events,
                peak_windows = EXCLUDED.peak_windows`,
            [
                saas_location_id,
                crm_webhook_url,
                maps_api_key,
                tax_rate || 0,
                JSON.stringify(fleet || []),
                JSON.stringify(events || []),
                JSON.stringify(peak_windows || [])
            ]
        );

        // 2. REFRESH SERVICES (Booking Slots)
        await client.query('DELETE FROM services WHERE saas_location_id = $1', [saas_location_id]);

        if (fleet && fleet.length > 0) {
            for (const vehicle of fleet) {
                // Generate a clean staff ID (e.g., 101-luxury-sedan)
                const staffId = `${saas_location_id}-${String(vehicle.vehicle_type || 'vehicle')
                    .replace(/\s+/g, '-')
                    .toLowerCase()}`;

                await client.query(
                    `INSERT INTO services (
                        saas_location_id, vehicle_slot_id, name, base_rate, per_mile_rate, saas_location_staff_id
                    ) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        saas_location_id,
                        vehicle.vehicle_id || staffId, // use vehicle_id from payload
                        vehicle.vehicle_type,
                        vehicle.base_rate,
                        vehicle.mile_rate,
                        staffId
                    ]
                );
            }
        }

        // 3. REFRESH FIXED RATES (Geofencing)
        // Note: Match schema: user_id, pickup_keyword, dropoff_keyword, fixed_price
        await client.query('DELETE FROM fixed_rates WHERE user_id = $1', [saas_location_id]);
        if (fixed_rates && fixed_rates.length > 0) {
            for (const route of fixed_rates) {
                if (route.pickup_keyword && route.dropoff_keyword) {
                    await client.query(
                        `INSERT INTO fixed_rates (user_id, pickup_keyword, dropoff_keyword, fixed_price, is_active)
                        VALUES ($1, $2, $3, $4, true)`,
                        [saas_location_id, route.pickup_keyword, route.dropoff_keyword, route.fixed_price]
                    );
                }
            }
        }

        // 4. COMMIT EVERYTHING
        await client.query('COMMIT');

        console.log(`✅ Profile and Services synced for: ${saas_location_id}`);
        res.json({ success: true, message: 'All settings and slots saved!' });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Blended Save Error:", err.message);
        res.status(500).json({ error: "Failed to save profile settings.", detail: err.message });
    } finally {
        client.release();
    }


   
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

// Helper moved outside to prevent re-declaration on every request
async function getCurrentMultiplier(locationId) {
    try {
        // 1. Check for Special Events First (Date-based)
        const eventResult = await pool.query(
            "SELECT multiplier FROM event_multipliers WHERE saas_location_id = $1 AND event_date = CURRENT_DATE",
            [locationId]
        );
        if (eventResult.rows.length > 0) return parseFloat(eventResult.rows[0].multiplier);

        // 2. Check for Daily Peak Windows (Time-based Rush Hours)
        const peakResult = await pool.query(
            `SELECT multiplier FROM service_peak_multipliers 
             WHERE saas_location_id = $1 
             AND CURRENT_TIME AT TIME ZONE 'UTC' BETWEEN start_time AND end_time`,
            [locationId]
        );

        if (peakResult.rows.length > 0) return parseFloat(peakResult.rows[0].multiplier);

        // 3. Default Multiplier if nothing matches
        return 1.0;
    } catch (err) {
        console.error("Error fetching multiplier:", err);
        return 1.0;
    }
}

async function triggerCrmWebhook(locationId) {
    try {
        // 1. Fetch the latest data for this location from your DB
        const res = await pool.query('SELECT * FROM profiles WHERE saas_location_id = $1', [locationId]);
        const profile = res.rows[0];

        if (!profile || (!profile.webhook_url && !profile.crm_api_key)) {
            console.log("No webhook URL found for this location.");
            return;
        }

        const targetUrl = profile.webhook_url || profile.crm_api_key;

        // 2. Send the data to the CRM (GoHighLevel/LeadConnector)
        console.log(`Sending data to Webhook: ${targetUrl}`);
        
        const webhookResponse = await fetch(targetUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                source: "Rideshare Scheduler Admin",
                location_id: profile.saas_location_id,
                timestamp: new Date().toISOString(),
                data: profile // Sends the entire fleet, rates, and peak settings
            })
        });

        if (webhookResponse.ok) {
            console.log("✅ Webhook delivered successfully.");
        } else {
            console.error("❌ Webhook failed with status:", webhookResponse.status);
        }
    } catch (err) {
        console.error("❌ Error in triggerCrmWebhook:", err.message);
    }
}

app.post("/api/calculate-quote", async (req, res) => {
    const { userId, serviceId, pickup, dropoff, startISO } = req.body;

    try {
        const userRes = await pool.query("SELECT tax_rate, maps_api_key, peak_multiplier FROM users WHERE id = $1", [userId]);
        const serviceRes = await pool.query("SELECT * FROM services WHERE id = $1", [serviceId]);

        if (!userRes.rows.length || !serviceRes.rows.length) {
            return res.status(404).json({ error: "Config not found" });
        }

        const user = userRes.rows[0];
        const service = serviceRes.rows[0];

        // Check for fixed rate
        const fixedPrice = await checkFixedRate(userId, serviceId, pickup, dropoff);
        let priceBeforeTax = 0;
        let miles = 0;

        if (fixedPrice) {
            priceBeforeTax = fixedPrice;
        } else {
            const mapsUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(pickup)}&destinations=${encodeURIComponent(dropoff)}&key=${user.maps_api_key}`;
            const mapsResp = await fetch(mapsUrl);
            const mapsData = await mapsResp.json();

            if (mapsData.rows?.[0]?.elements?.[0]?.status === "OK") {
                // Convert meters to miles
                miles = mapsData.rows[0].elements[0].distance.value / 1609.34;
            }

            // CALCULATION: Base + (Miles * Per Mile Rate)
            priceBeforeTax = parseFloat(service.base_rate || 0) + (miles * parseFloat(service.per_mile_rate || 0));
        }

        // Use the logic-based multiplier
        const multiplier = getPeakMultiplier(startISO || new Date().toISOString(), service.peak_multiplier || user.peak_multiplier);

        // Applying the Peak Multiplier
        let subtotal = priceBeforeTax * multiplier;

        const taxAmount = subtotal * (parseFloat(user.tax_rate || 0) / 100);
        const finalTotal = subtotal + taxAmount;

        res.json({
            subtotal: subtotal.toFixed(2),
            tax: taxAmount.toFixed(2),
            total: finalTotal.toFixed(2),
            miles: miles.toFixed(2)
        });

    } catch (err) {
        console.error("Quote Calculation Error:", err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

/*****************************************************
 7️⃣ BOOKING ENGINE
*****************************************************/
app.post("/api/book", async (req, res) => {
  const client = await pool.connect();
  
  try {
    const {
      saas_location_id,
      vehicle_slot_id,
      pickup_address,
      dropoff_address,
      firstName,
      lastName,
      email,
      phone,
      startISO
    } = req.body;

    await client.query("BEGIN");

    // 1. VALIDATION & DATA RETRIEVAL
    const profileCheck = await client.query(
      "SELECT * FROM profiles WHERE saas_location_id = $1",
      [saas_location_id]
    );

    if (profileCheck.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Location not registered." });
    }

    const userConfig = profileCheck.rows[0];
    const mapsApiKey = userConfig.maps_api_key;

    const serviceRes = await client.query(
      "SELECT * FROM services WHERE vehicle_slot_id = $1 AND saas_location_id = $2",
      [vehicle_slot_id, saas_location_id]
    );
    const service = serviceRes.rows[0] || { base_rate: 50, per_mile_rate: 3 };

    // 2. PRICING LOGIC
    
    // Before calculating distance-based price, check for a Flat Rate
const fixedPrice = await checkFixedRate(saas_location_id, pickup, dropoff);

let totalPrice;
if (fixedPrice) {
  totalPrice = fixedPrice; // Use the Flat Rate (Geofence match)
} else {
  // Use your existing distance logic: (Base + (Miles * Rate))
  totalPrice = basePrice + (miles * perMileRate);
}
     
    if (fixedPrice) {
      priceBeforeTax = fixedPrice;
    } else {
      const mapsUrl = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(pickup_address)}&destinations=${encodeURIComponent(dropoff_address)}&departure_time=now&key=${mapsApiKey}`;
      const mapsResp = await fetch(mapsUrl);
      const mapsData = await mapsResp.json();

      if (mapsData.rows?.[0]?.elements?.[0]?.status === "OK") {
        miles = mapsData.rows[0].elements[0].distance.value / 1609.34;
      }
      priceBeforeTax = parseFloat(service.base_rate || 50) + (miles * parseFloat(service.per_mile_rate || 3));
    
    }

    // 3. APPLY MULTIPLIERS & TAX
    const multiplier = getPeakMultiplier(startISO, service.peak_multiplier || userConfig.peak_multiplier);
    let subtotal = priceBeforeTax * multiplier;

    const taxRate = parseFloat(userConfig.tax_rate || 0);
    const taxAmount = subtotal * (taxRate / 100);
    const finalGrandTotal = subtotal + taxAmount;

    
    // 4. SAVE TO DATABASE
    await client.query(
      `INSERT INTO bookings (
        saas_location_id, vehicle_slot_id, first_name, last_name, 
        email, phone, pickup_address, dropoff_address, total_price, status, start_time
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'confirmed', $10)`,
      [saas_location_id, vehicle_slot_id, firstName, lastName, email, phone, pickup_address, dropoff_address, finalGrandTotal, startISO]
    );

    await client.query("COMMIT");

    // 5. SEND TO CRM WEBHOOK (Outside transaction)
    const CRM_WEBHOOK_URL = "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/Je8HE3oHLu0Moe22PIGt";
    
    fetch(CRM_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName,
        lastName,
        email,
        phone,
        pickup: pickup_address,
        dropoff: dropoff_address,
        totalPrice: finalGrandTotal.toFixed(2),
        miles: miles.toFixed(2),
        bookingDate: startISO,
        locationId: saas_location_id
      })
    }).catch(e => console.error("Webhook failed:", e));

    // 6. FINAL RESPONSE
    res.json({
      success: true,
      totalPrice: finalGrandTotal.toFixed(2),
      subtotal: subtotal.toFixed(2),
      tax: taxAmount.toFixed(2),
      miles: miles.toFixed(2)
    });

  } catch (err) {
    if (client) await client.query("ROLLBACK");
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

app.get("/api/get-profile/:location_id", async (req, res) => {
  const { location_id } = req.params;
  const client = await pool.connect();

  try {
    // 1. Get the main profile (fleet, tax, maps key, webhook url)
    const profileRes = await client.query(
      "SELECT * FROM profiles WHERE location_id = $1",
      [location_id]
    );

    if (profileRes.rows.length === 0) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const profile = profileRes.rows[0];

    // 2. Get the geofencing / fixed rates
    const ratesRes = await client.query(
      "SELECT pickup_keyword, dropoff_keyword, fixed_price FROM fixed_rates WHERE user_id = $1",
      [location_id]
    );

    // 3. Combine the data into one clean object for the Frontend
    const fullProfile = {
      location_id: profile.location_id,
      maps_api_key: profile.maps_api_key,
      crm_url: profile.crm_url, // This matches the 'webhook' field in UI
      tax_rate: profile.tax_rate,
      fleet: typeof profile.fleet === 'string' ? JSON.parse(profile.fleet) : profile.fleet,
      peak_windows: typeof profile.peak_windows === 'string' ? JSON.parse(profile.peak_windows) : profile.peak_windows,
      events: typeof profile.special_events === 'string' ? JSON.parse(profile.special_events) : profile.special_events,
      fixed_rates: ratesRes.rows // Array of {pickup_keyword, dropoff_keyword, fixed_price}
    };

    res.json(fullProfile);

  } catch (err) {
    console.error("❌ Error fetching profile:", err.message);
    res.status(500).json({ error: "Server error fetching profile data" });
  } finally {
    client.release();
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
      "SELECT * FROM profiles WHERE saas_location_id = $1",
      [locationId]
    );

    const fleet = await pool.query(
      "SELECT * FROM fleet_vehicles WHERE saas_location_id = $1",
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

    // 1. Save to your local Database
    await pool.query(
      `INSERT INTO bookings (
        saas_location_id, vehicle_slot_id, first_name, last_name,
        email, phone, pickup_address, pickup_coords,
        dropoff_address, dropoff_coords, start_time, total_price
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [saas_location_id, vehicle_slot_id, first_name, last_name, email, phone, pickup_address, pickup_coords, dropoff_address, dropoff_coords, start_time, total_price]
    );

    // 2. THE BRIDGE: Get the Webhook URL for this specific user
    const userRes = await pool.query(
      "SELECT crm_webhook_url FROM users WHERE saas_location_id = $1", 
      [saas_location_id]
    );
    
    const webhookUrl = userRes.rows[0]?.crm_webhook_url;

    // 3. Trigger the Webhook to GHL
    if (webhookUrl && webhookUrl.startsWith('http')) {
      // We don't 'await' this so the customer gets their confirmation instantly
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          locationId: saas_location_id,
          firstName: first_name,
          lastName: last_name,
          email: email,
          phone: phone,
          pickup: pickup_address,
          dropoff: dropoff_address,
          totalPrice: total_price,
          startTime: start_time,
          vehicleId: vehicle_slot_id
        })
      }).catch(e => console.error("GHL Webhook Trigger Failed:", e));
    }

    // 4. Send success back to the frontend widget
    return res.json({ success: true, message: "Booking confirmed" });

  } catch (err) {
    console.error("Booking Error:", err);
    if (!res.headersSent) {
      return res.status(500).json({ error: "Booking could not be processed" });
    }
  }
});

// --- SERVER START ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🚀 Chauffeur SaaS Backend running on port ${PORT}`);
});