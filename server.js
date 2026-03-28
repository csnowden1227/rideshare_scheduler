/*****************************************************
 🚀 SERVER.JS - GO HIGH LEVEL SAAS BACKEND (CLEANED)
*****************************************************/
import * as dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import { Client as GoogleMapsClient } from "@googlemaps/google-maps-services-js";
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool, Client } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

/*****************************************************
 1️⃣ APP / DB CONFIG
*****************************************************/
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const googleMapsClient = new GoogleMapsClient({});
const CRM_WEBHOOK_URL =
  process.env.CRM_WEBHOOK_URL ||
  "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/a7699638-aca6-4480-a0ce-25df857c9b33";

const allowedOrigins = [
  'https://app.leadconnectorhq.com',
  'https://app.crmonesource.com',
  'https://services.leadconnectorhq.com',
  'https://rideshare-scheduler-axx6.onrender.com',
  'http://localhost:5173',
  'http://localhost:8080'
];

app.use(cors({
  origin(origin, callback) {
    if (!origin) return callback(null, true);
    if (!allowedOrigins.includes(origin)) {
      return callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'), false);
    }
    return callback(null, true);
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Replace your old app.use(express.json()) with these two lines:
app.use(express.json({ limit: '10mb' })); 
app.use(express.urlencoded({ limit: '10mb', extended: true }));

// Keep your static path as is
app.use(express.static(path.join(__dirname, "public")));

app.use((req, res, next) => {
  res.setHeader(
    "Content-Security-Policy",
    "frame-ancestors 'self' https://app.crmonesource.com https://*.gohighlevel.com https://*.msgsndr.com https://*.leadconnectorhq.com;"
  );
  next();
});

/*****************************************************
 2️⃣ HELPERS
*****************************************************/
function safeParse(data, fallback = []) {
    if (data == null) return fallback;
    if (typeof data === 'object') return data; // If Postgres already parsed it
    try {
        return typeof data === 'string' ? JSON.parse(data) : data;
    } catch (e) {
        console.error("JSON Parse Error:", e);
        return fallback;
    }
}

function isInsideGeofence(userLat, userLng, fenceLat, fenceLng, radiusMiles) {
    const R = 3958.8; // Earth's radius in miles
    const dLat = (fenceLat - userLat) * Math.PI / 180;
    const dLon = (fenceLng - userLng) * Math.PI / 180;
    
    const a = 
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(userLat * Math.PI / 180) * Math.cos(fenceLat * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const distance = R * c;
    
    return distance <= radiusMiles;
}

function toNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

async function tableExists(tableName) {
  const { rows } = await pool.query(
    `SELECT EXISTS (
      SELECT 1
      FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = $1
    ) AS exists`,
    [tableName]
  );
  return !!rows[0]?.exists;
}

async function getTableColumns(tableName) {
  const { rows } = await pool.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1`,
    [tableName]
  );
  return new Set(rows.map((r) => r.column_name));
}

async function getProfile(location_id) {
  const { rows } = await pool.query(
    `SELECT * FROM profiles WHERE location_id = $1 LIMIT 1`,
    [location_id]
  );
  return rows[0] || null;
}

function normalizeFleet(profile) {
  return safeParse(profile?.fleet, []).map((slot) => ({
    vehicle_slot_id: String(slot.vehicle_slot_id || '').trim(),
    vehicle_type: slot.vehicle_type || slot.name || '',
    name: slot.name || slot.vehicle_type || '',
    calendar_id: slot.calendar_id || '',
    base_rate: toNumber(slot.base_rate),
    mile_rate: toNumber(slot.mile_rate ?? slot.per_mile_rate),
    minimum_fare: toNumber(slot.minimum_fare),
    deposit_percent: toNumber(slot.deposit_percent, 20),
    duration_min: toNumber(slot.duration_min, 105),
    slot_interval_min: toNumber(slot.slot_interval_min, 30),
    min_notice_min: toNumber(slot.min_notice_min, 120)
  })).filter((slot) => slot.vehicle_slot_id);
}

function computeAddonTotal(addonsConfig, selectedAddons) {
  // Normalize selected addons into a Set of IDs/descriptions
  const selectedIds = new Set(
    (selectedAddons || [])
      .map((a) => {
        if (typeof a === 'string') return a.trim();
        if (typeof a === 'object' && a !== null) {
          return String(a.id || a.description || '').trim();
        }
        return '';
      })
      .filter(Boolean)
  );

  const breakdown = [];
  let total = 0;

  for (const addon of addonsConfig || []) {
    const addonId = String(addon.id || '').trim();
    const addonDesc = String(addon.description || '').trim();

    // Match either ID or description
    if (selectedIds.has(addonId) || selectedIds.has(addonDesc)) {
      const price = toNumber(addon.price);

      total += price;

      breakdown.push({
        id: addonId || addonDesc,
        description: addonDesc,
        price,
        type: addon.type || 'per_booking'
      });
    }
  }

  // ✅ This return is now safely inside the function
  return { total, breakdown };
}

function computeSpecialEventAdjustment(events, selectedEventName, startTime) {
  if (!selectedEventName) {
    return { multiplier: 1, event: null, base_rate: null, mile_rate: null };
  }

  const startDate = String(startTime || '').slice(0, 10);
  const event = (events || []).find(
    (e) =>
      String(e.event_name || '').trim() === String(selectedEventName).trim() &&
      (!e.event_date || e.event_date === startDate)
  );

  if (!event) {
    return { multiplier: 1, event: null, base_rate: null, mile_rate: null };
  }

  return {
    multiplier: toNumber(event.multiplier, 1),
    event,
    base_rate: event.base_rate != null ? toNumber(event.base_rate) : null,
    mile_rate: event.mile_rate != null ? toNumber(event.mile_rate) : null
  };
}

/* 🔐 Get Maps API Key from Database */
async function getMapsKey(location_id) {
  try {
    // We query the profiles table which stores the unique key for each sub-account
    const res = await pool.query(
      "SELECT maps_api_key FROM profiles WHERE location_id = $1 LIMIT 1",
      [location_id]
    );

    // If no profile exists or the key is an empty string/null
    if (!res.rows.length || !res.rows[0].maps_api_key) {
      // Fallback: If you have a master key in your .env, you can return that instead of throwing an error
      if (process.env.GOOGLE_MAPS_SERVER_KEY) {
        console.log(`ℹ️ Using Master Maps Key for location: ${location_id}`);
        return process.env.GOOGLE_MAPS_SERVER_KEY;
      }
      
      throw new Error("Maps API key not configured for this location.");
    }

    return res.rows[0].maps_api_key;
  } catch (err) {
    console.error("❌ Database Error in getMapsKey:", err.message);
    throw err;
  }
}

async function computeRoute({ location_id, origin, destination, departureISO }) {
  const key = await getMapsKey(location_id);

  if (!key || !origin || !destination) {
    return { minutes: 45, distanceMeters: 16093.4, source: 'fallback' };
  }

  const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'routes.duration,routes.distanceMeters'
    },
    body: JSON.stringify({
      origin: { address: origin },
      destination: { address: destination },
      travelMode: 'DRIVE',
      routingPreference: 'TRAFFIC_AWARE',
      departureTime: departureISO || new Date().toISOString()
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.routes?.length) {
    return { minutes: 45, distanceMeters: 16093.4, source: 'fallback' };
  }

  const route = data.routes[0];
  const iso = String(route.duration || 'PT45M');
  const hours = Number((iso.match(/(\d+)H/) || [])[1] || 0);
  const mins = Number((iso.match(/(\d+)M/) || [])[1] || 0);
  const secs = Number((iso.match(/(\d+)S/) || [])[1] || 0);

  return {
    minutes: hours * 60 + mins + Math.ceil(secs / 60),
    distanceMeters: Number(route.distanceMeters || 0),
    source: 'google'
  };
}

async function syncFleetSettings(location_id, fleet) {
  if (!(await tableExists('fleet_settings'))) return;

  const columns = await getTableColumns('fleet_settings');
  await pool.query(`DELETE FROM fleet_settings WHERE location_id = $1`, [location_id]);

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

    push('location_id', location_id);
    push('vehicle_slot_id', slot.vehicle_slot_id);
    push('vehicle_type', slot.vehicle_type || slot.name || null);
    push('name', slot.name || slot.vehicle_type || null);
    push('calendar_id', slot.calendar_id || null);
    push('base_rate', toNumber(slot.base_rate));
    push('mile_rate', toNumber(slot.mile_rate));
    push('per_mile_rate', toNumber(slot.mile_rate));
    push('minimum_fare', toNumber(slot.minimum_fare));
    push('deposit_percent', toNumber(slot.deposit_percent, 20));
    push('duration_min', toNumber(slot.duration_min, 105));
    push('slot_interval_min', toNumber(slot.slot_interval_min, 30));
    push('min_notice_min', toNumber(slot.min_notice_min, 120));
    push('is_active', true);

    if (!fields.length) continue;

    await pool.query(
      `INSERT INTO fleet_settings (${fields.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    );
  }
}



/*****************************************************
 3️⃣ CORE ROUTES
*****************************************************/
app.get('/api/health', (_req, res) => {
  res.json({
    status: 'SaaS Master Engine Online',
    timestamp: new Date().toISOString(),
    webhook_default: CRM_WEBHOOK_URL
  });
});

async function saveConfigHandler(req, res) {
  const body = req.body || {};
  const location_id = String(body.location_id || body.id || '').trim();
  if (!location_id) return res.status(400).json({ error: 'Missing location_id.' });

  const business_name = body.business_name || body.businessName || null;
  const logo_url = body.logo_url || null;
  const crm_webhook_url = body.crm_webhook_url || body.webhook_url || null;
  const maps_api_key = body.maps_api_key || body.mapsApiKey || null;
  const tax_rate = toNumber(body.tax_rate ?? body.taxRate, 0);
  const service_lat = body.service_lat ?? null;
  const service_lng = body.service_lng ?? null;
  const service_radius = toNumber(body.service_radius ?? body.service_radius_miles, 90);

  const fleet = (body.fleet || []).map((slot) => ({
    vehicle_slot_id: String(slot.vehicle_slot_id || '').trim(),
    vehicle_type: slot.vehicle_type || slot.name || '',
    name: slot.name || slot.vehicle_type || '',
    calendar_id: slot.calendar_id || '',
    base_rate: toNumber(slot.base_rate),
    mile_rate: toNumber(slot.mile_rate),
    minimum_fare: toNumber(slot.minimum_fare),
    deposit_percent: toNumber(slot.deposit_percent, 20),
    duration_min: toNumber(slot.duration_min, 105),
    slot_interval_min: toNumber(slot.slot_interval_min, 30),
    min_notice_min: toNumber(slot.min_notice_min, 120)
  })).filter((slot) => slot.vehicle_slot_id);

  const fixed_rates = (body.fixed_rates || []).map(r => ({
    location_name: r.location_name,
    lat: toNumber(r.lat),
    lng: toNumber(r.lng),
    radius: toNumber(r.radius),
    fixed_price: toNumber(r.fixed_price)
}));

  const events = (body.events || []).map((event) => ({
    event_name: event.event_name || '',
    event_date: event.event_date || null,
    base_rate: toNumber(event.base_rate),
    mile_rate: toNumber(event.mile_rate),
    multiplier: toNumber(event.multiplier, 1)
  }));


  const addons = (body.addons || []).map((addon) => ({
    id: addon.id || addon.description || '',
    description: addon.description || '',
    price: toNumber(addon.price),
    type: addon.type || 'per_booking'
  }));

  const peak_windows = body.peak_windows || [];

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    await client.query(
      `INSERT INTO profiles (
        location_id,
        business_name,
        logo_url,
        crm_webhook_url,
        maps_api_key,
        tax_rate,
        fleet,
        special_events,
        addons,
        peak_windows,
        service_lat,
        service_lng,
        service_radius
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13)
      ON CONFLICT (location_id) DO UPDATE SET
        business_name = EXCLUDED.business_name,
        logo_url = EXCLUDED.logo_url,
        crm_webhook_url = EXCLUDED.crm_webhook_url,
        maps_api_key = EXCLUDED.maps_api_key,
        tax_rate = EXCLUDED.tax_rate,
        fleet = EXCLUDED.fleet,
        special_events = EXCLUDED.special_events,
        addons = EXCLUDED.addons,
        peak_windows = EXCLUDED.peak_windows,
        service_lat = EXCLUDED.service_lat,
        service_lng = EXCLUDED.service_lng,
        service_radius = EXCLUDED.service_radius`,
      [
        location_id,
        business_name,
        logo_url,
        crm_webhook_url,
        maps_api_key,
        tax_rate,
        JSON.stringify(fleet),
        JSON.stringify(events),
        JSON.stringify(addons),
        JSON.stringify(peak_windows),
        service_lat,
        service_lng,
        service_radius
      ]
    );
// 1. CHECK IF TABLE EXISTS & CLEAR OLD DATA
if (await tableExists('fixed_rates')) {
    // Clear existing rates for this location once to avoid duplicates
    await client.query(`DELETE FROM fixed_rates WHERE location_id = $1`, [location_id]);

    // 2. SAVE NEW FIXED RATES
    if (fixed_rates && Array.isArray(fixed_rates) && fixed_rates.length > 0) {
        for (const route of fixed_rates) {
            await client.query(
                `INSERT INTO fixed_rates (location_id, location_name, lat, lng, radius, fixed_price)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                [
                    location_id, 
                    route.location_name || null, 
                    route.lat ?? null, 
                    route.lng ?? null, 
                    route.radius ?? null, 
                    parseFloat(route.fixed_price) || 0
                ]
            );
        }
        console.log(`✅ Synced ${fixed_rates.length} fixed rate zones for ${location_id}`);
    }
}


    await syncFleetSettings(location_id, fleet);

    await client.query('COMMIT');
    res.json({ success: true, message: 'All settings and slots saved!' });
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('save-config error:', error);
    res.status(500).json({ error: error.message || 'Failed to save settings.' });
  } finally {
    client.release();
  }
}

app.post('/api/save-config', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { 
            location_id, business_name, logo_url, crm_webhook_url, 
            maps_api_key, tax_rate, fleet, events, addons, 
            peak_windows, fixed_rates, service_lat, service_lng, service_radius 
        } = req.body;

        // 1. Update the Profiles Table (Handles all JSON logic)
        await client.query(
            `INSERT INTO profiles (
                location_id, business_name, logo_url, crm_webhook_url, 
                maps_api_key, tax_rate, fleet, special_events, addons, 
                peak_windows, service_lat, service_lng, service_radius
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
            ON CONFLICT (location_id) 
            DO UPDATE SET 
                business_name = EXCLUDED.business_name,
                logo_url = EXCLUDED.logo_url,
                crm_webhook_url = EXCLUDED.crm_webhook_url,
                maps_api_key = EXCLUDED.maps_api_key,
                tax_rate = EXCLUDED.tax_rate,
                fleet = EXCLUDED.fleet,
                special_events = EXCLUDED.special_events,
                addons = EXCLUDED.addons,
                peak_windows = EXCLUDED.peak_windows,
                service_lat = EXCLUDED.service_lat,
                service_lng = EXCLUDED.service_lng,
                service_radius = EXCLUDED.service_radius`,
            [
                location_id, business_name, logo_url, crm_webhook_url, 
                maps_api_key, tax_rate, 
                JSON.stringify(fleet || []), 
                JSON.stringify(events || []), 
                JSON.stringify(addons || []), 
                JSON.stringify(peak_windows || []),
                service_lat || 0, service_lng || 0, service_radius || 50
            ]
        );

        // 2. Sync Fixed Rates Table
        // We delete old ones and insert new ones to keep the list clean
        await client.query("DELETE FROM fixed_rates WHERE location_id = $1", [location_id]);
        
        if (fixed_rates && fixed_rates.length > 0) {
            for (const rate of fixed_rates) {
                await client.query(
                    `INSERT INTO fixed_rates (location_id, location_name, lat, lng, radius, fixed_price)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [location_id, rate.location_name, rate.lat, rate.lng, rate.radius, rate.fixed_price]
                );
            }
        }

        await client.query('COMMIT');
        console.log(`✅ Config saved for location: ${location_id}`);
        res.json({ success: true });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error("❌ DATABASE SAVE ERROR:", err.message);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});
// Map both potential frontend calls to the same handler
app.post('/api/save-config', saveConfigHandler);
app.post('/api/update-profile-full', saveConfigHandler);

app.get("/api/get-profile/:location_id", async (req, res) => {
  const { location_id } = req.params;
  let client;
  try {
    client = await pool.connect();

    const profileRes = await client.query(
      "SELECT * FROM profiles WHERE location_id = $1 LIMIT 1",
      [location_id]
    );
    const ratesRes = await client.query(
      "SELECT * FROM fixed_rates WHERE location_id = $1",
      [location_id]
    );

    if (!profileRes.rows.length) {
      return res.status(404).json({ error: "Profile not found" });
    }

    const profile = profileRes.rows[0];

    res.json({
      location_id: profile.location_id,
      business_name: profile.business_name || "",
      logo_url: profile.logo_url || "",
      plan_name: profile.plan_name || "Starter",
      maps_api_key: profile.maps_api_key || "",
      crm_webhook_url: profile.crm_webhook_url || "",
      tax_rate: profile.tax_rate || 0,
      fleet: safeParse(profile.fleet),
      events: safeParse(profile.special_events),
      addons: safeParse(profile.addons),
      peak_windows: safeParse(profile.peak_windows),
      fixed_rates: ratesRes.rows,
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

app.post("/api/calculate-quote", async (req, res) => {
  try {
    const { 
      location_id, 
      vehicle_slot_id, 
      pickup_lat, pickup_lng, 
      dropoff_lat, dropoff_lng,
      selected_addons 
    } = req.body;

    const profile = await getProfile(location_id);
    if (!profile) return res.status(404).json({ error: "Profile not found" });

    // 1. Fixed Rate Check (Geofencing)
    const fixedRates = (typeof profile.fixed_rates === 'string') ? JSON.parse(profile.fixed_rates) : (profile.fixed_rates || []);
    let baseRidePrice = null;

    for (const zone of fixedRates) {
      // Check if pickup or dropoff is in the radius (using your getDistanceMiles helper)
      const dPickup = getDistanceMiles(pickup_lat, pickup_lng, zone.lat, zone.lng);
      const dDropoff = getDistanceMiles(dropoff_lat, dropoff_lng, zone.lat, zone.lng);

      if (dPickup <= zone.radius || dDropoff <= zone.radius) {
        baseRidePrice = Number(zone.fixed_price);
        break;
      }
    }

    // 2. Fallback to Mileage if no Fixed Rate hit
    if (baseRidePrice === null) {
      // Assuming you have your Google Maps route logic here
      // const route = await computeRoute(...);
      // baseRidePrice = calculateMileagePrice(route, profile, vehicle_slot_id);
      baseRidePrice = 50.00; // Temporary placeholder to stop the crash
    }

    // 3. Addon Calculation
    const addonsConfig = (typeof profile.addons === 'string') ? JSON.parse(profile.addons) : (profile.addons || []);
    const addonCalc = computeAddonTotal(addonsConfig, selected_addons);

    // 4. Final Totals
    const subtotal = baseRidePrice + addonCalc.total;
    const taxRate = Number(profile.tax_rate || 0) / 100;
    const taxAmount = subtotal * taxRate;
    const finalTotal = subtotal + taxAmount;

    // ✅ This return is inside the function
    return res.json({
      quoted_price: Number(baseRidePrice.toFixed(2)),
      addon_total: Number(addonCalc.total.toFixed(2)),
      tax_amount: Number(taxAmount.toFixed(2)),
      total: Number(finalTotal.toFixed(2)),
      selected_addons: addonCalc.breakdown
    });

  } catch (err) {
    console.error("❌ calculate-quote error:", err);
    return res.status(500).json({ error: "Failed to calculate quote." });
  }
});

async function triggerCrmWebhook(location_id, booking_id) {
  let client;
  try {
    client = await pool.connect();

    // 1. Get the booking details
    const bookingRes = await client.query(
      "SELECT * FROM bookings WHERE id = $1",
      [booking_id]
    );

    if (!bookingRes.rows.length) {
      return console.log(`⚠️ Webhook aborted: Booking #${booking_id} not found.`);
    }

    const b = bookingRes.rows[0];

    // 2. Get the profile AND set the fallback URL
    const profileRes = await client.query(
      "SELECT crm_webhook_url, tax_rate, business_name FROM profiles WHERE location_id = $1",
      [location_id]
    );
    const p = profileRes.rows[0];

    // LOGIC: Use the user's saved URL, or the Master URL from your .env file
    const webhookToCall = p?.crm_webhook_url || process.env.MASTER_CRM_WEBHOOK;

    if (!webhookToCall) {
      return console.log(`⚠️ No CRM Webhook found and no Master Webhook configured for: ${location_id}`);
    }

    // --- (Your Financial Calculations remain exactly the same) ---
   // --- (Your Financial Calculations remain exactly the same) ---
    const total = Number(b.total_price || 0);
    const taxRate = Number(p?.tax_rate || 0);
    const taxAmount = total * (taxRate / 100);
    const totalWithTax = total + taxAmount;
    const depositPaid = Number(b.deposit_amount || 0);
    const balanceDue = totalWithTax - depositPaid;

    // 1. DEFINE THE FLAGS FIRST (Before the payload)
    const vehicleTypeStr = (b.selected_vehicle_type || "").toLowerCase().replace(/\s/g, '');
    
    const vehicleTypeFlags = {
      standardsuv: vehicleTypeStr === "standardsuv",
      standardsedan: vehicleTypeStr === "standardsedan",
      luxuryxlsuv: vehicleTypeStr === "luxuryxlsuv",
      standardxlsuv: vehicleTypeStr === "standardxlsuv",
      luxurysedan: vehicleTypeStr === "luxurysedan",
      luxurysuv: vehicleTypeStr === "luxurysuv"
    };

    // 2. NOW BUILD THE PAYLOAD
    const payload = {
      webhook_type: "BOOKING_SYNC",
      location_id: b.location_id,
      vehicle_slot_id: b.vehicle_slot_id,
      calendar_id: b.calendar_id || "",
      businessName: p?.business_name || "",
      
      // We spread the flags here so GHL sees individual "True/False" fields
      ...vehicleTypeFlags, 

      customer: {
        firstName: b.first_name,
        lastName: b.last_name,
        email: b.customer_email,
        phone: b.customer_phone
      },

      trip: {
        booking_id: b.id,
        status: b.status || 'pending',
        vehicleType: vehicleTypeStr, // Added this for easy branching
        pickup: b.pickup_address,
        dropoff: b.dropoff_address,
        // Using .toISOString() ensures GHL can read the date for the "Create Appointment" step
        startTime: b.start_time ? new Date(b.start_time).toISOString() : null,
        endTime: b.end_time ? new Date(b.end_time).toISOString() : null,
        selectedEventName: b.selected_event_name || null
      },
      luggage: {
        carryOnCount: Number(b.carry_on_count || 0),
        checkedBagCount: Number(b.checked_bag_count || 0),
        additionalItemsAboard: b.additional_items_aboard || ""
      },
      addons: typeof b.selected_addons === 'string' ? JSON.parse(b.selected_addons) : (b.selected_addons || []),
      financials: {
        subtotal: Number(total.toFixed(2)),
        taxRate,
        taxAmount: Number(taxAmount.toFixed(2)),
        totalWithTax: Number(totalWithTax.toFixed(2)),
        depositPaid: Number(depositPaid.toFixed(2)),
        balanceRemaining: Number(balanceDue.toFixed(2))
      }
    
    }; // closes payload

    // 3. Fire the Webhook (as we fixed in the previous step)
    const resp = await fetch(webhookToCall, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    // ... rest of your error handling and finally block

    if (resp.ok) {
      console.log(`✅ Webhook SUCCESS: Sent to CRM for Booking #${b.id}`);
    } else {
      console.error(`❌ Webhook ERROR: CRM returned ${resp.status}`);
    }

  } catch (err) {
    console.error("❌ Critical Webhook Trigger Error:", err.message);
  } finally {
    if (client) client.release();
  }
} // <--- THIS ONE SEALS THE ENTIRE triggerCrmWebhook FUNCTION


app.post('/api/create-booking', async (req, res) => {
  try {
    const {
      location_id, vehicle_slot_id, first_name, last_name, email, phone,
      pickup_address, dropoff_address, start_time, quoted_price,
      total_price, deposit_amount, deposit_percent, carry_on_count,
      checked_bag_count, additional_items_aboard, selected_event_name,
      selected_addons
    } = req.body;

    // ... continue with your validation logic

    if (!location_id || !vehicle_slot_id || !first_name || !last_name || !email || !phone || !pickup_address || !dropoff_address || !start_time) {
      return res.status(400).json({ error: "Missing required booking fields." });
    }

    const profile = await getProfile(location_id);
    if (!profile) return res.status(404).json({ error: "Profile not found." });

    const fleet = normalizeFleet(profile);
    const slot = fleet.find((s) => s.vehicle_slot_id === vehicle_slot_id);
    if (!slot) return res.status(400).json({ error: "Invalid vehicle slot." });

    const startDate = new Date(start_time);
    const endDate = new Date(startDate.getTime() + (Number(slot.duration_min || 105) * 60000));

    const dbResult = await pool.query(
      `INSERT INTO bookings (
        location_id, vehicle_slot_id, calendar_id, first_name, last_name,
        customer_email, customer_phone, pickup_address, dropoff_address,
        start_time, end_time, quoted_price, total_price, deposit_amount,
        deposit_percent, status, carry_on_count, checked_bag_count,
        additional_items_aboard, selected_event_name, selected_addons
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'pending',$16,$17,$18,$19,$20::jsonb
      )
      RETURNING id`,
      [
        location_id, vehicle_slot_id, slot.calendar_id || null,
        first_name, last_name, email, phone, pickup_address, dropoff_address,
        startDate.toISOString(), endDate.toISOString(), quoted_price,
        total_price, deposit_amount, deposit_percent, carry_on_count,
        checked_bag_count, additional_items_aboard, selected_event_name,
        JSON.stringify(selected_addons || [])
      ]
    );

    const booking_id = dbResult.rows[0].id;
    
    // This calls the function we just fixed!
    await triggerCrmWebhook(location_id, booking_id);

    res.status(200).json({
      success: true,
      booking_id,
      message: "Booking confirmed and synced."
    });
  } catch (err) {
    console.error("❌ Critical Error in create-booking:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

app.post('/api/sync-crm', async (req, res) => {
  try {
    const response = await fetch(CRM_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body)
    });

    const data = await response.json().catch(() => ({}));
    res.json({ success: true, crm_response: data });
  } catch (err) {
    res.status(500).json({ error: "Failed to forward to CRM" });
  }
});

app.post('/api/sync-fleet', async (req, res) => {
  const { location_id, token } = req.body;

  if (!location_id || !token) {
    return res.status(400).json({ success: false, error: "Missing Location ID or Access Token" });
  }

  try {
    const crmResponse = await fetch(`https://services.leadconnectorhq.com/locations/${location_id}/customFields`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Version': '2021-07-28',
        'Accept': 'application/json'
      }
    });

    const data = await crmResponse.json();
    const vehicles = data.customFields || [];

    const columns = (await tableExists('fleet_settings')) ? await getTableColumns('fleet_settings') : new Set();
    for (const v of vehicles) {
      const fields = [];
      const vals = [];
      const ph = [];
      const push = (f, value) => {
        if (!columns.has(f)) return;
        fields.push(f);
        vals.push(value);
        ph.push(`$${vals.length}`);
      };

      push('location_id', location_id);
      push('location_vehicle_id', v.id);
      push('name', v.name);
      push('vehicle_type', v.name);
      push('is_active', true);

      if (fields.length) {
        await pool.query(
          `INSERT INTO fleet_settings (${fields.join(', ')})
           VALUES (${ph.join(', ')})
           ON CONFLICT (location_vehicle_id)
           DO UPDATE SET name = EXCLUDED.name`,
          vals
        );
      }
    }

    console.log(`✅ Fleet synced for Location: ${location_id}`);
    res.json({ success: true, message: "Fleet synced successfully!" });
  } catch (error) {
    console.error("❌ Sync Error:", error);
    res.status(500).json({ success: false, error: "Failed to sync fleet from CRM" });
  }
});

app.get("/api/db-check", async (_req, res) => {
  try {
    const result = await pool.query("SELECT NOW()");
    res.json({
      status: "Connected",
      timestamp: result.rows[0].now
    });
  } catch (err) {
    console.error("DB Check Error:", err);
    res.status(500).json({
      status: "Error",
      error: err.message
    });
  }
});

app.get("/setup-wizard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "setup-wizard.html"));
});

app.get("/test-page", (_req, res) => {
  res.send("<h1>Server route works</h1>");
});
/*****************************************************
 4️⃣ DATABASE LISTENER
*****************************************************/
const startListener = async () => {
  const listenerClient = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    keepAlive: true
  });

  try {
    await listenerClient.connect();
    await listenerClient.query("LISTEN profile_updated;");
    await listenerClient.query("LISTEN booking_updated;");

    console.log("🟢 DB Listener: Online and waiting for signals...");

    listenerClient.on("notification", async (msg) => {
      try {
        console.log(`🔔 Signal Received on ${msg.channel}: ${msg.payload}`);

        const booking_id = Number(msg.payload);
        if (!booking_id || booking_id <= 0) return;

        // Fetch location_id so the webhook knows which CRM to hit
        const bookingRes = await pool.query(
          "SELECT location_id FROM bookings WHERE id = $1",
          [booking_id]
        );

        const location_id = bookingRes.rows[0]?.location_id || "default";
        await triggerCrmWebhook(location_id, booking_id);
        
      } catch (err) {
        console.error("❌ Error handling notification:", err);
      }
    });

    listenerClient.on("error", (err) => {
      console.error("❌ Listener Connection Error:", err);
      setTimeout(startListener, 5000);
    });

    // Heartbeat to prevent connection timeout
    const heartbeat = setInterval(async () => {
      try { 
        await listenerClient.query("SELECT 1;"); 
      } catch (e) { 
        clearInterval(heartbeat);
      }
    }, 30000);

  } catch (err) {
    console.error("❌ Failed to connect listener:", err);
    setTimeout(startListener, 5000);
  }
};




/*****************************************************
 5️⃣ START SERVER
*****************************************************/
const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  // Kick off the listener
  startListener();
});