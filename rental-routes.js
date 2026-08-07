import path from "path";
import { randomBytes } from "crypto";

const DEFAULT_RENTAL_TERMS = "A valid payment method is required. Rentals include a 30-minute grace period. Time beyond the grace period is billed by the minute at 1.25 times the booked hourly rate.";

let rentalSettingsTableReady = null;

function cleanText(value, maxLength = 500) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanNumber(value, fallback = 0, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function cleanBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (value === "true" || value === "1" || value === 1) return true;
  if (value === "false" || value === "0" || value === 0) return false;
  return fallback;
}

function cleanImage(value) {
  const image = cleanText(value, 8_000_000);
  if (!image) return "";
  if (/^data:image\/(png|jpe?g|webp);base64,/i.test(image)) return image;
  if (/^https:\/\//i.test(image)) return image;
  return "";
}

export function normalizeRentalVehicle(vehicle = {}, index = 0, locationId = "") {
  const idFallback = `${cleanText(locationId, 100) || "rental"}_rental_${String(index + 1).padStart(2, "0")}`;
  const vehicleSlotId = cleanText(vehicle.vehicle_slot_id || vehicle.id || idFallback, 160)
    .replace(/[^A-Za-z0-9_-]/g, "_");

  return {
    vehicle_slot_id: vehicleSlotId || idFallback,
    active: cleanBoolean(vehicle.active, true),
    featured: cleanBoolean(vehicle.featured, false),
    vehicle_type: cleanText(vehicle.vehicle_type || vehicle.category || "Luxury Rental", 100),
    vehicle_year: cleanText(vehicle.vehicle_year, 4),
    vehicle_make: cleanText(vehicle.vehicle_make, 80),
    vehicle_model: cleanText(vehicle.vehicle_model, 80),
    vehicle_color: cleanText(vehicle.vehicle_color, 50),
    license_plate: cleanText(vehicle.license_plate, 30),
    description: cleanText(vehicle.description, 600),
    image: cleanImage(vehicle.image || vehicle.vehicle_image),
    hourly_rate: cleanNumber(vehicle.hourly_rate, 0, { max: 100_000 }),
    minimum_hours: cleanNumber(vehicle.minimum_hours, 4, { min: 1, max: 720 }),
    deposit_percent: cleanNumber(vehicle.deposit_percent, 0, { max: 100 }),
    calendar_id: cleanText(vehicle.calendar_id, 160),
  };
}

export function normalizeRentalSettings(input = {}, locationId = "") {
  const vehicles = Array.isArray(input.vehicles) ? input.vehicles : [];
  return {
    location_id: cleanText(locationId || input.location_id, 160),
    enabled: cleanBoolean(input.enabled, false),
    headline: cleanText(input.headline || "Reserve a luxury rental", 120),
    intro_text: cleanText(input.intro_text || "Choose your vehicle and rental timeframe.", 600),
    minimum_age: Math.round(cleanNumber(input.minimum_age, 25, { min: 18, max: 100 })),
    grace_minutes: Math.round(cleanNumber(input.grace_minutes, 30, { min: 0, max: 240 })),
    overage_multiplier: cleanNumber(input.overage_multiplier, 1.25, { min: 1, max: 10 }),
    tax_rate: cleanNumber(input.tax_rate, 0, { max: 100 }),
    default_deposit_percent: cleanNumber(input.default_deposit_percent, 25, { max: 100 }),
    terms_text: cleanText(input.terms_text || DEFAULT_RENTAL_TERMS, 2000),
    vehicles: vehicles.slice(0, 40).map((vehicle, index) => normalizeRentalVehicle(vehicle, index, locationId)),
  };
}

export async function ensureRentalSettingsTable(pool) {
  if (!rentalSettingsTableReady) {
    rentalSettingsTableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS rental_widget_settings (
        location_id TEXT PRIMARY KEY,
        enabled BOOLEAN NOT NULL DEFAULT FALSE,
        headline TEXT NOT NULL DEFAULT 'Reserve a luxury rental',
        intro_text TEXT NOT NULL DEFAULT 'Choose your vehicle and rental timeframe.',
        minimum_age INTEGER NOT NULL DEFAULT 25,
        grace_minutes INTEGER NOT NULL DEFAULT 30,
        overage_multiplier NUMERIC NOT NULL DEFAULT 1.25,
        tax_rate NUMERIC NOT NULL DEFAULT 0,
        default_deposit_percent NUMERIC NOT NULL DEFAULT 25,
        terms_text TEXT NOT NULL,
        vehicles JSONB NOT NULL DEFAULT '[]'::jsonb,
        operator_access_token TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `).then(async () => {
      await pool.query(`ALTER TABLE rental_widget_settings ADD COLUMN IF NOT EXISTS operator_access_token TEXT`);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_widget_settings_operator_token ON rental_widget_settings(operator_access_token) WHERE operator_access_token IS NOT NULL`);
    }).catch((error) => {
      rentalSettingsTableReady = null;
      throw error;
    });
  }
  return rentalSettingsTableReady;
}

export async function setRentalLicense(pool, locationId, licenseType = "addon", subscriptionStatus = "active") {
  await ensureRentalSettingsTable(pool);
  const normalizedType = licenseType === "standalone" ? "standalone" : "addon";
  const normalizedStatus = ["active", "trialing"].includes(String(subscriptionStatus || "").trim().toLowerCase())
    ? String(subscriptionStatus).trim().toLowerCase()
    : "inactive";
  await pool.query(`ALTER TABLE rental_widget_settings ADD COLUMN IF NOT EXISTS license_type TEXT NOT NULL DEFAULT 'addon'`);
  await pool.query(`ALTER TABLE rental_widget_settings ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'active'`);
  await pool.query(
    `INSERT INTO rental_widget_settings (location_id, terms_text, license_type, subscription_status)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (location_id) DO UPDATE SET
       license_type = EXCLUDED.license_type,
       subscription_status = EXCLUDED.subscription_status,
       updated_at = NOW()`,
    [cleanText(locationId, 160), DEFAULT_RENTAL_TERMS, normalizedType, normalizedStatus]
  );
}

function parseVehicles(value) {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function getRentalSettings(pool, locationId, { includeInactive = false } = {}) {
  const normalizedLocationId = cleanText(locationId, 160);
  if (!normalizedLocationId) return null;
  await ensureRentalSettingsTable(pool);
  const result = await pool.query(
    `SELECT * FROM rental_widget_settings WHERE location_id = $1 LIMIT 1`,
    [normalizedLocationId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  const normalized = normalizeRentalSettings({ ...row, vehicles: parseVehicles(row.vehicles) }, normalizedLocationId);
  normalized.updated_at = row.updated_at || null;
  normalized.operator_access_token = cleanText(row.operator_access_token, 160);
  if (!includeInactive) normalized.vehicles = normalized.vehicles.filter((vehicle) => vehicle.active);
  return normalized;
}

export async function getRentalVehicle(pool, locationId, vehicleSlotId) {
  const settings = await getRentalSettings(pool, locationId, { includeInactive: true });
  if (!settings?.enabled) return null;
  const target = cleanText(vehicleSlotId, 160).toLowerCase();
  return settings.vehicles.find((vehicle) => vehicle.active && vehicle.vehicle_slot_id.toLowerCase() === target) || null;
}

async function getTenantBranding(pool, getProfileIdColumn, locationId) {
  const profileIdColumn = await getProfileIdColumn();
  const result = await pool.query(
    `SELECT business_name, business_logo, brand_color_primary, brand_color_secondary, brand_color_accent,
            public_app_url, plan_name, addon_rental_unlocked
     FROM profiles WHERE ${profileIdColumn} = $1 LIMIT 1`,
    [locationId]
  );
  return result.rows[0] || null;
}

function hasRentalEntitlement(profile) {
  return profile?.addon_rental_unlocked === true;
}

function sendRentalLocked(res) {
  return res.status(403).json({
    error: "Rental Management is a paid add-on for this SaaS account.",
    code: "rental_addon_required",
    addon_code: "rental_management_subscription",
  });
}

function publicRentalPayload(settings, branding = {}) {
  return {
    location_id: settings.location_id,
    enabled: settings.enabled,
    headline: settings.headline,
    intro_text: settings.intro_text,
    minimum_age: settings.minimum_age,
    grace_minutes: settings.grace_minutes,
    overage_multiplier: settings.overage_multiplier,
    tax_rate: settings.tax_rate,
    default_deposit_percent: settings.default_deposit_percent,
    terms_text: settings.terms_text,
    vehicles: settings.vehicles.filter((vehicle) => vehicle.active),
    branding: {
      business_name: cleanText(branding.business_name || "Luxury Rentals", 160),
      business_logo: cleanImage(branding.business_logo),
      primary: cleanText(branding.brand_color_primary || "#082f49", 20),
      secondary: cleanText(branding.brand_color_secondary || "#0f766e", 20),
      accent: cleanText(branding.brand_color_accent || "#ecfeff", 20),
      public_app_url: cleanText(branding.public_app_url, 500),
    },
  };
}

export function registerRentalRoutes(app, {
  pool,
  requireWizardToken,
  getProfileIdColumn,
  ensureProfileEntitlementColumns,
  publicDir,
}) {
  app.get(["/rental-setup-wizard", "/rental-setup-wizard.html"], requireWizardToken, (req, res) => {
    res.sendFile(path.join(publicDir, "rental-setup-wizard.html"));
  });

  app.get("/rental-book/:locationId", (req, res) => {
    const params = new URLSearchParams({ loc: cleanText(req.params.locationId, 160) });
    return res.redirect(`/rental-widget.html?${params.toString()}`);
  });

  app.get("/api/rental-settings/:locationId", requireWizardToken, async (req, res) => {
    try {
      await ensureProfileEntitlementColumns();
      const locationId = cleanText(req.params.locationId, 160);
      const branding = await getTenantBranding(pool, getProfileIdColumn, locationId);
      if (!branding) return res.status(404).json({ error: "SaaS location not found." });
      if (!hasRentalEntitlement(branding)) return sendRentalLocked(res);
      const settings = await getRentalSettings(pool, locationId, { includeInactive: true })
        || normalizeRentalSettings({}, locationId);
      if (!settings.operator_access_token) {
        settings.operator_access_token = randomBytes(32).toString("hex");
        await pool.query(
          `INSERT INTO rental_widget_settings (location_id, terms_text, operator_access_token)
           VALUES ($1, $2, $3)
           ON CONFLICT (location_id) DO UPDATE SET operator_access_token = COALESCE(rental_widget_settings.operator_access_token, EXCLUDED.operator_access_token)`,
          [locationId, DEFAULT_RENTAL_TERMS, settings.operator_access_token]
        );
      }
      return res.json({ success: true, settings, branding });
    } catch (error) {
      console.error("Rental settings load error:", error);
      return res.status(500).json({ error: error.message || "Unable to load rental settings." });
    }
  });

  app.put("/api/rental-settings/:locationId", requireWizardToken, async (req, res) => {
    try {
      await ensureProfileEntitlementColumns();
      const locationId = cleanText(req.params.locationId, 160);
      const branding = await getTenantBranding(pool, getProfileIdColumn, locationId);
      if (!branding) return res.status(404).json({ error: "SaaS location not found." });
      if (!hasRentalEntitlement(branding)) return sendRentalLocked(res);
      const settings = normalizeRentalSettings(req.body || {}, locationId);
      if (settings.enabled && !settings.vehicles.some((vehicle) => vehicle.active && vehicle.hourly_rate > 0)) {
        return res.status(400).json({ error: "Add at least one active rental vehicle with an hourly rate before going live." });
      }
      await ensureRentalSettingsTable(pool);
      const result = await pool.query(
        `INSERT INTO rental_widget_settings (
           location_id, enabled, headline, intro_text, minimum_age, grace_minutes,
           overage_multiplier, tax_rate, default_deposit_percent, terms_text, vehicles
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
         ON CONFLICT (location_id) DO UPDATE SET
           enabled = EXCLUDED.enabled,
           headline = EXCLUDED.headline,
           intro_text = EXCLUDED.intro_text,
           minimum_age = EXCLUDED.minimum_age,
           grace_minutes = EXCLUDED.grace_minutes,
           overage_multiplier = EXCLUDED.overage_multiplier,
           tax_rate = EXCLUDED.tax_rate,
           default_deposit_percent = EXCLUDED.default_deposit_percent,
           terms_text = EXCLUDED.terms_text,
           vehicles = EXCLUDED.vehicles,
           updated_at = NOW()
         RETURNING updated_at`,
        [
          locationId, settings.enabled, settings.headline, settings.intro_text,
          settings.minimum_age, settings.grace_minutes, settings.overage_multiplier,
          settings.tax_rate, settings.default_deposit_percent, settings.terms_text,
          JSON.stringify(settings.vehicles),
        ]
      );
      return res.json({ success: true, settings, updated_at: result.rows[0]?.updated_at || null });
    } catch (error) {
      console.error("Rental settings save error:", error);
      return res.status(500).json({ error: error.message || "Unable to save rental settings." });
    }
  });

  app.get("/api/rental-widget/:locationId", async (req, res) => {
    try {
      await ensureProfileEntitlementColumns();
      const locationId = cleanText(req.params.locationId, 160);
      const [settings, branding] = await Promise.all([
        getRentalSettings(pool, locationId),
        getTenantBranding(pool, getProfileIdColumn, locationId),
      ]);
      if (!settings || !settings.enabled) return res.status(404).json({ error: "Rental booking is not enabled for this business." });
      if (!branding) return res.status(404).json({ error: "SaaS location not found." });
      if (!hasRentalEntitlement(branding)) return sendRentalLocked(res);
      res.setHeader("Cache-Control", "no-store");
      return res.json(publicRentalPayload(settings, branding));
    } catch (error) {
      console.error("Rental widget load error:", error);
      return res.status(500).json({ error: error.message || "Unable to load rental vehicles." });
    }
  });

  app.post("/api/rental-widget/quote", async (req, res) => {
    try {
      await ensureProfileEntitlementColumns();
      const locationId = cleanText(req.body?.location_id, 160);
      const vehicle = await getRentalVehicle(pool, locationId, req.body?.vehicle_slot_id);
      const settings = await getRentalSettings(pool, locationId);
      const branding = await getTenantBranding(pool, getProfileIdColumn, locationId);
      if (!branding) return res.status(404).json({ error: "SaaS location not found." });
      if (!hasRentalEntitlement(branding)) return sendRentalLocked(res);
      if (!settings?.enabled || !vehicle) return res.status(400).json({ error: "Select an available rental vehicle." });
      const hours = cleanNumber(req.body?.hourly_hours, 0, { max: 720 });
      if (hours < vehicle.minimum_hours) {
        return res.status(400).json({ error: `This vehicle requires at least ${vehicle.minimum_hours} hours.` });
      }
      const start = new Date(req.body?.start_time);
      if (Number.isNaN(start.getTime()) || start.getTime() <= Date.now()) {
        return res.status(400).json({ error: "Choose a future pickup date and time." });
      }
      const quotedPrice = Number((vehicle.hourly_rate * hours).toFixed(2));
      const taxAmount = Number((quotedPrice * (settings.tax_rate / 100)).toFixed(2));
      const total = Number((quotedPrice + taxAmount).toFixed(2));
      const depositPercent = vehicle.deposit_percent || settings.default_deposit_percent;
      const depositAmount = Number((total * (depositPercent / 100)).toFixed(2));
      const hoursUntilRental = Math.max(0, (start.getTime() - Date.now()) / 36e5);
      const depositEligible = hoursUntilRental >= 72 && depositAmount > 0 && depositAmount < total;
      return res.json({
        success: true,
        booking_mode: "rental",
        vehicle_slot_id: vehicle.vehicle_slot_id,
        hourly_booking_name: [vehicle.vehicle_year, vehicle.vehicle_make, vehicle.vehicle_model].filter(Boolean).join(" ") || vehicle.vehicle_type,
        hourly_hours: hours,
        hourly_rate: vehicle.hourly_rate,
        quoted_price: quotedPrice,
        tax_rate: settings.tax_rate,
        tax_amount: taxAmount,
        total,
        deposit_percent: depositPercent,
        deposit_amount: depositAmount,
        deposit_eligible: depositEligible,
        amount_due_now: depositEligible ? depositAmount : total,
        balance_due: depositEligible ? Number((total - depositAmount).toFixed(2)) : 0,
        hours_until_ride: Number(hoursUntilRental.toFixed(2)),
        balance_due_deadline: new Date(start.getTime() - 48 * 36e5).toISOString(),
        pricing_label: `${vehicle.vehicle_type} at $${vehicle.hourly_rate.toFixed(2)}/hr for ${hours} hours`,
      });
    } catch (error) {
      console.error("Rental quote error:", error);
      return res.status(500).json({ error: error.message || "Unable to calculate rental quote." });
    }
  });
}
