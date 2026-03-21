/*****************************************************
 🚀 SERVER.JS - GO HIGH LEVEL SAAS BACKEND
*****************************************************/
import * as dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import cors from 'cors'; // Only import this ONCE
import pkg from 'pg';
const { Pool } = pkg;

import { Client as GoogleMapsClient } from "@googlemaps/google-maps-services-js";
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// --- 1. CORS CONFIGURATION (The "Permission Slip") ---
app.use(cors({
  origin: [
    'https://app.leadconnectorhq.com', 
    'https://app.crmonesource.com',
    'https://services.leadconnectorhq.com'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json()); // Essential so your server can read the Sync data

// 1. Define Environment Variables
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/a7699638-aca6-4480-a0ce-25df857c9b33";

/*****************************************************
 1️⃣ DATABASE CONFIGURATION
*****************************************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

// Initialize the Google Maps Client for the Backend
const googleMapsClient = new GoogleMapsClient({});

// --- 1. MIDDLEWARE & SECURITY CONFIG ---
app.use(express.json()); // Essential for reading JSON payloads
app.use(express.static(path.join(__dirname, "public")));

// Consolidated CORS - Add all your known origins here
const allowedOrigins = [
  'https://app.leadconnectorhq.com', 
  'https://app.crmonesource.com',
  'https://services.leadconnectorhq.com',
  'https://rideshare-scheduler-axx6.onrender.com', // Your backend URL
  'http://localhost:5173', // For local Vite development
  'http://localhost:8080'  // For local testing
];

app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'The CORS policy for this site does not allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// --- 2. IFRAME & SECURITY POLICY ---
app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy", 
    "frame-ancestors 'self' https://app.crmonesource.com https://*.gohighlevel.com https://*.msgsndr.com https://*.leadconnectorhq.com;"
  );
  next();
});


/*****************************************************
 2️⃣ API ROUTES (Wizard & Health)
*****************************************************/

// This fixes the "Cannot GET /api/health" error
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'SaaS Master Engine Online', 
        time: new Date().toISOString() 
    });
});

// This handles the "Save" button from your Vue Wizard
app.post("/api/save-config", async (req, res) => {
    const client = await pool.connect();
    try {
        const data = req.body; 
        const { id, businessName, taxRate, mapsApiKey, fleet } = data; // Destructure from payload

        await client.query('BEGIN');

      // --- 1. UPDATE PROFILE OWNER DETAILS (Including Service Area) ---
const updateProfileQuery = `
  INSERT INTO profiles (location_id, business_name, tax_rate, maps_api_key, service_lat, service_lng)
  VALUES ($1, $2, $3, $4, $5, $6)
  ON CONFLICT (location_id) DO UPDATE SET 
    business_name = EXCLUDED.business_name,
    tax_rate = EXCLUDED.tax_rate,
    maps_api_key = EXCLUDED.maps_api_key,
    service_lat = EXCLUDED.service_lat,
    service_lng = EXCLUDED.service_lng
  RETURNING *;
`;

// Make sure these names match exactly what you're sending from the Wizard
const profileValues = [id, businessName, taxRate, mapsApiKey, service_lat, service_lng];

await client.query(updateProfileQuery, profileValues);

        // --- 2. CLEAR AND RE-SYNC FLEET ---
        await client.query(`DELETE FROM fleet_settings WHERE location_id = $1`, [id]);
        
        for (const v of fleet) {
            await client.query(
                `INSERT INTO fleet_settings (location_id, vehicle_slot_id, base_rate_cents, mile_rate_cents, calendar_id)
                 VALUES ($1, $2, $3, $4, $5)`,
                [
                    id, 
                    v.vehicle_type, 
                    Math.round(v.base_rate * 100), 
                    Math.round(v.mile_rate * 100), 
                    v.calendar_id
                ]
            );
        }

        await client.query('COMMIT');
        res.json({ success: true, message: "Profile and Fleet updated successfully" });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ Setup Wizard Error:", err);
        res.status(500).json({ error: "Failed to save settings" });
    } finally {
        client.release();
    }
});
/*****************************************************
 2️⃣ GLOBAL OAUTH2 CLIENT FOR GOOGLE
*****************************************************/
// This allows your app to connect to profile' Google Calendars
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
async function getMapsKey(location_id) {
  const res = await pool.query(
    "SELECT maps_api_key FROM profile WHERE id = $1",
    [location_id]
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

app.get('/test-signal', async (req, res) => {
    try {
        await pool.query("SELECT pg_notify('profile_updated', 'TEST_FROM_WEB')");
        res.send("🚀 Test signal sent to Database. Check Render logs!");
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.get('/test-webhook', async (req, res) => {
    try {
        // 1. TEST THE DB CONNECTION
        const dbTest = await pool.query('SELECT NOW()');
        console.log("✅ DB Connection Verified at:", dbTest.rows[0].now);

        // 2. RUN THE SYNC MANUALLY
        const location_id = '101'; // Your test ID
        await triggerCrmWebhook(location_id);

        res.send(`<h1>Success!</h1><p>DB is connected and signal sent to CRM for Location ${location_id}</p>`);
    } catch (err) {
        console.error("❌ Test Route Error:", err.message);
        res.status(500).send(`<h1>DB Error</h1><p>${err.message}</p>`);
    }
});

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

async function checkFixedRate(location_id, pickupAddr, dropoffAddr) {
  // 1. Fetch all fixed routes for this specific location
  const result = await pool.query(
    "SELECT pickup_keyword, dropoff_keyword, fixed_price FROM fixed_rates WHERE location_id = $1 AND is_active = true",
    [location_id]
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


/*****************************************************
 4️⃣ SAVE SETTINGS ROUTE
*****************************************************/
app.post('/api/save-settings', async (req, res) => {
    const { location_id, mapsApiKey, taxRate, businessName } = req.body;

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

        const result = await pool.query(query, [mapsApiKey, taxRate, businessName, location_id]);

        if (result.rows.length === 0) {
            // If the user doesn't exist yet, create them
            await pool.query(
                "INSERT INTO users (id, maps_api_key, tax_rate, business_name) VALUES ($1, $2, $3, $4)",
                [location_id, mapsApiKey, taxRate, businessName]
            );
        }

        res.json({ success: true, message: "Settings saved and API key validated!" });

    } catch (error) {
        console.error("❌ Save Settings Error:", error);
        res.status(500).json({ success: false, error: "Internal Server Error" });
    }
});

app.post("/api/sync-ghl", async (req, res) => {
    const GHL_WEBHOOK_URL = "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/a7699638-aca6-4480-a0ce-25df857c9b33";

    try {
        const response = await fetch(GHL_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(req.body)
        });

        const data = await response.json();
        res.json({ success: true, ghl_response: data });
    } catch (err) {
        res.status(500).json({ error: "Failed to forward to GHL" });
    }
});

app.post('/api/save-config', (req, res) => {
    // We pull crm_webhook_url out of the request body
    const { id, crm_webhook_url } = req.body;
    
    console.log(`Saving for ${id}: URL is ${crm_webhook_url}`);

    // If you're using a database, you'd save it here
    // configurations[id] = { webhook: crm_webhook_url };

    res.json({ success: true });
});

app.get('/api/test', (req, res) => {
    const host = req.get('host'); 
    const fullUrl = `${req.protocol}://${host}${req.originalUrl}`;
});

app.get("/test-page", (req, res) => {
  res.send("<h1>Server route works</h1>");
});
    
app.post('/api/update-profile-full', async (req, res) => {
    const {
        location_id,
        crm_webhook_url, 
        maps_api_key,
        tax_rate,
        fleet,
        fixed_rates,
        peak_windows,
        events
    } = req.body;

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. UPSERT THE MAIN PROFILE
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
                location_id,
                crm_webhook_url,
                maps_api_key,
                tax_rate || 0,
                JSON.stringify(fleet || []),
                JSON.stringify(events || []),
                JSON.stringify(peak_windows || [])
            ]
        );

        // 2. CLEAR AND REFRESH FLEET SLOTS
await client.query('DELETE FROM services WHERE location_id = $1', [location_id]);

if (fleet && fleet.length > 0) {
    for (const vehicle of fleet) {
        // Handle spaces in IDs for cleaner URL/lookup strings
        const vehicle_type_slug = String(vehicle.vehicle_type || 'vehicle').replace(/\s+/g, '-').toLowerCase();
        const vehicle_slot_id = `${location_id}-${vehicle_type_slug}`;

        await client.query(
            `INSERT INTO services (
                location_id,        -- $1
                vehicle_slot_id,    -- $2
                name,               -- $3
                base_rate,          -- $4
                per_mile_rate,      -- $5
                calendar_id,        -- $6
                deposit_pct,        -- $7
                deposit_flat_cents  -- $8
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [
                location_id,                                    // $1
                vehicle_slot_id,                                // $2
                vehicle.vehicle_type || null,                   // $3
                parseFloat(vehicle.base_rate) || 0,             // $4
                parseFloat(vehicle.mile_rate) || 0,             // $5
                vehicle.calendar_id || null,                    // $6
                parseFloat(vehicle.deposit_pct) || 0,           // $7
                parseInt(vehicle.deposit_flat_cents) || 0       // $8
            ]
        );
    }
}

        // 3. REFRESH FIXED RATES
        await client.query('DELETE FROM fixed_rates WHERE location_id = $1', [location_id]);
        if (fixed_rates && fixed_rates.length > 0) {
            for (const route of fixed_rates) {
                if (route.pickup_keyword && route.dropoff_keyword) {
                    await client.query(
                        `INSERT INTO fixed_rates (location_id, pickup_keyword, dropoff_keyword, fixed_price, is_active)
                        VALUES ($1, $2, $3, $4, true)`,
                        [location_id, route.pickup_keyword, route.dropoff_keyword, parseFloat(route.fixed_price) || 0]
                    );
                }
            }
        }

        await client.query('COMMIT');
        console.log(`✅ Profile and Services synced for: ${location_id}`);
        res.json({ success: true, message: 'All settings and slots saved!' });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("❌ Blended Save Error:", err.message);
        res.status(500).json({ error: "Failed to save profile settings.", detail: err.message });
    } finally {
        if (client) client.release();
    }
});
   /*****************************************************
 5️⃣ AVAILABILITY ENGINE
*****************************************************/
app.post("/api/availability", async (req, res) => {
  try {
    const { location_id, date } = req.body;

    if (!location_id || !date) {
      return res.status(400).json({ slots: [], error: "Missing required data." });
    }

    // --- NEW: YOU NEED THESE THREE LOOKUPS FIRST ---
    
    // 1. Get Operating Hours from Profiles
    const profileRes = await pool.query(
      "SELECT open_time, close_time, is_booking_enabled FROM profiles WHERE location_id=$1",
      [location_id]
    );
    if (!profileRes.rows.length) return res.json({ slots: [], error: "Profile not found" });
    const { open_time, close_time, is_booking_enabled } = profileRes.rows[0];

    // 2. Get Duration from Fleet Settings
    const fleetRes = await pool.query(
      "SELECT duration_min FROM fleet_settings WHERE location_id=$1 LIMIT 1",
      [location_id]
    );
    const durationMin = fleetRes.rows[0]?.duration_min || 60;

    // 3. Get Existing Bookings (The part you just wrote)
    const existingRes = await pool.query(
      "SELECT start_time, end_time FROM bookings WHERE location_id = $1 AND CAST(start_time AS DATE) = $2",
      [location_id, date]
    );
    const existingBookings = existingRes.rows;

    // --- NEW: DEFINE YOUR VARIABLES ---
    const dayStart = new Date(`${date}T${open_time || '08:00:00'}`);
    const dayEnd = new Date(`${date}T${close_time || '20:00:00'}`);
    const minNotice = 120; // 2 hour buffer
    const earliestAllowed = new Date(Date.now() + minNotice * 60000);

    const slots = [];

    // --- YOUR LOOP (This part was correct!) ---
    for (let t = new Date(dayStart); new Date(t.getTime() + durationMin * 60000) <= dayEnd; t.setMinutes(t.getMinutes() + 30)) {
      const slotStart = new Date(t);
      const slotEnd = new Date(t.getTime() + durationMin * 60000);

      if (slotStart < earliestAllowed) continue;

      const isBlocked = existingBookings.some(booking => {
        const bookedStart = new Date(booking.start_time);
        const bookedEnd = new Date(booking.end_time);
        return (slotStart < bookedEnd && slotEnd > bookedStart);
      });

      if (!isBlocked) {
        slots.push({
          time: slotStart.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
          startISO: slotStart.toISOString(),
        });
      }
    }

    res.json({ slots, waitlist: slots.length === 0 });
    
  } catch (err) {
    console.error("Availability Error:", err);
    res.status(500).json({ error: err.message });
  }
});
/*****************************************************
 6️⃣ PRICING SIMULATOR (Quote CALCULATION)
*****************************************************/

// Helper moved outside to prevent re-declaration on every request
async function getCurrentMultiplier(location_id) {
    try {
        // 1. Check for Special Events First (Date-based)
        const eventResult = await pool.query(
            "SELECT multiplier FROM event_multipliers WHERE location_id = $1 AND event_date = CURRENT_DATE",
            [location_id]
        );
        if (eventResult.rows.length > 0) return parseFloat(eventResult.rows[0].multiplier);

        // 2. Check for Daily Peak Windows (Time-based Rush Hours)
        const peakResult = await pool.query(
            `SELECT multiplier FROM service_peak_multipliers 
             WHERE location_id = $1 
             AND CURRENT_TIME AT TIME ZONE 'UTC' BETWEEN start_time AND end_time`,
            [location_id]
        );

        if (peakResult.rows.length > 0) return parseFloat(peakResult.rows[0].multiplier);

        // 3. Default Multiplier if nothing matches
        return 1.0;
    } catch (err) {
        console.error("Error fetching multiplier:", err);
        return 1.0;
    }
}

async function triggerCrmWebhook(location_id, booking_id) {
  let client;
  try {
    client = await pool.connect();

    // 1. Get the Booking (Source of Truth)
    const bookingRes = await client.query(
      "SELECT * FROM bookings WHERE id = $1",
      [booking_id]
    );
    if (bookingRes.rows.length === 0) return console.log("⚠️ Booking not found.");
    const b = bookingRes.rows[0];

    // 2. Get the Profile Owner's Webhook & Tax Rate
    const profileRes = await client.query(
      "SELECT crm_webhook_url, tax_rate, business_name FROM profiles WHERE location_id = $1",
      [location_id]
    );
    const p = profileRes.rows[0];

    if (!p?.crm_webhook_url) {
      return console.log(`⚠️ No CRM Webhook found for location: ${location_id}`);
    }

    // 3. Financial Calculations
    const basePrice = Number(b.total_price || 0);
    const taxRate = Number(p.tax_rate || 0);
    const totalWithTax = (basePrice * (1 + taxRate)).toFixed(2);
    const balanceDue = (totalWithTax - Number(b.deposit_amount || 0)).toFixed(2);

    // 4. Build the Categorized Payload
    const payload = {
      webhook_type: "BOOKING_SYNC",
      locationId: location_id,
      calendarId: String(b.calendar_id), // Guaranteed to be the UID string
      businessName: p.business_name,
      customer: {
        firstName: b.first_name,
        lastName: b.last_name,
        email: b.customer_email,
        phone: b.customer_phone
      },
      trip: {
        bookingId: b.id,
        status: b.status || 'pending',
        pickup: b.pickup_address,
        dropoff: b.dropoff_address,
        // ADDING COORDINATES HERE:
        pickupLat: b.pickup_lat,
        pickupLng: b.pickup_lng,
        dropoffLat: b.dropoff_lat,
        dropoffLng: b.dropoff_lng,
        startTime: b.start_time,
        endTime: b.end_time
      },
      financials: {
        subtotal: basePrice,
        taxRate: taxRate,
        totalWithTax: totalWithTax,
        depositPaid: b.deposit_amount,
        balanceRemaining: balanceDue
      }
    };

    // 5. Send to GHL
    const resp = await fetch(p.crm_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    console.log(`✅ Webhook sent to GHL. Status: ${resp.status}`);

  } catch (err) {
    console.error("❌ Webhook Trigger Error:", err);
  } finally {
    if (client) client.release();
  }
}

/*****************************************************
 7️⃣  CRM_One_Source STAFF SYNC (FLEET GENERATION)
*****************************************************/
app.post('/api/sync-fleet', async (req, res) => {
    const { location_id, token } = req.body;

    if (!location_id || !token) {
        return res.status(400).json({ success: false, error: "Missing Location ID or Access Token" });
    }

    try {
        // 1. CALL THE CRM API (GHL Example)
        // Adjust the URL based on your specific CRM's vehicle/custom field endpoint
        const crmResponse = await fetch(`https://services.leadconnectorhq.com/locations/${location_id}/customFields`, {
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
                INSERT INTO services (name, location_vehicle_id, location_id, is_active)
                VALUES ($1, $2, $3, true)
                ON CONFLICT (location_vehicle_id) 
                DO UPDATE SET name = EXCLUDED.name
            `, [v.name, v.id, location_id]);
        }

        console.log(`✅ Fleet synced for Location: ${location_id}`);
        res.json({ success: true, message: "Fleet synced successfully!" });

} catch (error) {
  console.error("❌ Sync Error:", error);
  return res
    .status(500)
    .json({ success: false, error: "Failed to sync fleet from CRM" });
}
});



// --- GET PROFILE SETTINGS ---
app.get("/api/get-profile/:location_id", async (req, res) => {
  const { location_id } = req.params;
  let client;
  try {
    client = await pool.connect();
    const profileRes = await client.query("SELECT * FROM profiles WHERE location_id = $1", [location_id]);
    const ratesRes = await client.query("SELECT * FROM fixed_rates WHERE location_id = $1", [location_id]);

    if (profileRes.rows.length === 0) return res.status(404).json({ error: "Profile not found" });

    const profile = profileRes.rows[0];
    const safeParse = (data) => (!data ? [] : (typeof data === 'string' ? JSON.parse(data) : data));

    res.json({
      location_id: profile.location_id,
      plan_name: profile.plan_name || "Starter",
      maps_api_key: profile.maps_api_key,
      crm_webhook_url: profile.crm_webhook_url,
      tax_rate: profile.tax_rate,
      fleet: safeParse(profile.fleet),
      events: safeParse(profile.special_events),
      peak_windows: safeParse(profile.peak_windows),
      fixed_rates: ratesRes.rows
});
  } catch (err) {
    console.error("❌ Profile Route Error:", err.message);
    res.status(500).json({ error: "Server error" });
  } finally {
    if (client) client.release();
  }
});

/* ---------------- Hybrid Pricing & Geofence ---------------- */
app.post("/api/pricing/quote", async (req, res) => {
  const { locationId, pickup, dropoff, departureISO, pickupLat, pickupLng } = req.body;

  try {
    // A. Geofence Check: Ensure pickup is within the service radius
    const profileRes = await pool.query(
        "SELECT service_lat, service_lng, service_radius_miles FROM profiles WHERE location_id = $1", 
        [locationId]
    );
    if (profileRes.rows.length === 0) return res.status(404).json({ error: "Location Profile not found" });
    
    const profile = profileRes.rows[0];
    const distanceToCenter = turf.distance(
      turf.point([pickupLng, pickupLat]), 
      turf.point([Number(profile.service_lng), Number(profile.service_lat)]), 
      { units: 'miles' }
    );

    if (distanceToCenter > profile.service_radius_miles) {
      return res.status(400).json({ 
          error: `Location outside of service area. We only service within ${profile.service_radius_miles} miles.` 
      });
    }

    // B. Special Event Check: Override rates for specific dates
    let perMileCents = 450; 
    let baseCents = 8500; 

    const eventCheck = await pool.query(
      "SELECT base_rate_cents, mile_rate_cents FROM special_events WHERE location_id = $1 AND event_date = $2",
      [locationId, departureISO.split('T')[0]]
    );

    if (eventCheck.rows.length > 0) {
      baseCents = eventCheck.rows[0].base_rate_cents;
      perMileCents = eventCheck.rows[0].mile_rate_cents;
    }

    // C. Route Calculation
    const route = await computeRoute({ origin: pickup, destination: dropoff, departureISO });
    const miles = route.distanceMeters / 1609.34;
    let totalCents = baseCents + Math.round(miles * perMileCents);
    
    // Simple night surcharge (10pm - 5am)
    const hr = new Date(departureISO).getHours();
    if (hr >= 22 || hr < 5) totalCents = Math.round(totalCents * 1.25);

    res.json({
      totalCents,
      meta: { miles: Number(miles.toFixed(2)), isNightRate: (hr >= 22 || hr < 5) }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get Quote Route
app.post('/api/get-quote', async (req, res) => {
    try {
        const { location_id, distance, vehicle_slot_id } = req.body;
        const baseRate = 2.50; 
        const multiplier = await getCurrentMultiplier(location_id);
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

// 1. ENDPOINT FOR THE WIDGET: Fetch specific configuration (by location_id)
// ✅ Keep ONE version of /api/get-profile. 
// 1. ENDPOINT FOR THE WIDGET: Fetch specific configuration
// 1. GET SETTINGS FOR WIDGET
// Fixed: Added the colon (:) before location_id
app.get("/api/get-profile-widget/:location_id", async (req, res) => {
  try {
    const { location_id } = req.params;

    // Fetch profile (the source of truth)
    const profileRes = await pool.query(
      "SELECT * FROM profiles WHERE location_id = $1",
      [location_id]
    );

    if (profileRes.rows.length === 0) {
      return res.status(404).json({ error: "Location Not Found" });
    }

    const p = profileRes.rows[0];

    // Map data to return to widget
    // We use the JSONB columns from the profiles table
    return res.json({
      maps_key: p.maps_api_key,
      tax_rate: p.tax_rate,
      fleet: p.fleet,         // Using the JSONB fleet from profiles
      fixed_rates: p.fixed_rates,
      peak_windows: p.peak_windows,
      events: p.special_events
    });

  } catch (err) {
    console.error("Database Error:", err);
    return res.status(500).send("Database Error");
  }
});

// 2. ENDPOINT FOR BOOKING
app.post("/api/create-booking", async (req, res) => {
  try {
    const {
      location_id, vehicle_slot_id, first_name, last_name,
      email, phone, pickup_address, dropoff_address, pickup_lat, pickup_lng, 
      dropoff_lat, dropoff_lng, start_time, total_price,
      deposit_percent = 0, deposit_amount = 0 // Default to 0 if missing
    } = req.body;

    // 1. CALCULATE END TIME (60 mins after start)
    // Ensure this math is in create-booking:
const end_time = new Date(new Date(start_time).getTime() + (60 + 45) * 60000).toISOString();

    // 2. DATABASE LOOKUPS (Get Webhook and Calendar ID first)
    const profileLookup = await pool.query(
      "SELECT crm_webhook_url FROM profiles WHERE location_id = $1", 
      [location_id]
    );
    
    const fleetLookup = await pool.query(
      "SELECT calendar_id FROM fleet_settings WHERE vehicle_slot_id = $1 AND location_id = $2",
      [vehicle_slot_id, location_id]
    );

    const webhookUrl = profileLookup.rows[0]?.crm_webhook_url;
    const calendar_id = fleetLookup.rows[0]?.calendar_id;

    // 3. SAVE TO LOCAL DATABASE
    // Calculate the balance before the database query
const balance_due = (Number(total_price) - Number(deposit_amount)).toFixed(2);

await pool.query(
  `INSERT INTO bookings (
    location_id, vehicle_slot_id, first_name, last_name, customer_email, 
    customer_phone, pickup_address, dropoff_address, pickup_lat, 
    pickup_lng, dropoff_lat, dropoff_lng, start_time, total_price,
    calendar_id, deposit_amount, deposit_percent, balance_due
  ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
  [
    location_id, vehicle_slot_id, first_name, last_name, email, 
    phone, pickup_address, dropoff_address, pickup_lat, pickup_lng, 
    dropoff_lat, dropoff_lng, start_time, total_price,
    calendar_id, deposit_amount, deposit_percent, balance_due // <--- ADDED HERE
  ]
);

    // 4. TRIGGER THE WEBHOOK (Categorized for better organization)
if (webhookUrl && webhookUrl.startsWith('http')) {
  fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      // Core IDs
      location_id,
      calendar_id: String(calendar_id), // Ensures the alphanumeric ID is treated as a string
      vehicle_Id: vehicle_slot_id,

      // Category 1: Customer Details
      customer: {
        firstName: first_name,
        lastName: last_name,
        email: email,
        phone: phone
      },

      // Category 2: Trip Details
      trip: {
        pickup: pickup_address,
        dropoff: dropoff_address,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        startTime: start_time,
        endTime: end_time
      },

      // Category 3: Financials
      financials: {
        totalPrice: total_price,
        depositPercent: deposit_percent,
        depositAmount: deposit_amount,
        balanceRemaining: (Number(total_price) - Number(deposit_amount)).toFixed(2)
      }
    })
  }).catch(e => console.error("Webhook Failed:", e));
}

    // 5. RESPOND TO THE WIDGET
    res.status(200).json({ 
      success: true, 
      message: "Booking saved and webhook triggered",
      booking_id: result?.rows?.[0]?.id 
    });

  } catch (err) {
    console.error("❌ Error in create-booking:", err);
    res.status(500).json({ error: "Failed to create booking" });
  }
});

app.get("/setup-wizard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup-wizard.html"));
});

// This tells the server what to do when you visit /api/health
app.get('/api/health', (req, res) => {
    res.json({
        status: "SaaS Master Engine Online",
        timestamp: new Date().toISOString(),
        webhook_default: CRM_WEBHOOK_URL
    });
});

// --- DATABASE LISTENER (Runs 24/7) ---
const { Client } = pkg;

const startListener = async () => {
  try {
    const listenerClient = new Client({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      keepAlive: true,
    });

    await listenerClient.connect();

    // Listen to BOTH channels
    await listenerClient.query("LISTEN profile_updated;");
    await listenerClient.query("LISTEN booking_updated;");

    console.log("🟢 DB Listener: Online and waiting for signals...");

    listenerClient.on("notification", async (msg) => {
      try {
        console.log(`🔔 Signal Received on ${msg.channel}: ${msg.payload}`);

        const booking_id = Number(msg.payload);
        if (!Number.isInteger(booking_id) || booking_id <= 0) {
          console.log("⚠️ Invalid payload (expected booking_id number). Skipping.", {
            channel: msg.channel,
            payload: msg.payload,
          });
          return;
        }

        // Derive location_id from booking row
        const bookingRes = await pool.query(
          "SELECT id, location_id, location_id FROM bookings WHERE id = $1",
          [booking_id]
        );

        if (bookingRes.rows.length === 0) {
          console.log("⚠️ Booking not found. Skipping.", { booking_id });
          return;
        }

        const location_id =
          bookingRes.rows[0].location_id ||
          bookingRes.rows[0].location_id ||
          "default";

        await triggerCrmWebhook(location_id, booking_id);
      } catch (err) {
        console.error("❌ Error handling notification:", err);
      }
    });

    listenerClient.on("error", (err) => {
      console.error("❌ Listener Error:", err);
      // If the listener errors, try restarting after a short delay
      setTimeout(startListener, 5000);
    });

    listenerClient.on("end", () => {
      console.error("❌ Listener connection ended. Restarting...");
      setTimeout(startListener, 5000);
    });

    // Optional: keepalive query to prevent idle disconnects
    setInterval(async () => {
      try {
        await listenerClient.query("SELECT 1;");
      } catch (e) {
        // listenerClient 'error' / 'end' handlers will handle restart
      }
    }, 30000);

  } catch (err) {
    console.error("❌ Failed to connect listener:", err);
    setTimeout(startListener, 5000);
  }
};
// --- START EVERYTHING ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    startListener(); // Starts the ear as soon as the mouth is open
});