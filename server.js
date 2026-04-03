/*****************************************************
 🚀 SERVER.JS - GO HIGH LEVEL SAAS BACKEND
*****************************************************/
import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import Stripe from 'stripe';
import dns from 'dns/promises';
import https from 'https';
import { Client as GoogleMapsClient } from "@googlemaps/google-maps-services-js";
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import * as turf from '@turf/turf';

const { Pool, Client } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const normalizedStripeSecretKey = String(process.env.STRIPE_SECRET_KEY || "").trim().replace(/^['"]|['"]$/g, "");
const stripe = normalizedStripeSecretKey
  ? new Stripe(normalizedStripeSecretKey, { apiVersion: "2025-02-24.acacia" })
  : null;

// 1. Define Environment Variables
const CRM_WEBHOOK_URL =
  process.env.CRM_WEBHOOK_URL ||
  "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/a7699638-aca6-4480-a0ce-25df857c9b33";

/*****************************************************
 1️⃣ DATABASE CONFIGURATION
*****************************************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Initialize the Google Maps Client for the Backend
const googleMapsClient = new GoogleMapsClient({});

async function tableExists(tableName) {
  const result = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return Boolean(result.rows[0]?.exists);
}

async function getTableColumns(tableName) {
  const result = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return new Set(result.rows.map((row) => row.column_name));
}

function safeParseJson(data, fallback = []) {
  try {
    if (!data) return fallback;
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return fallback;
  }
}

async function getProfileIdColumn() {
  const columns = await getTableColumns("profiles");
  if (columns.has("location_id")) return "location_id";
  if (columns.has("id")) return "id";
  throw new Error("Profiles table is missing both location_id and id columns.");
}

async function syncFixedRates(client, location_id, fixed_rates = []) {
  if (!(await tableExists("fixed_rates"))) return;

  const columns = await getTableColumns("fixed_rates");
  const fixedRatesIdColumn = columns.has("location_id")
    ? "location_id"
    : (columns.has("user_id") ? "user_id" : null);

  if (!fixedRatesIdColumn) return;

  await client.query(`DELETE FROM fixed_rates WHERE ${fixedRatesIdColumn} = $1`, [location_id]);

  for (const route of fixed_rates) {
    const fields = [];
    const values = [];
    const placeholders = [];

    const push = (field, value) => {
      if (!columns.has(field)) return;
      fields.push(field);
      values.push(value);
      placeholders.push(`$${values.length}`);
    };

    push(fixedRatesIdColumn, location_id);
    push("location_name", route.location_name || null);
    push("route_name", route.location_name || null);
    push("pickup_keyword", route.pickup_keyword || route.location_name || null);
    push("dropoff_keyword", route.dropoff_keyword || route.location_name || null);
    push("lat", Number.isFinite(Number(route.lat)) ? Number(route.lat) : null);
    push("lng", Number.isFinite(Number(route.lng)) ? Number(route.lng) : null);
    push("radius", Number.isFinite(Number(route.radius)) ? Number(route.radius) : null);
    push("fixed_price", parseFloat(route.fixed_price) || 0);
    push("is_active", true);

    if (!fields.length) continue;

    await client.query(
      `INSERT INTO fixed_rates (${fields.join(", ")}) VALUES (${placeholders.join(", ")})`,
      values
    );
  }
}

async function syncFleetSettings(client, location_id, fleet = []) {
  if (!(await tableExists("fleet_settings"))) return;

  const columns = await getTableColumns("fleet_settings");
  await client.query("DELETE FROM fleet_settings WHERE location_id = $1", [location_id]);

  for (const slot of fleet || []) {
    const fields = [];
    const values = [];
    const placeholders = [];

    const push = (field, value) => {
      if (!columns.has(field)) return;
      fields.push(field);
      values.push(value);
      placeholders.push(`$${values.length}`);
    };

    push("id", String(slot.vehicle_slot_id || "").trim());
    push("location_id", location_id);
    push("vehicle_slot_id", String(slot.vehicle_slot_id || "").trim());
    push("base_rate_cents", Math.round((parseFloat(slot.base_rate) || 0) * 100));
    push("mile_rate_cents", Math.round((parseFloat(slot.mile_rate) || 0) * 100));
    push("calendar_id", slot.calendar_id || null);
    push("is_active", true);
    push("base_rate", parseFloat(slot.base_rate) || 0);
    push("per_mile_rate", parseFloat(slot.mile_rate) || 0);
    push("minimum_fare", parseFloat(slot.minimum_fare) || 0);
    push("deposit_percent", parseFloat(slot.deposit_percent) || 0);
    push("slot_interval_min", parseInt(slot.slot_interval_min, 10) || 30);
    push("duration_min", parseInt(slot.duration_min, 10) || 105);
    push("inbound_buffer_min", parseInt(slot.inbound_buffer_min, 10) || 0);
    push("outbound_buffer_min", parseInt(slot.outbound_buffer_min, 10) || BOOKING_BUFFER_MINUTES);
    push("min_notice_min", parseInt(slot.min_notice_min, 10) || 120);

    if (!fields.length) continue;

    await client.query(
      `INSERT INTO fleet_settings (${fields.join(", ")}) VALUES (${placeholders.join(", ")})`,
      values
    );
  }
}

// --- MIDDLEWARE & SECURITY CONFIG ---
const allowedOrigins = [
  'https://app.leadconnectorhq.com',
  'https://app.crmonesource.com',
  'https://chauffeurdeluxe.crmonesource.com',
  'https://services.leadconnectorhq.com',
  'https://rideshare-scheduler-axx6.onrender.com',
  'http://localhost:5173',
  'http://localhost:8080'
];

function isAllowedOrigin(origin) {
  if (allowedOrigins.includes(origin)) return true;

  try {
    const { hostname, protocol } = new URL(origin);
    if (protocol !== 'https:') return false;

    return (
      hostname.endsWith('.crmonesource.com') ||
      hostname.endsWith('.leadconnectorhq.com') ||
      hostname.endsWith('.gohighlevel.com') ||
      hostname.endsWith('.msgsndr.com')
    );
  } catch {
    return false;
  }
}

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!isAllowedOrigin(origin)) {
      return callback(
        new Error('The CORS policy for this site does not allow access from the specified Origin.'),
        false
      );
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Setup-Wizard-Token']
}));

function getWizardToken(req) {
  return (
    req.query?.token ||
    req.headers['x-setup-wizard-token'] ||
    req.headers['X-Setup-Wizard-Token'] ||
    null
  );
}

function requireWizardToken(req, res, next) {
  const expectedToken = process.env.SETUP_WIZARD_TOKEN;
  if (!expectedToken) return next();

  const providedToken = getWizardToken(req);
  if (providedToken && String(providedToken) === String(expectedToken)) {
    return next();
  }

  return res.status(403).send("Forbidden");
}

app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));
app.get("/setup-wizard.html", requireWizardToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup-wizard.html"));
});
app.get("/setup-wizard", requireWizardToken, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup-wizard.html"));
});
app.use(express.static(path.join(__dirname, "public")));

// --- IFRAME & SECURITY POLICY ---
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

async function saveConfigHandler(req, res) {
  const client = await pool.connect();

  try {
    const {
      location_id,
      business_name,
      business_logo,
      brand_color_primary,
      brand_color_secondary,
      brand_color_accent,
      widget_tagline,
      plan_name,
      crm_webhook_url,
      maps_api_key,
      tax_rate,
      service_lat,
      service_lng,
      service_radius,
      fleet = [],
      fixed_rates = [],
      peak_windows = [],
      events = [],
      addons = []
    } = req.body;

    await client.query("BEGIN");
    const profileColumns = await getTableColumns("profiles");
    const profileIdColumn = profileColumns.has("location_id") ? "location_id" : "id";

    const fieldEntries = [];
    const pushProfileField = (column, value, cast = "") => {
      if (!profileColumns.has(column)) return;
      fieldEntries.push({ column, value, cast });
    };

    pushProfileField(profileIdColumn, location_id);
    pushProfileField("business_name", business_name);
    pushProfileField("business_logo", business_logo || null);
    pushProfileField("brand_color_primary", brand_color_primary || "#082f49");
    pushProfileField("brand_color_secondary", brand_color_secondary || "#0f766e");
    pushProfileField("brand_color_accent", brand_color_accent || "#ecfeff");
    pushProfileField("widget_tagline", widget_tagline || null);
    pushProfileField("plan_name", plan_name || "Starter");
    pushProfileField("crm_webhook_url", crm_webhook_url);
    pushProfileField("maps_api_key", maps_api_key);
    pushProfileField("tax_rate", tax_rate);
    pushProfileField("service_lat", service_lat);
    pushProfileField("service_lng", service_lng);
    pushProfileField("service_radius", service_radius);
    pushProfileField("service_radius_miles", service_radius);
    pushProfileField("fleet", JSON.stringify(fleet), "::jsonb");
    pushProfileField("peak_windows", JSON.stringify(peak_windows), "::jsonb");
    pushProfileField("events", JSON.stringify(events), "::jsonb");
    pushProfileField("special_events", JSON.stringify(events), "::jsonb");
    pushProfileField("addons", JSON.stringify(addons), "::jsonb");

    const fields = fieldEntries.map((entry) => entry.column);
    const values = fieldEntries.map((entry) => entry.value);
    const placeholders = fieldEntries.map((entry, index) => `$${index + 1}${entry.cast || ""}`);
    const updateAssignments = fields
      .filter((field) => field !== profileIdColumn)
      .map((field) => `${field} = EXCLUDED.${field}`);

    const updateClause = updateAssignments.length
      ? `DO UPDATE SET ${updateAssignments.join(", ")}`
      : "DO NOTHING";

    await client.query(
      `INSERT INTO profiles (${fields.join(", ")})
       VALUES (${placeholders.join(", ")})
       ON CONFLICT (${profileIdColumn})
       ${updateClause}`,
      values
    );

    if (await tableExists("fleet_slots")) {
      await client.query(
        `DELETE FROM fleet_slots WHERE location_id = $1`,
        [location_id]
      );

      for (const v of fleet) {
        await client.query(
          `
          INSERT INTO fleet_slots (
            location_id,
            vehicle_slot_id,
            name,
            base_rate,
            per_mile_rate,
            calendar_id
          )
          VALUES ($1,$2,$3,$4,$5,$6)
          `,
          [
            location_id,
            v.vehicle_slot_id,
            v.vehicle_type,
            parseFloat(v.base_rate) || 0,
            parseFloat(v.mile_rate) || 0,
            v.calendar_id || null
          ]
        );
      }
    }

    await syncFleetSettings(client, location_id, fleet);

    await syncFixedRates(client, location_id, fixed_rates);

    await client.query("COMMIT");

    return res.json({
      success: true,
      message: "✅ Profile fully saved and aligned"
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ SAVE ERROR:", err);

    return res.status(500).json({
      success: false,
      error: err.message
    });
  } finally {
    client.release();
  }
}

// This handles the "Save" button from your Wizard
app.post("/api/save-config", requireWizardToken, saveConfigHandler);

// This fixes the "Cannot GET /api/health" error
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'SaaS Master Engine Online', 
        time: new Date().toISOString() 
    });
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
const DEFAULT_TRIP_MINUTES = 60;
const BOOKING_BUFFER_MINUTES = 20;

/* 🔐 Get Maps API Key from Database */
async function getMapsKey(location_id) {
  const profileIdColumn = await getProfileIdColumn();
  const res = await pool.query(
    `SELECT maps_api_key FROM profiles WHERE ${profileIdColumn} = $1`,
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

  try {
    const response = await fetch(url);
    const json = await response.json();
    if (json.rows?.[0]?.elements?.[0]?.status === "OK") {
      const minutes = Math.ceil(json.rows[0].elements[0].duration.value / 60 / 5) * 5;
      travelTimeCache.set(cacheKey, minutes);
      return minutes;
    }
    return 15;
  } catch {
    return 15;
  }
}

async function getRouteMetrics({
  origin,
  destination,
  originLat,
  originLng,
  destinationLat,
  destinationLng,
  mapsApiKey,
}) {
  const fallback = () => {
    const hasCoords = [originLat, originLng, destinationLat, destinationLng].every((value) => Number.isFinite(Number(value)));
    if (hasCoords) {
      const miles = turf.distance(
        turf.point([Number(originLng), Number(originLat)]),
        turf.point([Number(destinationLng), Number(destinationLat)]),
        { units: "miles" }
      );
      const estimatedMinutes = Math.max(
        DEFAULT_TRIP_MINUTES,
        Math.ceil(((miles / 30) * 60) / 5) * 5
      );
      return {
        distanceMiles: Number(miles.toFixed(2)),
        durationMinutes: estimatedMinutes,
        source: "coordinate_fallback",
      };
    }

    return {
      distanceMiles: 0,
      durationMinutes: DEFAULT_TRIP_MINUTES,
      source: "default_fallback",
    };
  };

  if (!mapsApiKey || !origin || !destination) {
    return fallback();
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(origin)}&destinations=${encodeURIComponent(destination)}&departure_time=now&key=${mapsApiKey}`;
    const response = await fetch(url);
    const json = await response.json();
    const element = json.rows?.[0]?.elements?.[0];

    if (element?.status === "OK") {
      return {
        distanceMiles: Number((element.distance.value / 1609.34).toFixed(2)),
        durationMinutes: Math.ceil((element.duration.value / 60) / 5) * 5,
        source: "google_distance_matrix",
      };
    }
  } catch (err) {
    console.warn("Route metric lookup failed, using fallback:", err.message);
  }

  return fallback();
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

app.get('/api/test', (req, res) => {
    const host = req.get('host'); 
    const fullUrl = `${req.protocol}://${host}${req.originalUrl}`;
});

app.get("/test-page", (req, res) => {
  res.send("<h1>Server route works</h1>");
});
    
app.post('/api/update-profile-full-legacy', async (req, res) => {
    const {
        location_id,
        business_name,
        crm_webhook_url, 
        maps_api_key,
        tax_rate,
        service_lat,
        service_lng,
        service_radius,
        fleet,
        fixed_rates,
        peak_windows,
        events,
        addons
    } = req.body;

    let client;

    try {
        client = await pool.connect();
        await client.query('BEGIN');

        // 1. UPSERT THE MAIN PROFILE
        await client.query(
            `INSERT INTO profiles (
                location_id, business_name, crm_webhook_url, maps_api_key, tax_rate, service_lat, service_lng, service_radius, fleet, fixed_rates, events, peak_windows, addons
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (location_id) 
            DO UPDATE SET 
                business_name = EXCLUDED.business_name,
                crm_webhook_url = EXCLUDED.crm_webhook_url,
                maps_api_key = EXCLUDED.maps_api_key,
                tax_rate = EXCLUDED.tax_rate,
                service_lat = EXCLUDED.service_lat,
                service_lng = EXCLUDED.service_lng,
                service_radius = EXCLUDED.service_radius,
                fleet = EXCLUDED.fleet,
                fixed_rates = EXCLUDED.fixed_rates,
                events = EXCLUDED.events,
                peak_windows = EXCLUDED.peak_windows,
                addons = EXCLUDED.addons`,
            [
                location_id,
                business_name || null,
                crm_webhook_url,
                maps_api_key,
                tax_rate || 0,
                service_lat || null,
                service_lng || null,
                service_radius || null,
                JSON.stringify(fleet || []),
                JSON.stringify(fixed_rates || []),
                JSON.stringify(events || []),
                JSON.stringify(peak_windows || []),
                JSON.stringify(addons || [])
            ]
        );

        // 2. CLEAR AND REFRESH FLEET SLOTS
await client.query('DELETE FROM fleet_slots WHERE location_id = $1', [location_id]);

if (fleet && fleet.length > 0) {
    for (const vehicle of fleet) {
        const vehicle_slot_id = String(vehicle.vehicle_slot_id || "").trim();
        if (!vehicle_slot_id) {
            throw new Error("Each fleet row must include vehicle_slot_id.");
        }

        await client.query(
            `INSERT INTO fleet_slots (
                location_id,        -- $1
                vehicle_slot_id,    -- $2
                name,               -- $3
                base_rate,          -- $4
                per_mile_rate,      -- $5
                calendar_id         -- $6
            ) VALUES ($1, $2, $3, $4, $5, $6)`,
            [
                location_id,                                    // $1
                vehicle_slot_id,                                // $2
                vehicle.vehicle_type || null,                   // $3
                parseFloat(vehicle.base_rate) || 0,             // $4
                parseFloat(vehicle.mile_rate) || 0,             // $5
                vehicle.calendar_id || null                     // $6
            ]
        );
    }
}

        await client.query('COMMIT');
        console.log(`✅ Profile and FleetSlots synced for: ${location_id}`);
        res.json({ success: true, message: 'All settings and slots saved!' });

    } catch (err) {
        if (client) await client.query('ROLLBACK');
        console.error("❌ Blended Save Error:", err.message);
        res.status(500).json({ error: "Failed to save profile settings.", detail: err.message });
    } finally {
        if (client) client.release();
    }
});

app.post('/api/update-profile-full', requireWizardToken, saveConfigHandler);

app.post("/api/create-payment-intent", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured on the backend." });
    }

    const {
      amount,
      currency = "usd",
      booking_id = null,
      location_id = null,
      customer_email = null,
      customer_name = null,
      metadata = {},
    } = req.body;

    const amountCents = Math.round(Number(amount || 0) * 100);
    if (!amountCents || amountCents < 50) {
      return res.status(400).json({ error: "Payment amount must be at least $0.50." });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency,
      automatic_payment_methods: { enabled: true },
      receipt_email: customer_email || undefined,
      description: customer_name
        ? `Rideshare booking payment for ${customer_name}`
        : "Rideshare booking payment",
      metadata: {
        booking_id: booking_id ? String(booking_id) : "",
        location_id: location_id ? String(location_id) : "",
        ...Object.fromEntries(
          Object.entries(metadata || {}).map(([key, value]) => [key, value == null ? "" : String(value)])
        ),
      },
    });

    return res.json({
      success: true,
      payment_intent_id: paymentIntent.id,
      client_secret: paymentIntent.client_secret,
      amount: amountCents / 100,
      currency,
    });
  } catch (err) {
    console.error("Stripe payment intent error:", err);
    return res.status(500).json({ error: err.message || "Failed to create payment intent." });
  }
});

function appendQueryParams(urlString, params = {}) {
  const url = new URL(urlString);
  Object.entries(params).forEach(([key, value]) => {
    if (value == null || value === "") return;
    url.searchParams.set(key, String(value));
  });
  return url.toString();
}

function sanitizeReturnUrl(rawUrl, req) {
  try {
    if (!rawUrl) {
      return `${req.protocol}://${req.get("host")}/`;
    }
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new Error("Unsupported return URL protocol.");
    }
    return url.toString();
  } catch {
    return `${req.protocol}://${req.get("host")}/`;
  }
}

app.post("/api/confirm-booking-payment", async (req, res) => {
  try {
    const {
      booking_id,
      payment_status = "paid_in_full",
      total_price = 0,
      deposit_amount = 0,
      deposit_percent = 100,
    } = req.body;

    if (!booking_id) {
      return res.status(400).json({ error: "booking_id is required." });
    }

    const confirmation = await updateBookingConfirmation({
      bookingId: booking_id,
      paymentStatus: payment_status,
      totalPrice: total_price,
      depositAmount: deposit_amount,
      depositPercent: deposit_percent,
    });

    return res.json({ success: true, booking: confirmation });
  } catch (err) {
    console.error("Confirm booking payment error:", err);
    return res.status(500).json({ error: err.message || "Failed to confirm booking payment." });
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
        // 1. Check for Events First (Date-based)
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

function buildCrmBookingPayload({
  webhookType = "BOOKING_CONFIRMED",
  locationId,
  businessName,
  booking,
  customer,
  vehicle,
  financials,
  meta = {},
}) {
  const rawStatus = String(booking.status || "confirmed").toLowerCase();
  const normalizedStatus = rawStatus === "pending" ? "unconfirmed" : rawStatus;
  const isConfirmed = rawStatus === "confirmed";
  const paymentStatus = financials.payment_status || (
    Number(financials.deposit_amount || 0) > 0
      ? (Number(financials.balance_due || 0) > 0 ? "paid_deposit" : "paid_in_full")
      : "unpaid"
  );
  const paymentPaid = Object.prototype.hasOwnProperty.call(financials, "payment_paid")
    ? Boolean(financials.payment_paid)
    : paymentStatus !== "unpaid";
  const depositPaid = Object.prototype.hasOwnProperty.call(financials, "deposit_paid")
    ? Boolean(financials.deposit_paid)
    : Number(financials.deposit_amount || 0) > 0;
  const balancePaid = Object.prototype.hasOwnProperty.call(financials, "balance_paid")
    ? Boolean(financials.balance_paid)
    : Number(financials.balance_due || 0) <= 0;
  const paymentRequired = !paymentPaid;

  return {
    webhook_type: webhookType,
    location_id: locationId,
    business_name: businessName || null,
    source: meta.source || "booking_widget",
    created_at: meta.created_at || new Date().toISOString(),
    booking_confirmed: isConfirmed,
    payment_follow_up_required: paymentRequired,
    booking: {
      booking_id: booking.booking_id,
      status: normalizedStatus,
      is_confirmed: isConfirmed,
      pickup_address: booking.pickup_address || null,
      dropoff_address: booking.dropoff_address || null,
      pickup_lat: booking.pickup_lat ?? null,
      pickup_lng: booking.pickup_lng ?? null,
      dropoff_lat: booking.dropoff_lat ?? null,
      dropoff_lng: booking.dropoff_lng ?? null,
      start_time: booking.start_time || null,
      end_time: booking.end_time || null,
      passenger_count: Number(booking.passenger_count || 1),
      carry_on_count: Number(booking.carry_on_count || 0),
      checked_bag_count: Number(booking.checked_bag_count || 0),
      additional_items_aboard: booking.additional_items_aboard || null,
      selected_event_name: booking.selected_event_name || null,
      selected_addons: Array.isArray(booking.selected_addons) ? booking.selected_addons : [],
    },
    customer: {
      first_name: customer.first_name || null,
      last_name: customer.last_name || null,
      email: customer.email || null,
      phone: customer.phone || null,
    },
    vehicle: {
      vehicle_slot_id: vehicle.vehicle_slot_id || null,
      vehicle_type: vehicle.vehicle_type || null,
      vehicle_category: vehicle.vehicle_category || null,
      calendar_id: vehicle.calendar_id || null,
    },
    financials: {
      quoted_price: Number(financials.quoted_price || 0),
      addon_total: Number(financials.addon_total || 0),
      tax_amount: Number(financials.tax_amount || 0),
      total_price: Number(financials.total_price || 0),
      deposit_percent: Number(financials.deposit_percent || 0),
      deposit_amount: Number(financials.deposit_amount || 0),
      balance_due: Number(financials.balance_due || 0),
      payment_status: paymentStatus,
      payment_paid: paymentPaid,
      deposit_paid: depositPaid,
      balance_paid: balancePaid,
      payment_required: paymentRequired,
      payment_link: financials.payment_link || null,
    },
    follow_up: {
      send_payment_sms: paymentRequired,
      send_payment_email: paymentRequired,
      reminder_reason: paymentRequired ? "complete_booking_payment" : null,
    },
  };
}

function getPaymentBooleans({
  paymentStatus = "unpaid",
  paymentPaid,
  depositPaid,
  balancePaid,
  depositAmount = 0,
  balanceDue = 0,
}) {
  return {
    paymentStatus,
    paymentPaid: typeof paymentPaid === "boolean" ? paymentPaid : paymentStatus !== "unpaid",
    depositPaid: typeof depositPaid === "boolean" ? depositPaid : Number(depositAmount || 0) > 0,
    balancePaid: typeof balancePaid === "boolean" ? balancePaid : Number(balanceDue || 0) <= 0,
  };
}

function getBookingConfirmationState({
  bookingConfirmed,
  paymentStatus = "unpaid",
  paymentPaid = false,
}) {
  if (typeof bookingConfirmed === "boolean") {
    return bookingConfirmed;
  }

  if (paymentPaid) {
    return paymentStatus === "paid_in_full" || paymentStatus === "paid_deposit";
  }

  return false;
}

async function updateBookingConfirmation({
  bookingId,
  paymentStatus,
  depositAmount,
  depositPercent,
  totalPrice,
}) {
  const numericTotalPrice = Number(totalPrice || 0);
  const numericDepositAmount = Number(depositAmount || 0);
  const numericDepositPercent = Number(depositPercent || 0);
  const balanceDue = Number((numericTotalPrice - numericDepositAmount).toFixed(2));

  const result = await pool.query(
    `UPDATE bookings
     SET status = $1,
         total_price = $2,
         deposit_amount = $3,
         deposit_percent = $4,
         balance_due = $5
     WHERE id = $6
     RETURNING id, location_id`,
    [
      "confirmed",
      numericTotalPrice,
      numericDepositAmount,
      numericDepositPercent,
      balanceDue,
      bookingId,
    ]
  );

  if (!result.rows.length) {
    throw new Error("Booking not found for payment confirmation.");
  }

  await triggerCrmWebhook(result.rows[0].location_id, result.rows[0].id);

  return {
    booking_id: result.rows[0].id,
    location_id: result.rows[0].location_id,
    status: "confirmed",
    payment_status: paymentStatus,
    balance_due: balanceDue,
  };
}

async function createBookingRecord(input, { paymentLink = null, triggerWebhook = true } = {}) {
  const {
    location_id,
    vehicle_slot_id,
    first_name,
    last_name,
    email,
    phone,
    pickup_address,
    dropoff_address,
    pickup_lat,
    pickup_lng,
    dropoff_lat,
    dropoff_lng,
    start_time,
    total_price,
    quoted_price = 0,
    addon_total = 0,
    tax_amount = 0,
    payment_status = "unpaid",
    payment_paid = false,
    deposit_paid = false,
    balance_paid = false,
    booking_confirmed,
    deposit_percent = 0,
    deposit_amount = 0,
    passenger_count = 1,
    carry_on_count = 0,
    checked_bag_count = 0,
    additional_items_aboard = null,
    selected_event_name = null,
    selected_addons = []
  } = input;

  if (!location_id || !vehicle_slot_id || !first_name || !last_name || !start_time) {
    throw new Error("Missing required booking fields.");
  }

  const profileLookup = await pool.query(
    `SELECT crm_webhook_url, business_name, maps_api_key, fleet
     FROM profiles
     WHERE location_id = $1`,
    [location_id]
  );
  const profile = profileLookup.rows[0] || {};

  let fleetVehicle = null;
  if (await tableExists("fleet_slots")) {
    const fleetLookup = await pool.query(
      `SELECT
         calendar_id,
         name AS vehicle_type,
         NULL AS vehicle_category
       FROM fleet_slots
       WHERE vehicle_slot_id = $1 AND location_id = $2
       LIMIT 1`,
      [vehicle_slot_id, location_id]
    );
    fleetVehicle = fleetLookup.rows[0] || null;
  }

  if (!fleetVehicle && await tableExists("fleet_settings")) {
    const fleetSettingsLookup = await pool.query(
      `SELECT
         calendar_id,
         vehicle_slot_id,
         base_rate,
         per_mile_rate,
         NULL AS vehicle_category
       FROM fleet_settings
       WHERE vehicle_slot_id = $1 AND location_id = $2
       LIMIT 1`,
      [vehicle_slot_id, location_id]
    );
    fleetVehicle = fleetSettingsLookup.rows[0]
      ? {
          ...fleetSettingsLookup.rows[0],
          vehicle_type: fleetSettingsLookup.rows[0].vehicle_slot_id
        }
      : null;
  }

  if (!fleetVehicle) {
    const profileFleet = safeParseJson(profile.fleet);
    fleetVehicle = (Array.isArray(profileFleet) ? profileFleet : []).find(
      (vehicle) => String(vehicle.vehicle_slot_id || "") === String(vehicle_slot_id)
    ) || null;
  }

  const webhookUrl = profile.crm_webhook_url || null;
  const calendar_id = fleetVehicle?.calendar_id || null;
  const vehicle_type = fleetVehicle?.vehicle_type || fleetVehicle?.name || null;
  const vehicle_category = fleetVehicle?.vehicle_category || null;

  const routeMetrics = await getRouteMetrics({
    origin: pickup_address,
    destination: dropoff_address,
    originLat: pickup_lat,
    originLng: pickup_lng,
    destinationLat: dropoff_lat,
    destinationLng: dropoff_lng,
    mapsApiKey: profile.maps_api_key || null,
  });
  const bookingDurationMinutes = routeMetrics.durationMinutes + BOOKING_BUFFER_MINUTES;
  const end_time = new Date(
    new Date(start_time).getTime() + bookingDurationMinutes * 60000
  ).toISOString();

  const numericTotalPrice = Number(total_price) || 0;
  const numericDepositPercent = Number(deposit_percent) || 0;
  const numericDepositAmount = Number(deposit_amount) || 0;
  const balance_due = Number(
    (numericTotalPrice - numericDepositAmount).toFixed(2)
  );
  const paymentState = getPaymentBooleans({
    paymentStatus: payment_status,
    paymentPaid: Boolean(payment_paid),
    depositPaid: Boolean(deposit_paid),
    balancePaid: Boolean(balance_paid),
    depositAmount: numericDepositAmount,
    balanceDue: balance_due,
  });
  const isBookingConfirmed = getBookingConfirmationState({
    bookingConfirmed: booking_confirmed,
    paymentStatus: paymentState.paymentStatus,
    paymentPaid: paymentState.paymentPaid,
  });
  const bookingStatus = isBookingConfirmed ? "confirmed" : "pending";

  const result = await pool.query(
    `INSERT INTO bookings (
      location_id,
      vehicle_slot_id,
      first_name,
      last_name,
      customer_email,
      customer_phone,
      pickup_address,
      dropoff_address,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
      start_time,
      end_time,
      total_price,
      calendar_id,
      deposit_amount,
      deposit_percent,
      balance_due,
      status
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20
    )
    RETURNING id`,
    [
      location_id,
      vehicle_slot_id,
      first_name,
      last_name,
      email,
      phone,
      pickup_address,
      dropoff_address,
      pickup_lat,
      pickup_lng,
      dropoff_lat,
      dropoff_lng,
      start_time,
      end_time,
      numericTotalPrice,
      calendar_id,
      numericDepositAmount,
      numericDepositPercent,
      balance_due,
      bookingStatus
    ]
  );

  const booking_id = result.rows[0]?.id || null;

  if (triggerWebhook && webhookUrl && webhookUrl.startsWith("http")) {
    const crmPayload = buildCrmBookingPayload({
      webhookType: "webhook_bookings",
      locationId: location_id,
      businessName: profileLookup.rows[0]?.business_name || null,
      booking: {
        booking_id,
        status: bookingStatus,
        pickup_address,
        dropoff_address,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        start_time,
        end_time,
        passenger_count,
        carry_on_count,
        checked_bag_count,
        additional_items_aboard,
        selected_event_name,
        selected_addons,
      },
      customer: {
        first_name,
        last_name,
        email,
        phone,
      },
      vehicle: {
        vehicle_slot_id,
        vehicle_type,
        vehicle_category,
        calendar_id: calendar_id ? String(calendar_id) : null,
      },
      financials: {
        quoted_price: Number(quoted_price || 0),
        addon_total: Number(addon_total || 0),
        tax_amount: Number(tax_amount || 0),
        total_price: numericTotalPrice,
        deposit_percent: numericDepositPercent,
        deposit_amount: numericDepositAmount,
        balance_due,
        payment_status: paymentState.paymentStatus,
        payment_paid: paymentState.paymentPaid,
        deposit_paid: paymentState.depositPaid,
        balance_paid: paymentState.balancePaid,
        payment_link: paymentLink,
      },
      meta: {
        source: "booking_widget",
      },
    });

    fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(crmPayload)
    }).catch((e) => {
      console.error("Webhook Failed:", e);
    });
  }

  return {
    success: true,
    message: "Booking saved and webhook triggered",
    booking: {
      id: booking_id,
      location_id,
      status: bookingStatus,
      vehicle: {
        vehicle_slot_id,
        vehicle_type,
        vehicle_category,
        calendar_id
      },
      customer: {
        first_name,
        last_name,
        email,
        phone
      },
      trip: {
        pickup_address,
        dropoff_address,
        pickup_lat,
        pickup_lng,
        dropoff_lat,
        dropoff_lng,
        start_time,
        end_time
      }
    },
    financials: {
      total_price: numericTotalPrice,
      deposit_percent: numericDepositPercent,
      deposit_amount: numericDepositAmount,
      balance_due
    },
    meta: {
      created_at: new Date().toISOString(),
      source: "booking_widget",
      route_distance_miles: routeMetrics.distanceMiles,
      route_duration_minutes: routeMetrics.durationMinutes,
      booking_buffer_minutes: BOOKING_BUFFER_MINUTES,
      booking_duration_minutes: bookingDurationMinutes,
      timing_source: routeMetrics.source
    }
  };
}

app.post("/api/create-checkout-session", async (req, res) => {
  let bookingId = null;
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured on the backend." });
    }

    const returnUrl = sanitizeReturnUrl(req.body.return_url, req);
    const totalPrice = Number(req.body.total_price || 0);
    const depositAmount = Number(req.body.deposit_amount || 0);
    const depositPercent = Number(req.body.deposit_percent || 0);
    const shouldChargeDeposit = depositAmount > 0 && depositAmount < totalPrice;
    const amountToCharge = shouldChargeDeposit ? depositAmount : totalPrice;
    const paymentStatus = shouldChargeDeposit ? "paid_deposit" : "paid_in_full";

    if (!amountToCharge || amountToCharge < 0.5) {
      return res.status(400).json({ error: "Charge amount must be at least $0.50." });
    }

    const bookingResult = await createBookingRecord(
      {
        ...req.body,
        booking_confirmed: false,
        payment_status: "unpaid",
        payment_paid: false,
        deposit_paid: false,
        balance_paid: false,
      },
      { triggerWebhook: false }
    );

    bookingId = bookingResult.booking?.id;
    const businessName = bookingResult.booking?.customer?.first_name
      ? `${bookingResult.booking.customer.first_name} ${bookingResult.booking.customer.last_name}`.trim()
      : "Customer";
    const vehicleType = bookingResult.booking?.vehicle?.vehicle_type || "Private ride";
    const successUrl = appendQueryParams(returnUrl, {
      checkout: "success",
      session_id: "{CHECKOUT_SESSION_ID}",
      booking_id: bookingId,
    });
    const cancelUrl = appendQueryParams(returnUrl, {
      checkout: "cancel",
      booking_id: bookingId,
    });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      success_url: successUrl,
      cancel_url: cancelUrl,
      customer_email: req.body.email || undefined,
      metadata: {
        booking_id: String(bookingId),
        location_id: String(req.body.location_id || ""),
        total_price: String(totalPrice.toFixed(2)),
        deposit_amount: String((shouldChargeDeposit ? depositAmount : totalPrice).toFixed(2)),
        deposit_percent: String(shouldChargeDeposit ? depositPercent : 100),
        payment_status: paymentStatus,
      },
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: Math.round(amountToCharge * 100),
            product_data: {
              name: shouldChargeDeposit ? "Reservation deposit" : "Reservation payment",
              description: `${vehicleType} booking for ${businessName}`,
            },
          },
        },
      ],
    });

    return res.json({
      success: true,
      checkout_url: session.url,
      booking_id: bookingId,
      payment_status: paymentStatus,
      amount_due_now: Number(amountToCharge.toFixed(2)),
      booking: bookingResult.booking,
    });
  } catch (err) {
    if (bookingId) {
      try {
        await pool.query(
          `DELETE FROM bookings WHERE id = $1 AND status = $2`,
          [bookingId, "pending"]
        );
      } catch (cleanupErr) {
        console.error("Stripe checkout cleanup error:", cleanupErr);
      }
    }

    const stripeMessage = err?.raw?.message || err?.message || "Failed to create checkout session.";
    const stripeContext = {
      type: err?.type || null,
      code: err?.code || err?.raw?.code || null,
      decline_code: err?.decline_code || err?.raw?.decline_code || null,
      request_id: err?.requestId || err?.raw?.requestId || null,
      statusCode: err?.statusCode || null,
    };
    console.error("Stripe checkout session error:", stripeMessage, stripeContext);
    return res.status(500).json({
      error: stripeMessage,
      stripe: stripeContext,
    });
  }
});

app.get("/api/checkout-session-status", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ error: "Stripe is not configured on the backend." });
    }

    const sessionId = String(req.query.session_id || "").trim();
    if (!sessionId) {
      return res.status(400).json({ error: "session_id is required." });
    }

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const bookingId = session.metadata?.booking_id;
    const paymentStatus = session.metadata?.payment_status || "paid_in_full";
    const totalPrice = Number(session.metadata?.total_price || 0);
    const depositAmount = Number(session.metadata?.deposit_amount || 0);
    const depositPercent = Number(session.metadata?.deposit_percent || 100);

    if (session.payment_status === "paid" && bookingId) {
      const confirmation = await updateBookingConfirmation({
        bookingId,
        paymentStatus,
        totalPrice,
        depositAmount,
        depositPercent,
      });

      const bookingLookup = await pool.query(
        `SELECT id, first_name, pickup_address, dropoff_address, start_time
         FROM bookings
         WHERE id = $1
         LIMIT 1`,
        [bookingId]
      );

      return res.json({
        success: true,
        paid: true,
        booking: confirmation,
        reservation: bookingLookup.rows[0] || null,
      });
    }

    return res.json({
      success: true,
      paid: false,
      booking_id: bookingId || null,
      payment_status: session.payment_status || "unpaid",
    });
  } catch (err) {
    console.error("Checkout session status error:", err);
    return res.status(500).json({ error: err.message || "Failed to verify checkout session." });
  }
});

app.get("/api/stripe-health", async (req, res) => {
  const result = {
    stripe_configured: Boolean(stripe),
    dns: null,
    tls: null,
    balance: null,
  };

  try {
    const lookup = await dns.lookup("api.stripe.com");
    result.dns = { ok: true, address: lookup.address, family: lookup.family };
  } catch (err) {
    result.dns = {
      ok: false,
      error: err?.message || "DNS lookup failed.",
      code: err?.code || null,
    };
  }

  result.tls = await new Promise((resolve) => {
    const req = https.request(
      {
        host: "api.stripe.com",
        port: 443,
        method: "HEAD",
        path: "/",
        timeout: 10000,
      },
      (response) => {
        resolve({
          ok: true,
          statusCode: response.statusCode || null,
          headers: {
            server: response.headers.server || null,
          },
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error("TLS request timed out."));
    });
    req.on("error", (err) => {
      resolve({
        ok: false,
        error: err?.message || "TLS request failed.",
        code: err?.code || null,
      });
    });
    req.end();
  });

  if (stripe) {
    try {
      const balance = await stripe.balance.retrieve();
      result.balance = {
        ok: true,
        available: Array.isArray(balance.available) ? balance.available.length : 0,
        livemode: Boolean(balance.livemode),
      };
    } catch (err) {
      result.balance = {
        ok: false,
        error: err?.raw?.message || err?.message || "Stripe API request failed.",
        type: err?.type || null,
        code: err?.code || err?.raw?.code || null,
        statusCode: err?.statusCode || null,
      };
    }
  }

  const allGood = Boolean(result.stripe_configured && result.dns?.ok && result.tls?.ok && result.balance?.ok);
  return res.status(allGood ? 200 : 503).json(result);
});

app.get("/api/stripe-health-raw", async (req, res) => {
  const response = {
    stripe_configured: Boolean(normalizedStripeSecretKey),
    env_key_prefix: normalizedStripeSecretKey ? normalizedStripeSecretKey.slice(0, 7) : null,
    env_key_length: normalizedStripeSecretKey ? normalizedStripeSecretKey.length : 0,
    proxy_env: {
      HTTPS_PROXY: process.env.HTTPS_PROXY || null,
      HTTP_PROXY: process.env.HTTP_PROXY || null,
      ALL_PROXY: process.env.ALL_PROXY || null,
    },
    raw_balance_call: null,
  };

  if (!normalizedStripeSecretKey) {
    return res.status(500).json({
      ...response,
      raw_balance_call: { ok: false, error: "Stripe secret key is not configured." },
    });
  }

  response.raw_balance_call = await new Promise((resolve) => {
    const request = https.request(
      {
        host: "api.stripe.com",
        port: 443,
        method: "GET",
        path: "/v1/balance",
        timeout: 15000,
        headers: {
          Authorization: `Bearer ${normalizedStripeSecretKey}`,
          "User-Agent": "rideshare-scheduler-stripe-health",
        },
      },
      (stripeRes) => {
        let body = "";
        stripeRes.on("data", (chunk) => {
          body += chunk.toString("utf8");
        });
        stripeRes.on("end", () => {
          resolve({
            ok: stripeRes.statusCode && stripeRes.statusCode < 500,
            statusCode: stripeRes.statusCode || null,
            body: body.slice(0, 1000),
          });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("Raw Stripe request timed out."));
    });
    request.on("error", (err) => {
      resolve({
        ok: false,
        error: err?.message || "Raw Stripe request failed.",
        code: err?.code || null,
      });
    });
    request.end();
  });

  return res.status(response.raw_balance_call?.ok ? 200 : 503).json(response);
});

async function triggerCrmWebhook(location_id, booking_id) {
  let client;
  try {
    client = await pool.connect();

    const bookingRes = await client.query(
      "SELECT * FROM bookings WHERE id = $1",
      [booking_id]
    );
    if (bookingRes.rows.length === 0) {
      console.log("⚠️ Booking not found.");
      return;
    }

    const b = bookingRes.rows[0];

    const profileRes = await client.query(
      "SELECT crm_webhook_url, tax_rate, business_name FROM profiles WHERE location_id = $1",
      [location_id]
    );
    const p = profileRes.rows[0];

    if (!p?.crm_webhook_url) {
      console.log(`⚠️ No CRM Webhook found for location: ${location_id}`);
      return;
    }

    const totalPrice = Number(b.total_price || 0);
    const depositAmount = Number(b.deposit_amount || 0);
    const balanceDue = Number((totalPrice - depositAmount).toFixed(2));

    const payload = buildCrmBookingPayload({
      webhookType: "webhook_bookings",
      locationId: location_id,
      businessName: p.business_name,
      booking: {
        booking_id: b.id,
        status: b.status || "confirmed",
        pickup_address: b.pickup_address,
        dropoff_address: b.dropoff_address,
        pickup_lat: b.pickup_lat,
        pickup_lng: b.pickup_lng,
        dropoff_lat: b.dropoff_lat,
        dropoff_lng: b.dropoff_lng,
        start_time: b.start_time,
        end_time: b.end_time,
      },
      customer: {
        first_name: b.first_name,
        last_name: b.last_name,
        email: b.customer_email,
        phone: b.customer_phone,
      },
      vehicle: {
        vehicle_slot_id: b.vehicle_slot_id,
        vehicle_type: b.vehicle_type,
        calendar_id: b.calendar_id,
      },
      financials: {
        total_price: totalPrice,
        deposit_amount: depositAmount,
        deposit_percent: Number(b.deposit_percent || 0),
        balance_due: balanceDue,
      },
      meta: {
        source: "database_listener",
      },
    });

    const resp = await fetch(p.crm_webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
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
app.get("/api/get-profile/:location_id", requireWizardToken, async (req, res) => {
  const { location_id } = req.params;
  let client;
  try {
    client = await pool.connect();
    const profileIdColumn = await getProfileIdColumn();
    const profileRes = await client.query(`SELECT * FROM profiles WHERE ${profileIdColumn} = $1`, [location_id]);

    if (profileRes.rows.length === 0) return res.status(404).json({ error: "Profile not found" });

    const profile = profileRes.rows[0];
    let parsedFixedRates = safeParseJson(profile.fixed_rates);
    if (await tableExists("fixed_rates")) {
      const fixedRatesColumns = await getTableColumns("fixed_rates");
      const fixedRatesIdColumn = fixedRatesColumns.has("location_id")
        ? "location_id"
        : (fixedRatesColumns.has("user_id") ? "user_id" : null);
      if (fixedRatesIdColumn) {
      const fixedRatesRes = await client.query(
        `SELECT * FROM fixed_rates WHERE ${fixedRatesIdColumn} = $1 AND COALESCE(is_active, true) = true`,
        [location_id]
      );
      parsedFixedRates = fixedRatesRes.rows;
      }
    }

const parsedEvents = safeParseJson(profile.events);
const parsedPeakWindows = safeParseJson(profile.peak_windows);
const parsedAddons = safeParseJson(profile.addons);

res.json({
  location_id: profile.location_id || profile.id,
  plan_name: profile.plan_name || "Starter",

  business_name: profile.business_name,
  business_logo: profile.business_logo || "",
  brand_color_primary: profile.brand_color_primary || "#082f49",
  brand_color_secondary: profile.brand_color_secondary || "#0f766e",
  brand_color_accent: profile.brand_color_accent || "#ecfeff",
  widget_tagline: profile.widget_tagline || "",
  maps_api_key: profile.maps_api_key,
  crm_webhook_url: profile.crm_webhook_url,
  tax_rate: parseFloat(profile.tax_rate) || 0,

  financials: {
    tax_rate: parseFloat(profile.tax_rate) || 0,
    default_deposit_percent: parseFloat(profile.deposit_percent) || 0,
    default_deposit_flat_cents: parseInt(profile.deposit_flat_cents) || 0
  },

  quote_financials: {
    total_price: 0,
    deposit_amount: 0,
    balance_due: 0
  },

  vehicle_types: [
    { label: "Standard Sedan", category: "sedan" },
    { label: "Luxury Sedan", category: "sedan" },
    { label: "Standard SUV", category: "suv" },
    { label: "Luxury SUV", category: "suv" },
    { label: "Standard XL SUV", category: "xl" },
    { label: "Luxury XL SUV", category: "xl" }
  ],

  fleet: (Array.isArray(safeParseJson(profile.fleet)) ? safeParseJson(profile.fleet) : []).map(v => ({
    vehicle_slot_id: v.vehicle_slot_id,
    vehicle_type: v.vehicle_type,
    vehicle_category: v.vehicle_category || null,
    base_rate: parseFloat(v.base_rate) || 0,
    mile_rate: parseFloat(v.mile_rate) || 0,
    deposit_percent: parseFloat(v.deposit_percent) || 0,
    deposit_flat_cents: parseInt(v.deposit_flat_cents) || 0,
    calendar_id: v.calendar_id || null
  })),

  events: parsedEvents,
  peak_windows: parsedPeakWindows,
  fixed_rates: parsedFixedRates,
  addons: parsedAddons,

  service_lat: profile.service_lat,
  service_lng: profile.service_lng,
  service_radius: profile.service_radius
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
  const { location_id, pickup, dropoff, departureISO, pickupLat, pickupLng } = req.body;

  try {
    // A. Geofence Check: Ensure pickup is within the service radius
    const profileRes = await pool.query(
        "SELECT service_lat, service_lng, service_radius_miles FROM profiles WHERE location_id = $1", 
        [location_id]
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

    // B. Event Check: Override rates for specific dates
    let perMileCents = 450; 
    let baseCents = 8500; 

    const eventCheck = await pool.query(
      "SELECT base_rate_cents, mile_rate_cents FROM events WHERE location_id = $1 AND event_date = $2",
      [location_id, departureISO.split('T')[0]]
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


app.get("/api/get-profile-widget/:location_id", async (req, res) => {
  try {
    const { location_id } = req.params;
    const profileIdColumn = await getProfileIdColumn();

    // Fetch profile (the source of truth)
    const profileRes = await pool.query(
      `SELECT * FROM profiles WHERE ${profileIdColumn} = $1`,
      [location_id]
    );

    if (profileRes.rows.length === 0) {
      return res.status(404).json({ error: "Location Not Found" });
    }

    const p = profileRes.rows[0];
    let fixedRates = safeParseJson(p.fixed_rates);
    if (await tableExists("fixed_rates")) {
      const fixedRatesColumns = await getTableColumns("fixed_rates");
      const fixedRatesIdColumn = fixedRatesColumns.has("location_id")
        ? "location_id"
        : (fixedRatesColumns.has("user_id") ? "user_id" : null);
      if (fixedRatesIdColumn) {
      const fixedRatesRes = await pool.query(
        `SELECT * FROM fixed_rates WHERE ${fixedRatesIdColumn} = $1 AND COALESCE(is_active, true) = true`,
        [location_id]
      );
      fixedRates = fixedRatesRes.rows;
      }
    }

    // Map data to return to widget
    // We use the JSONB columns from the profiles table
      return res.json({
        plan_name: p.plan_name || "Starter",
        business_name: p.business_name || "",
        business_logo: p.business_logo || "",
        brand_color_primary: p.brand_color_primary || "#082f49",
        brand_color_secondary: p.brand_color_secondary || "#0f766e",
        brand_color_accent: p.brand_color_accent || "#ecfeff",
        widget_tagline: p.widget_tagline || "",
        maps_api_key: p.maps_api_key,
        maps_key: p.maps_api_key,
        tax_rate: p.tax_rate,
        fleet: safeParseJson(p.fleet),         // Using the JSONB fleet from profiles
        fixed_rates: fixedRates,
        peak_windows: safeParseJson(p.peak_windows),
        events: safeParseJson(p.events),
        addons: safeParseJson(p.addons)
      });

  } catch (err) {
    console.error("Database Error:", err);
    return res.status(500).send("Database Error");
  }
});

app.post("/api/create-booking", async (req, res) => {
  try {
    const bookingResult = await createBookingRecord(req.body, {
      paymentLink: req.body.payment_link || null,
      triggerWebhook: true,
    });
    return res.status(200).json(bookingResult);
  } catch (err) {
    console.error("❌ Error in create-booking:", err);
    return res.status(500).json({ success: false, error: err.message || "Failed to create booking" });
  }
});


app.get("/api/health", (req, res) => {
  res.json({
    status: "SaaS Master Engine Online",
    timestamp: new Date().toISOString()
  });
});

// --- DATABASE LISTENER (Runs 24/7) ---

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
          "SELECT id, location_id FROM bookings WHERE id = $1",
          [booking_id]
        );

        if (bookingRes.rows.length === 0) {
          console.log("⚠️ Booking not found. Skipping.", { booking_id });
          return;
        }

        const location_id = bookingRes.rows[0].location_id || "default";

        await triggerCrmWebhook(location_id, booking_id);
      } catch (err) {
        console.error("❌ Error handling notification:", err);
      }
    });

    listenerClient.on("error", (err) => {
      console.error("❌ Listener Error:", err);
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
  startListener();
});
