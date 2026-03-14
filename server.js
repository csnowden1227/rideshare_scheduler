/*****************************************************
 🚀 SERVER.JS - GO HIGH LEVEL SAAS BACKEND
*****************************************************/
import express from 'express';
import cors from 'cors';
import pkg from 'pg';
const { Pool } = pkg; 
import dotenv from 'dotenv';
import { Client as GoogleMapsClient } from "@googlemaps/google-maps-services-js";
import { google } from 'googleapis';
import https from 'https';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const app = express();
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Define Environment Variables
const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/e8f1fd42-8f7e-4818-a94d-dd7985e12838";

/*****************************************************
 1️⃣ DATABASE CONFIGURATION
*****************************************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } 
});

// Initialize the Google Maps Client for the Backend
const googleMapsClient = new GoogleMapsClient({});

// 3. Middleware
aapp.use(cors({
  origin: ['https://app.crmonesource.com']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy", 
    "frame-ancestors 'self' https://app.crmonesource.com https://*.gohighlevel.com https://*.msgsndr.com;"
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
app.post('/api/save-config', async (req, res) => {
    const { id, crm_webhook_url } = req.body;
    
    console.log(`🚀 Received config for ID: ${id}`);
    
    try {
        const query = `
            INSERT INTO user_configs (crm_id, webhook_url, updated_at) 
            VALUES ($1, $2, NOW()) 
            ON CONFLICT (crm_id) 
            DO UPDATE SET webhook_url = $2, updated_at = NOW()
        `;
        await pool.query(query, [id, crm_webhook_url]);
        
        res.json({ success: true, message: `Engine initialized for ${id}` });
    } catch (error) {
        console.error("❌ Database Error:", error);
        res.status(500).json({ error: "Failed to save configuration" });
    }
});

app.post('/api/refresh-driver-token', async (req, res) => {
  const { token, driverId } = req.body;
  try {
    await pool.query(
      "UPDATE drivers SET google_access_token = $1, google_token_expiry = now() + interval '55 minutes' WHERE id = $2",
      [token, driverId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Database update failed" });
  }
});

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
async function getMapsKey(location_id) {
  const res = await pool.query(
    "SELECT maps_api_key FROM users WHERE id = $1",
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

    // 1. Declare client outside try so 'finally' can see it
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

        // 2. REFRESH SERVICES
        await client.query('DELETE FROM services WHERE location_id = $1', [location_id]);
        if (fleet && fleet.length > 0) {
            for (const vehicle of fleet) {
                const staffId = `${location_id}-${String(vehicle.vehicle_type || 'vehicle')
                    .replace(/\s+/g, '-')
                    .toLowerCase()}`;

                await client.query(
                    `INSERT INTO services (
                        location_id, vehicle_slot_id, name, base_rate, per_mile_rate, location_staff_id
                    ) VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                        location_id,
                        vehicle.vehicle_id || staffId,
                        vehicle.vehicle_type,
                        vehicle.base_rate,
                        vehicle.mile_rate,
                        staffId
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
                        [location_id, route.pickup_keyword, route.dropoff_keyword, route.fixed_price]
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
}); // End of POST route

   /*****************************************************
 5️⃣ AVAILABILITY ENGINE
*****************************************************/
app.post("/api/availability", async (req, res) => {
  try {
    const { location_staff_id, pickup, dropoff, date } = req.body;

    if (!location_staff_id || !date) {
      return res.status(400).json({
        slots: [],
        error: "Missing required data.",
      });
    }

    const [location_id] = location_staff_id.split("_");

    const userRes = await pool.query(
      "SELECT * FROM users WHERE id=$1",
      [location_id]
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
      "SELECT * FROM services WHERE location_staff_id=$1 LIMIT 1",
      [location_staff_id]
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

async function triggerCrmWebhook(location_id, bookingId) {
  let client;
  try {
    client = await pool.connect();

    // 1) Load the booking (source of truth)
    const bookingRes = await client.query(
      "SELECT * FROM bookings WHERE id = $1",
      [bookingId]
    );

    if (bookingRes.rows.length === 0) {
      console.log("⚠️ Missing data for CRM sync. Skipping.", {
        bookingId,
        missing: ["booking"],
      });
      return;
    }

    const b = bookingRes.rows[0];

    // 2) Load the tenant/user to get the CRM webhook URL (Option A)
    // NOTE: bookings.location_id is a FK to users.id in your schema
    const userRes = await client.query(
      "SELECT id, business_name, crm_webhook_url FROM users WHERE id = $1",
      [b.location_id]
    );

    if (userRes.rows.length === 0) {
      console.log("⚠️ Missing data for CRM sync. Skipping.", {
        bookingId,
        tenantId: b.location_id,
        missing: ["tenant/users row"],
      });
      return;
    }

    const u = userRes.rows[0];

    // 3) Optionally load profile settings if you still want fleet/tax/special_events
    // If profiles don't exist for a location yet, we DO NOT skip CRM sync.
    let p = { fleet: null, special_events: null, tax_rate: 0.15 };
    try {
      const profileRes = await client.query(
        "SELECT fleet, special_events, tax_rate FROM profiles WHERE location_id = $1",
        [location_id]
      );
      if (profileRes.rows.length > 0) p = profileRes.rows[0];
    } catch (e) {
      // profiles table might not exist in some envs; still proceed
    }

    // 4) Minimal required fields for CRM sync (Option A)
    const missing = [];
    if (!u.crm_webhook_url) missing.push("users.crm_webhook_url");
    if (!b.customer_email) missing.push("bookings.customer_email");
    if (!b.pickup_address) missing.push("bookings.pickup_address");
    if (!b.dropoff_address) missing.push("bookings.dropoff_address");
    if (!b.start_time) missing.push("bookings.start_time");
    if (!b.status) missing.push("bookings.status");

    if (missing.length) {
      console.log("⚠️ Missing data for CRM sync. Skipping.", {
        bookingId,
        tenantId: u.id,
        missing,
      });
      return;
    }

    // 5) Financials
    const basePrice = Number(b.total_price || 0);
    const taxRate = Number(p.tax_rate ?? 0.15);
    const totalWithTax = Number((basePrice * (1 + taxRate)).toFixed(2));

    // 6) Payload aligned to YOUR bookings schema
    const payload = {
      webhook_type: "BOOKING_SYNC",
      tenant: {
        id: u.id,
        business_name: u.business_name,
      },
      booking: {
        id: b.id,
        service_id: b.service_id,
        driver_id: b.driver_id,
        status: b.status,
        payment_status: b.payment_status,
        customer_email: b.customer_email,
        pickup_address: b.pickup_address,
        dropoff_address: b.dropoff_address,
        start_time: b.start_time,
        end_time: b.end_time,
        total_price: basePrice,
      },
      financials: {
        subtotal: basePrice,
        tax_rate: taxRate,
        total_amount: totalWithTax,
      },
      context: {
        location_id: location_id,
      },
      settings: {
        fleet_snapshot:
          typeof p.fleet === "string" ? JSON.parse(p.fleet) : p.fleet,
        special_events:
          typeof p.special_events === "string"
            ? JSON.parse(p.special_events)
            : p.special_events,
      },
    };

    // 7) POST to CRM webhook
    console.log("➡️ Posting to CRM webhook:", u.crm_webhook_url, {
      bookingId,
      tenantId: u.id,
    });

    const respText = await resp.text().catch(() => "");
    console.log("✅ CRM webhook response:", resp.status, respText.slice(0, 300));

  } catch (err) {
    console.error("❌ triggerCrmWebhook error:", err);
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



// 2. Get Quote Route
app.post('/api/get-quote', async (req, res) => {
    try {
        const { location_id, distance, serviceType } = req.body;
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
app.get("/api/get-profile-widget/location_id", async (req, res) => {
  try {
    const { location_id } = req.params;

    // Use pool (your Postgres connection), not db
    const profile = await pool.query(
      "SELECT * FROM profiles WHERE location_id = $1",
      [location_id]
    );

    const fleet = await pool.query(
      "SELECT * FROM fleet_vehicles WHERE location_id = $1",
      [location_id]
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

app.use(express.static(path.join(__dirname, "public")));

app.get("/setup-wizard", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup-wizard.html"));
});

app.get("/setup-wizard?location_id={{location.id}}", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup-wizard.html"));
});

// 2. ENDPOINT FOR BOOKING: Map vehicle and CRM token
app.post("/api/create-booking", async (req, res) => {
  try {
    const {
      location_id,
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
        location_id, vehicle_slot_id, first_name, last_name,
        email, phone, pickup_address, pickup_coords,
        dropoff_address, dropoff_coords, start_time, total_price
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [location_id, vehicle_slot_id, first_name, last_name, email, phone, pickup_address, pickup_coords, dropoff_address, dropoff_coords, start_time, total_price]
    );

    // 2. THE BRIDGE: Get the Webhook URL for this specific user
    const userRes = await pool.query(
      "SELECT crm_webhook_url FROM users WHERE location_id = $1", 
      [location_id]
    );
    
    const webhookUrl = userRes.rows[0]?.crm_webhook_url;

    // 3. Trigger the Webhook to CRM
    if (webhookUrl && webhookUrl.startsWith('http')) {
      // We don't 'await' this so the customer gets their confirmation instantly
      fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location_id: location_id,
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

        const bookingId = Number(msg.payload);
        if (!Number.isInteger(bookingId) || bookingId <= 0) {
          console.log("⚠️ Invalid payload (expected bookingId number). Skipping.", {
            channel: msg.channel,
            payload: msg.payload,
          });
          return;
        }

        // Derive location_id from booking row
        const bookingRes = await pool.query(
          "SELECT id, location_id, location_id FROM bookings WHERE id = $1",
          [bookingId]
        );

        if (bookingRes.rows.length === 0) {
          console.log("⚠️ Booking not found. Skipping.", { bookingId });
          return;
        }

        const location_id =
          bookingRes.rows[0].location_id ||
          bookingRes.rows[0].location_id ||
          "default";

        await triggerCrmWebhook(location_id, bookingId);
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