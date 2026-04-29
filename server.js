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
import { randomBytes, randomUUID } from 'crypto';
import { Client as GoogleMapsClient } from "@googlemaps/google-maps-services-js";
import { google } from 'googleapis';
import path from 'path';
import { fileURLToPath } from 'url';
import * as turf from '@turf/turf';

const { Pool, Client } = pkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
function normalizeStripeSecretKey(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function normalizePaymentProvider(value) {
  const normalized = String(value || "stripe").trim().toLowerCase();
  if (normalized === "square") return "square";
  if (normalized === "crm_invoice_only" || normalized === "invoice" || normalized === "invoice_only") {
    return "crm_invoice_only";
  }
  return "stripe";
}

const envStripeSecretKey = normalizeStripeSecretKey(process.env.STRIPE_SECRET_KEY || "");
const stripe = envStripeSecretKey
  ? new Stripe(envStripeSecretKey, { apiVersion: "2025-02-24.acacia" })
  : null;
const CRM_ONESOURCE_API_KEY = String(process.env.CRMONESOURCE_API_KEY || "").trim();
const CRM_API_BASE_URL = process.env.CRM_API_BASE_URL || "https://services.leadconnectorhq.com";
const CRM_OAUTH_CLIENT_ID = String(process.env.CRM_OAUTH_CLIENT_ID || "").trim();
const CRM_OAUTH_CLIENT_SECRET = String(process.env.CRM_OAUTH_CLIENT_SECRET || "").trim();
const CRM_OAUTH_REDIRECT_URI = String(process.env.CRM_OAUTH_REDIRECT_URI || "").trim();
const CRM_OAUTH_SCOPES = String(
  process.env.CRM_OAUTH_SCOPES ||
  "contacts.readonly contacts.write calendars.readonly calendars.write"
).trim();

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

let bookingSyncColumnsReady = null;
let crmLocationTokenColumnsReady = null;
let profileCrmApiKeyColumnReady = null;
let profileEntitlementColumnsReady = null;
let saasAddonPurchasesTableReady = null;
let dispatchTablesReady = null;
let tripTrackingTablesReady = null;

const DEFAULT_BRAND_COLORS = {
  primary: "#082f49",
  secondary: "#0f766e",
  accent: "#ecfeff",
};

const PLAN_RULES = {
  starter: {
    includedFleet: 1,
    maxFleet: 6,
    brandingIncluded: false,
    funnelIncluded: false,
    logoIncluded: false,
  },
  premium: {
    includedFleet: 1,
    maxFleet: 6,
    brandingIncluded: true,
    funnelIncluded: false,
    logoIncluded: true,
  },
  pro: {
    includedFleet: 3,
    maxFleet: 6,
    brandingIncluded: true,
    funnelIncluded: true,
    logoIncluded: true,
  },
};

const SAAS_ADDON_CATALOG = {
  branding_unlock: {
    code: "branding_unlock",
    label: "Full Branding Unlock",
    mode: "payment",
    amount_cents: 4999,
  },
  extra_vehicle_subscription: {
    code: "extra_vehicle_subscription",
    label: "Additional Fleet Vehicle",
    mode: "subscription",
    amount_cents: 10999,
  },
  funnel_unlock: {
    code: "funnel_unlock",
    label: "Digital Marketing Funnel",
    mode: "payment",
    amount_cents: 49700,
  },
};

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

async function ensureBookingSyncColumns() {
  if (!bookingSyncColumnsReady) {
    bookingSyncColumnsReady = (async () => {
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crm_contact_id TEXT`);
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS crm_event_id TEXT`);
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS cancel_unpaid_balance_at TIMESTAMPTZ`);
    })().catch((err) => {
      bookingSyncColumnsReady = null;
      throw err;
    });
  }
  return bookingSyncColumnsReady;
}

async function ensureCrmLocationTokenTable() {
  if (!crmLocationTokenColumnsReady) {
    crmLocationTokenColumnsReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS crm_location_tokens (
          location_id TEXT PRIMARY KEY,
          access_token TEXT NOT NULL,
          refresh_token TEXT,
          expires_at TIMESTAMPTZ,
          token_type TEXT,
          scope TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })().catch((err) => {
      crmLocationTokenColumnsReady = null;
      throw err;
    });
  }
  return crmLocationTokenColumnsReady;
}

async function ensureProfileCrmApiKeyColumn() {
  if (!profileCrmApiKeyColumnReady) {
    profileCrmApiKeyColumnReady = (async () => {
      await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS crm_api_key TEXT`);
    })().catch((err) => {
      profileCrmApiKeyColumnReady = null;
      throw err;
    });
  }
  return profileCrmApiKeyColumnReady;
}

async function ensureProfileEntitlementColumns() {
  if (!profileEntitlementColumnsReady) {
    profileEntitlementColumnsReady = (async () => {
      await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS addon_branding_unlocked BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS addon_funnel_unlocked BOOLEAN NOT NULL DEFAULT FALSE`);
      await pool.query(`ALTER TABLE profiles ADD COLUMN IF NOT EXISTS addon_extra_vehicle_count INTEGER NOT NULL DEFAULT 0`);
    })().catch((err) => {
      profileEntitlementColumnsReady = null;
      throw err;
    });
  }
  return profileEntitlementColumnsReady;
}

async function ensureSaasAddonPurchasesTable() {
  if (!saasAddonPurchasesTableReady) {
    saasAddonPurchasesTableReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS saas_addon_purchases (
          id BIGSERIAL PRIMARY KEY,
          stripe_session_id TEXT UNIQUE NOT NULL,
          stripe_subscription_id TEXT,
          location_id TEXT NOT NULL,
          addon_code TEXT NOT NULL,
          quantity INTEGER NOT NULL DEFAULT 1,
          mode TEXT NOT NULL,
          amount_cents INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'paid',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })().catch((err) => {
      saasAddonPurchasesTableReady = null;
      throw err;
    });
  }
  return saasAddonPurchasesTableReady;
}

async function ensureDispatchTables() {
  if (!dispatchTablesReady) {
    dispatchTablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS partners (
          id TEXT PRIMARY KEY,
          owner_location_id TEXT NOT NULL,
          partner_location_id TEXT NOT NULL UNIQUE,
          business_name TEXT NOT NULL,
          contact_name TEXT,
          email TEXT,
          phone TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          crm_webhook_url TEXT,
          crm_api_key TEXT,
          maps_api_key TEXT,
          payment_provider TEXT,
          stripe_account_id TEXT,
          service_lat NUMERIC,
          service_lng NUMERIC,
          service_radius_miles NUMERIC,
          timezone TEXT,
          dispatch_pipeline_id TEXT,
          dispatch_stage_id TEXT,
          accepts_dispatch BOOLEAN NOT NULL DEFAULT TRUE,
          auto_accept BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_partners_owner_location_id ON partners(owner_location_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS partner_fleet (
          id TEXT PRIMARY KEY,
          partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
          vehicle_type TEXT NOT NULL,
          vehicle_category TEXT,
          calendar_id TEXT,
          base_rate NUMERIC DEFAULT 0,
          mile_rate NUMERIC DEFAULT 0,
          active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_fleet_partner_id ON partner_fleet(partner_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS partner_onboarding_invites (
          id TEXT PRIMARY KEY,
          owner_location_id TEXT NOT NULL,
          email TEXT NOT NULL,
          token TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'pending',
          expires_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_onboarding_invites_owner_location_id ON partner_onboarding_invites(owner_location_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS partner_split_agreements (
          id TEXT PRIMARY KEY,
          owner_location_id TEXT NOT NULL,
          partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
          split_model TEXT NOT NULL DEFAULT 'net_after_stripe_fee',
          source_operator_percent NUMERIC NOT NULL,
          accepting_partner_percent NUMERIC NOT NULL,
          fee_charged_to TEXT NOT NULL DEFAULT 'source_operator',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (owner_location_id, partner_id)
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_split_agreements_owner_location_id ON partner_split_agreements(owner_location_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS dispatch_requests (
          id TEXT PRIMARY KEY,
          booking_id BIGINT REFERENCES bookings(id) ON DELETE SET NULL,
          owner_location_id TEXT NOT NULL,
          requested_vehicle_type TEXT,
          pickup_address TEXT,
          dropoff_address TEXT,
          start_time TIMESTAMPTZ,
          end_time TIMESTAMPTZ,
          status TEXT NOT NULL DEFAULT 'open',
          broadcast_mode TEXT NOT NULL DEFAULT 'manual',
          notes TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_dispatch_requests_owner_location_id ON dispatch_requests(owner_location_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS dispatch_offers (
          id TEXT PRIMARY KEY,
          dispatch_request_id TEXT NOT NULL REFERENCES dispatch_requests(id) ON DELETE CASCADE,
          partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'sent',
          sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          responded_at TIMESTAMPTZ,
          expires_at TIMESTAMPTZ,
          quoted_price NUMERIC,
          partner_payout_amount NUMERIC,
          platform_fee_amount NUMERIC,
          notes TEXT
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_dispatch_offers_dispatch_request_id ON dispatch_offers(dispatch_request_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_dispatch_offers_partner_id ON dispatch_offers(partner_id)`);
      await pool.query(`ALTER TABLE dispatch_offers ADD COLUMN IF NOT EXISTS source_operator_percent NUMERIC`);
      await pool.query(`ALTER TABLE dispatch_offers ADD COLUMN IF NOT EXISTS accepting_partner_percent NUMERIC`);
      await pool.query(`ALTER TABLE dispatch_offers ADD COLUMN IF NOT EXISTS split_model TEXT DEFAULT 'net_after_stripe_fee'`);
      await pool.query(`ALTER TABLE dispatch_offers ADD COLUMN IF NOT EXISTS fee_charged_to TEXT DEFAULT 'source_operator'`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS dispatch_assignments (
          id TEXT PRIMARY KEY,
          dispatch_request_id TEXT NOT NULL REFERENCES dispatch_requests(id) ON DELETE CASCADE,
          partner_id TEXT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
          booking_id BIGINT REFERENCES bookings(id) ON DELETE SET NULL,
          partner_booking_id BIGINT,
          partner_crm_event_id TEXT,
          status TEXT NOT NULL DEFAULT 'assigned',
          assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at TIMESTAMPTZ,
          cancelled_at TIMESTAMPTZ
        )
      `);
      await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_dispatch_assignments_dispatch_request_id ON dispatch_assignments(dispatch_request_id)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS partner_payouts (
          id TEXT PRIMARY KEY,
          dispatch_assignment_id TEXT NOT NULL REFERENCES dispatch_assignments(id) ON DELETE CASCADE,
          booking_id BIGINT REFERENCES bookings(id) ON DELETE SET NULL,
          gross_amount NUMERIC DEFAULT 0,
          partner_payout_amount NUMERIC DEFAULT 0,
          platform_fee_amount NUMERIC DEFAULT 0,
          stripe_transfer_id TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_partner_payouts_dispatch_assignment_id ON partner_payouts(dispatch_assignment_id)`);

      await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS dispatch_pipeline_id TEXT`);
      await pool.query(`ALTER TABLE partners ADD COLUMN IF NOT EXISTS dispatch_stage_id TEXT`);

      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispatch_status TEXT`);
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS assigned_partner_id TEXT`);
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS partner_booking_id BIGINT`);
      await pool.query(`ALTER TABLE bookings ADD COLUMN IF NOT EXISTS dispatch_request_id TEXT`);
    })().catch((err) => {
      dispatchTablesReady = null;
      throw err;
    });
  }
  return dispatchTablesReady;
}

async function ensureTripTrackingTables() {
  if (!tripTrackingTablesReady) {
    tripTrackingTablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS trip_tracking_sessions (
          id TEXT PRIMARY KEY,
          booking_id BIGINT NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE CASCADE,
          location_id TEXT NOT NULL,
          driver_token TEXT NOT NULL UNIQUE,
          customer_token TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL DEFAULT 'driver_assigned',
          current_lat DOUBLE PRECISION,
          current_lng DOUBLE PRECISION,
          heading DOUBLE PRECISION,
          speed DOUBLE PRECISION,
          accuracy DOUBLE PRECISION,
          last_location_at TIMESTAMPTZ,
          started_at TIMESTAMPTZ,
          ended_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_trip_tracking_sessions_location_id ON trip_tracking_sessions(location_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_trip_tracking_sessions_status ON trip_tracking_sessions(status)`);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS trip_tracking_points (
          id TEXT PRIMARY KEY,
          tracking_session_id TEXT NOT NULL REFERENCES trip_tracking_sessions(id) ON DELETE CASCADE,
          lat DOUBLE PRECISION NOT NULL,
          lng DOUBLE PRECISION NOT NULL,
          heading DOUBLE PRECISION,
          speed DOUBLE PRECISION,
          accuracy DOUBLE PRECISION,
          recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_trip_tracking_points_session_id ON trip_tracking_points(tracking_session_id)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS idx_trip_tracking_points_recorded_at ON trip_tracking_points(recorded_at DESC)`);
    })().catch((err) => {
      tripTrackingTablesReady = null;
      throw err;
    });
  }
  return tripTrackingTablesReady;
}

const TRACKING_STATUS_VALUES = new Set([
  "driver_assigned",
  "en_route_to_pickup",
  "arrived_at_pickup",
  "passenger_on_board",
  "completed",
]);

function normalizeTrackingStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TRACKING_STATUS_VALUES.has(normalized) ? normalized : "driver_assigned";
}

function parseOptionalNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function createTrackingToken(prefix) {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

function buildTrackingUrls(req, driverToken, customerToken) {
  const baseUrl = getPublicAppUrl(req);
  return {
    driver_url: `${baseUrl}/driver-tracking.html?token=${encodeURIComponent(driverToken)}`,
    customer_url: `${baseUrl}/customer-tracking.html?token=${encodeURIComponent(customerToken)}`,
  };
}

async function getTrackingSessionByToken({ token, role = "customer" }) {
  const tokenColumn = role === "driver" ? "driver_token" : "customer_token";
  const profileIdColumn = await getProfileIdColumn();
  const result = await pool.query(
    `SELECT
      s.*,
      b.first_name,
      b.last_name,
      b.customer_email,
      b.customer_phone,
      b.pickup_address,
      b.dropoff_address,
      b.pickup_lat,
      b.pickup_lng,
      b.dropoff_lat,
      b.dropoff_lng,
      b.start_time,
      b.end_time,
      b.total_price,
      b.vehicle_slot_id,
      b.status AS booking_status,
      p.business_name,
      p.maps_api_key
     FROM trip_tracking_sessions s
     INNER JOIN bookings b ON b.id = s.booking_id
     LEFT JOIN profiles p ON p.${profileIdColumn} = s.location_id
     WHERE s.${tokenColumn} = $1
     LIMIT 1`,
    [token]
  );
  return result.rows[0] || null;
}

function buildTrackingResponsePayload(session, { includeDriverToken = false } = {}) {
  const payload = {
    tracking_session_id: session.id,
    booking_id: session.booking_id,
    location_id: session.location_id,
    status: session.status,
    driver: {
      lat: session.current_lat,
      lng: session.current_lng,
      heading: session.heading,
      speed: session.speed,
      accuracy: session.accuracy,
      last_location_at: session.last_location_at,
    },
    booking: {
      customer_name: [session.first_name, session.last_name].filter(Boolean).join(" ").trim(),
      customer_email: session.customer_email || "",
      customer_phone: session.customer_phone || "",
      pickup_address: session.pickup_address || "",
      dropoff_address: session.dropoff_address || "",
      pickup_lat: session.pickup_lat,
      pickup_lng: session.pickup_lng,
      dropoff_lat: session.dropoff_lat,
      dropoff_lng: session.dropoff_lng,
      start_time: session.start_time,
      end_time: session.end_time,
      total_price: session.total_price,
      vehicle_slot_id: session.vehicle_slot_id || "",
      booking_status: session.booking_status || "",
    },
    business_name: session.business_name || "Chauffeur Deluxe",
    maps_api_key: session.maps_api_key || "",
    customer_tracking_token: session.customer_token,
  };

  if (includeDriverToken) {
    payload.driver_tracking_token = session.driver_token;
  }

  return payload;
}

function buildTrackingSessionClientShape(session) {
  const customerName = [session.first_name, session.last_name].filter(Boolean).join(" ").trim();
  return {
    id: session.id,
    tracking_session_id: session.id,
    booking_id: session.booking_id,
    location_id: session.location_id,
    status: session.status,
    current_lat: session.current_lat,
    current_lng: session.current_lng,
    heading: session.heading,
    speed: session.speed,
    accuracy: session.accuracy,
    last_location_at: session.last_location_at,
    started_at: session.started_at,
    ended_at: session.ended_at,
    customer_name: customerName,
    customer_email: session.customer_email || "",
    customer_phone: session.customer_phone || "",
    pickup_address: session.pickup_address || "",
    dropoff_address: session.dropoff_address || "",
    pickup_lat: session.pickup_lat,
    pickup_lng: session.pickup_lng,
    dropoff_lat: session.dropoff_lat,
    dropoff_lng: session.dropoff_lng,
    start_time: session.start_time,
    end_time: session.end_time,
    total_price: session.total_price,
    vehicle_slot_id: session.vehicle_slot_id || "",
    booking_status: session.booking_status || "",
    business_name: session.business_name || "Chauffeur Deluxe",
    maps_api_key: session.maps_api_key || "",
    customer_tracking_token: session.customer_token,
    driver_tracking_token: session.driver_token,
  };
}

async function ghlDispatchRequest({ method = "GET", path, apiKey, body }) {
  const response = await fetch(`${CRM_API_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Version: "2021-07-28",
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || data?.error || `CRM request failed with status ${response.status}`);
  }
  return data;
}

function buildDispatchCrmNote(dispatchData) {
  return [
    "Network Dispatch Ride Accepted",
    "",
    `Dispatch Request ID: ${dispatchData.dispatch_request_id || ""}`,
    `Dispatch Assignment ID: ${dispatchData.dispatch_assignment_id || ""}`,
    `Source Operator: ${dispatchData.source_operator?.business_name || ""}`,
    "",
    `Customer: ${dispatchData.customer?.full_name || ""}`,
    `Phone: ${dispatchData.customer?.phone || ""}`,
    `Email: ${dispatchData.customer?.email || ""}`,
    "",
    `Pickup Time: ${dispatchData.booking?.pickup_datetime || ""}`,
    `Dropoff Time: ${dispatchData.booking?.end_datetime || ""}`,
    `Pickup: ${dispatchData.booking?.pickup_address || ""}`,
    `Dropoff: ${dispatchData.booking?.dropoff_address || ""}`,
    `Vehicle: ${dispatchData.booking?.vehicle_type_requested || ""}`,
    `Passengers: ${dispatchData.booking?.passenger_count || ""}`,
    "",
    `Partner Payout: ${dispatchData.financials?.partner_payout_amount ?? ""}`,
    `Retail Price: ${dispatchData.financials?.quoted_retail_price ?? ""}`,
    `Payment Status: ${dispatchData.financials?.payment_status || ""}`,
    "",
    "Notes:",
    dispatchData.booking?.special_instructions || ""
  ].join("\n");
}

async function pushDispatchIntoPartnerCrmSafe(partner, dispatchData) {
  if (!partner?.crm_api_key) {
    throw new Error("Partner CRM API key is missing.");
  }
  if (!partner?.partner_location_id) {
    throw new Error("Partner location ID is missing.");
  }

  const contactResponse = await ghlDispatchRequest({
    method: "POST",
    path: "/contacts/upsert",
    apiKey: partner.crm_api_key,
    body: {
      locationId: partner.partner_location_id,
      firstName: dispatchData.customer.first_name,
      lastName: dispatchData.customer.last_name,
      name: dispatchData.customer.full_name,
      email: dispatchData.customer.email,
      phone: dispatchData.customer.phone,
    },
  });

  const contactId =
    contactResponse?.contact?.id ||
    contactResponse?.id ||
    contactResponse?.contactId ||
    null;

  if (!contactId) {
    throw new Error("Partner CRM contact ID was not returned.");
  }

  await ghlDispatchRequest({
    method: "POST",
    path: `/contacts/${contactId}/tags`,
    apiKey: partner.crm_api_key,
    body: {
      tags: [
        "Network Dispatch",
        "Partner Ride",
      ],
    },
  });

  await ghlDispatchRequest({
    method: "POST",
    path: `/contacts/${contactId}/notes`,
    apiKey: partner.crm_api_key,
    body: {
      body: buildDispatchCrmNote(dispatchData),
    },
  });

  return {
    success: true,
    contactId,
    opportunityId: null,
  };
}

function normalizePlanName(value = "") {
  const normalized = String(value || "starter").trim().toLowerCase();
  if (normalized === "premium") return "premium";
  if (normalized === "pro") return "pro";
  return "starter";
}

function getPlanRuleSet(planName = "starter") {
  return PLAN_RULES[normalizePlanName(planName)] || PLAN_RULES.starter;
}

function buildPlanEntitlements({
  planName = "starter",
  addonBrandingUnlocked = false,
  addonFunnelUnlocked = false,
  addonExtraVehicleCount = 0,
} = {}) {
  const normalizedPlan = normalizePlanName(planName);
  const rules = getPlanRuleSet(normalizedPlan);
  const extraVehicles = Math.max(0, Number(addonExtraVehicleCount || 0));
  const allowedFleetCount = Math.min(
    rules.maxFleet,
    rules.includedFleet + extraVehicles
  );

  return {
    plan_name: normalizedPlan,
    included_fleet_count: rules.includedFleet,
    max_fleet_count: rules.maxFleet,
    purchased_extra_vehicle_count: extraVehicles,
    allowed_fleet_count: allowedFleetCount,
    branding_enabled: Boolean(rules.brandingIncluded || addonBrandingUnlocked),
    funnel_enabled: Boolean(rules.funnelIncluded || addonFunnelUnlocked),
    logo_enabled: Boolean(rules.logoIncluded || addonBrandingUnlocked),
    can_purchase_branding: !rules.brandingIncluded,
    can_purchase_funnel: !rules.funnelIncluded,
    can_purchase_extra_vehicle: rules.maxFleet > rules.includedFleet && allowedFleetCount < rules.maxFleet,
  };
}

function sanitizeBrandingByEntitlements({
  businessLogo,
  brandColorPrimary,
  brandColorSecondary,
  brandColorAccent,
  widgetTagline,
  entitlements,
}) {
  const brandingEnabled = Boolean(entitlements?.branding_enabled);
  const logoEnabled = Boolean(entitlements?.logo_enabled);

  return {
    business_logo: logoEnabled ? (businessLogo || "") : "",
    brand_color_primary: brandingEnabled ? (brandColorPrimary || DEFAULT_BRAND_COLORS.primary) : DEFAULT_BRAND_COLORS.primary,
    brand_color_secondary: brandingEnabled ? (brandColorSecondary || DEFAULT_BRAND_COLORS.secondary) : DEFAULT_BRAND_COLORS.secondary,
    brand_color_accent: brandingEnabled ? (brandColorAccent || DEFAULT_BRAND_COLORS.accent) : DEFAULT_BRAND_COLORS.accent,
    widget_tagline: brandingEnabled ? (widgetTagline || "") : "",
  };
}

function sanitizeFleetByEntitlements(fleet = [], entitlements = {}) {
  const allowed = Math.max(1, Number(entitlements?.allowed_fleet_count || 1));
  return (Array.isArray(fleet) ? fleet : []).slice(0, allowed);
}

function clampPartnerFleetRows(fleet = []) {
  return (Array.isArray(fleet) ? fleet : []).slice(0, 6);
}

function normalizeAcceptingPartnerPercent(value, fallback = 80) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(99, Math.max(1, parsed));
}

function buildPartnerSplitAgreementPayload(acceptingPartnerPercentInput) {
  const acceptingPartnerPercent = normalizeAcceptingPartnerPercent(acceptingPartnerPercentInput);
  const sourceOperatorPercent = Math.round((100 - acceptingPartnerPercent) * 100) / 100;

  return {
    split_model: "net_after_stripe_fee",
    fee_charged_to: "source_operator",
    source_operator_percent: sourceOperatorPercent,
    accepting_partner_percent: acceptingPartnerPercent,
  };
}

async function getPartnerSplitAgreement(ownerLocationId, partnerId) {
  if (!ownerLocationId || !partnerId) return null;
  await ensureDispatchTables();

  const result = await pool.query(
    `SELECT
      owner_location_id,
      partner_id,
      split_model,
      source_operator_percent,
      accepting_partner_percent,
      fee_charged_to,
      created_at,
      updated_at
     FROM partner_split_agreements
     WHERE owner_location_id = $1
       AND partner_id = $2
     LIMIT 1`,
    [String(ownerLocationId), String(partnerId)]
  );

  return result.rows[0] || null;
}

async function getStoredCrmToken(locationId) {
  if (!locationId) return null;
  await ensureCrmLocationTokenTable();
  const result = await pool.query(
    `SELECT location_id, access_token, refresh_token, expires_at, token_type, scope
     FROM crm_location_tokens
     WHERE location_id = $1
     LIMIT 1`,
    [String(locationId)]
  );
  return result.rows[0] || null;
}

async function getProfileCrmApiKey(locationId) {
  if (!locationId) return null;
  await ensureProfileCrmApiKeyColumn();
  const profileIdColumn = await getProfileIdColumn();
  const result = await pool.query(
    `SELECT crm_api_key FROM profiles WHERE ${profileIdColumn} = $1 LIMIT 1`,
    [String(locationId)]
  );
  return String(result.rows[0]?.crm_api_key || "").trim() || null;
}

async function saveCrmToken(locationId, tokenData = {}) {
  if (!locationId || !tokenData.access_token) {
    throw new Error("locationId and access_token are required to save CRM token.");
  }

  await ensureCrmLocationTokenTable();
  const expiresAt = tokenData.expires_at
    ? new Date(tokenData.expires_at)
    : (tokenData.expires_in
        ? new Date(Date.now() + (Number(tokenData.expires_in) * 1000))
        : null);

  await pool.query(
    `INSERT INTO crm_location_tokens (
       location_id, access_token, refresh_token, expires_at, token_type, scope, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, NOW())
     ON CONFLICT (location_id) DO UPDATE SET
       access_token = EXCLUDED.access_token,
       refresh_token = COALESCE(EXCLUDED.refresh_token, crm_location_tokens.refresh_token),
       expires_at = EXCLUDED.expires_at,
       token_type = EXCLUDED.token_type,
       scope = EXCLUDED.scope,
       updated_at = NOW()`,
    [
      String(locationId),
      String(tokenData.access_token),
      tokenData.refresh_token ? String(tokenData.refresh_token) : null,
      expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null,
      tokenData.token_type ? String(tokenData.token_type) : null,
      tokenData.scope ? String(tokenData.scope) : null,
    ]
  );
}

async function refreshCrmAccessToken(refreshToken) {
  if (!CRM_OAUTH_CLIENT_ID || !CRM_OAUTH_CLIENT_SECRET || !CRM_OAUTH_REDIRECT_URI) {
    throw new Error("CRM OAuth environment variables are not configured.");
  }
  if (!refreshToken) {
    throw new Error("CRM refresh token is required.");
  }

  const body = new URLSearchParams({
    client_id: CRM_OAUTH_CLIENT_ID,
    client_secret: CRM_OAUTH_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: String(refreshToken),
    redirect_uri: CRM_OAUTH_REDIRECT_URI,
  });

  const response = await fetch(new URL("/oauth/token", CRM_API_BASE_URL), {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(`CRM OAuth refresh failed (${response.status}): ${text.slice(0, 300)}`);
  }

  return data;
}

async function getCrmAccessTokenForLocation(locationId) {
  const profileToken = await getProfileCrmApiKey(locationId);
  if (profileToken) {
    return profileToken;
  }

  const storedToken = await getStoredCrmToken(locationId);
  if (storedToken?.access_token) {
    const expiresAt = storedToken.expires_at ? new Date(storedToken.expires_at) : null;
    const hasExpired = expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= (Date.now() + 60_000);

    if (!hasExpired) {
      return storedToken.access_token;
    }

    if (storedToken.refresh_token) {
      const refreshed = await refreshCrmAccessToken(storedToken.refresh_token);
      await saveCrmToken(locationId, {
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token || storedToken.refresh_token,
        expires_in: refreshed.expires_in,
        expires_at: refreshed.expires_at,
        token_type: refreshed.token_type,
        scope: refreshed.scope,
      });
      return refreshed.access_token;
    }
  }

  return CRM_ONESOURCE_API_KEY || null;
}

async function getProfileIdColumn() {
  const columns = await getTableColumns("profiles");
  if (columns.has("location_id")) return "location_id";
  if (columns.has("id")) return "id";
  throw new Error("Profiles table is missing both location_id and id columns.");
}

async function getStripeSecretKeyForLocation(locationId) {
  const paymentProfile = await getPaymentProfileForLocation(locationId);
  return paymentProfile.stripeSecretKey || envStripeSecretKey;
}

function normalizeCalendarEvent(rawEvent = {}) {
  const start =
    rawEvent.startTime ||
    rawEvent.start_time ||
    rawEvent.start?.dateTime ||
    rawEvent.start?.time ||
    rawEvent.startDateTime ||
    null;
  const end =
    rawEvent.endTime ||
    rawEvent.end_time ||
    rawEvent.end?.dateTime ||
    rawEvent.end?.time ||
    rawEvent.endDateTime ||
    null;

  return {
    id: rawEvent.id || rawEvent._id || null,
    title: rawEvent.title || rawEvent.name || rawEvent.summary || "Existing booking",
    start,
    end,
  };
}

function looksLikeCalendarEvent(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Boolean(
    value.startTime ||
    value.start_time ||
    value.start?.dateTime ||
    value.start?.time ||
    value.startDateTime
  ) && Boolean(
    value.endTime ||
    value.end_time ||
    value.end?.dateTime ||
    value.end?.time ||
    value.endDateTime
  );
}

function extractCalendarEvents(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];

  const directCandidates = [
    payload.events,
    payload.calendarEvents,
    payload.appointments,
    payload.bookings,
    payload.data?.events,
    payload.data?.calendarEvents,
    payload.data?.appointments,
    payload.data?.bookings,
    payload.data,
  ];

  for (const candidate of directCandidates) {
    if (Array.isArray(candidate)) return candidate;
  }

  for (const value of Object.values(payload)) {
    if (Array.isArray(value) && value.some(looksLikeCalendarEvent)) {
      return value;
    }
    if (value && typeof value === "object") {
      for (const nested of Object.values(value)) {
        if (Array.isArray(nested) && nested.some(looksLikeCalendarEvent)) {
          return nested;
        }
      }
    }
  }

  return [];
}

async function getCrmCalendarEvents({
  locationId,
  calendarId,
  startTime,
  endTime,
}) {
  if (!locationId || !calendarId || !startTime || !endTime) {
    return [];
  }

  const crmAccessToken = await getCrmAccessTokenForLocation(locationId);
  if (!crmAccessToken) return [];

  const url = new URL("/calendars/events", CRM_API_BASE_URL);
  url.searchParams.set("locationId", String(locationId));
  url.searchParams.set("calendarId", String(calendarId));
  url.searchParams.set("startTime", String(startTime));
  url.searchParams.set("endTime", String(endTime));

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${crmAccessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`CRM calendar lookup failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  const rawEvents = extractCalendarEvents(data);

  return rawEvents.map(normalizeCalendarEvent);
}

function findCalendarConflict(events = [], requestedStartTime, requestedEndTime) {
  const requestedStart = new Date(requestedStartTime);
  const requestedEnd = new Date(requestedEndTime);
  if (Number.isNaN(requestedStart.getTime()) || Number.isNaN(requestedEnd.getTime())) return null;

  return events.find((event) => {
    const eventStart = new Date(event.start);
    const eventEnd = new Date(event.end);
    if (Number.isNaN(eventStart.getTime()) || Number.isNaN(eventEnd.getTime())) return false;
    return requestedStart < eventEnd && requestedEnd > eventStart;
  }) || null;
}

function endOfUtcDay(isoValue) {
  const value = new Date(isoValue);
  if (Number.isNaN(value.getTime())) return null;
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
    23, 59, 59, 999
  )).toISOString();
}

function extractCrmContactId(payload = {}) {
  return (
    payload?.contact?.id ||
    payload?.contact?.contactId ||
    payload?.contactId ||
    payload?.id ||
    payload?._id ||
    payload?.data?.contact?.id ||
    payload?.data?.id ||
    null
  );
}

function extractCrmAppointmentId(payload = {}) {
  return (
    payload?.event?.id ||
    payload?.eventId ||
    payload?.appointment?.id ||
    payload?.appointmentId ||
    payload?.id ||
    payload?._id ||
    payload?.data?.event?.id ||
    payload?.data?.id ||
    null
  );
}

async function upsertCrmContact({
  locationId,
  firstName,
  lastName,
  email,
  phone,
}) {
  if (!locationId) return null;
  if (!email && !phone && !firstName && !lastName) return null;

  const crmAccessToken = await getCrmAccessTokenForLocation(locationId);
  if (!crmAccessToken) return null;

  const response = await fetch(new URL("/contacts/upsert", CRM_API_BASE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${crmAccessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locationId: String(locationId),
      firstName: firstName || "",
      lastName: lastName || "",
      name: [firstName, lastName].filter(Boolean).join(" ").trim() || undefined,
      email: email || undefined,
      phone: phone || undefined,
      source: "rideshare-scheduler",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`CRM contact upsert failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return extractCrmContactId(data);
}

async function createCrmAppointment({
  locationId,
  calendarId,
  contactId,
  startTime,
  endTime,
  title,
  notes,
  timeZone = "UTC",
}) {
  if (!locationId || !calendarId || !contactId || !startTime) {
    return null;
  }

  const crmAccessToken = await getCrmAccessTokenForLocation(locationId);
  if (!crmAccessToken) return null;

  const response = await fetch(new URL("/calendars/events/appointments", CRM_API_BASE_URL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${crmAccessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      locationId: String(locationId),
      calendarId: String(calendarId),
      contactId: String(contactId),
      startTime,
      endTime,
      title,
      notes,
      timeZone,
      appointmentStatus: "confirmed",
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`CRM appointment creation failed (${response.status}): ${body.slice(0, 200)}`);
  }

  const data = await response.json();
  return extractCrmAppointmentId(data);
}

async function deleteCrmEvent(locationId, eventId) {
  if (!locationId || !eventId) return false;

  const crmAccessToken = await getCrmAccessTokenForLocation(locationId);
  if (!crmAccessToken) return false;

  const response = await fetch(new URL(`/calendars/events/${encodeURIComponent(String(eventId))}`, CRM_API_BASE_URL), {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${crmAccessToken}`,
      Version: "2021-07-28",
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`CRM event delete failed (${response.status}): ${body.slice(0, 200)}`);
  }

  return true;
}

async function syncConfirmedBookingCalendarEvent(bookingId) {
  if (!bookingId) return null;

  await ensureBookingSyncColumns();
  const profileIdColumn = await getProfileIdColumn();

  const result = await pool.query(
    `SELECT
      b.id,
      b.location_id,
      b.status,
      b.first_name,
      b.last_name,
      b.customer_email,
      b.customer_phone,
      b.pickup_address,
      b.dropoff_address,
      b.start_time,
      b.end_time,
      b.vehicle_slot_id,
      b.calendar_id,
      b.crm_contact_id,
      b.crm_event_id,
      b.balance_due,
      p.business_name
     FROM bookings b
     LEFT JOIN profiles p ON p.${profileIdColumn} = b.location_id
     WHERE b.id = $1
     LIMIT 1`,
    [bookingId]
  );

  const booking = result.rows[0];
  if (!booking) return null;
  if (String(booking.status || "").toLowerCase() !== "confirmed") return null;
  if (!booking.calendar_id || !booking.start_time || !booking.end_time) return null;
  if (booking.crm_event_id) return booking.crm_event_id;

  const contactId = booking.crm_contact_id || await upsertCrmContact({
    locationId: booking.location_id,
    firstName: booking.first_name,
    lastName: booking.last_name,
    email: booking.customer_email,
    phone: booking.customer_phone,
  });

  if (!contactId) {
    throw new Error("Unable to resolve CRM contact for calendar event creation.");
  }

  const title = `${booking.business_name || "Rideshare Chauffeur"} Reservation #${booking.id}`;
  const notes = [
    `Booking ID: ${booking.id}`,
    booking.vehicle_slot_id ? `Vehicle Slot: ${booking.vehicle_slot_id}` : null,
    booking.pickup_address ? `Pickup: ${booking.pickup_address}` : null,
    booking.dropoff_address ? `Dropoff: ${booking.dropoff_address}` : null,
    Number(booking.balance_due || 0) > 0 ? `Remaining balance due: $${Number(booking.balance_due || 0).toFixed(2)}` : `Paid in full`,
  ].filter(Boolean).join("\n");

  const eventId = await createCrmAppointment({
    locationId: booking.location_id,
    calendarId: booking.calendar_id,
    contactId,
    startTime: booking.start_time,
    endTime: booking.end_time,
    title,
    notes,
  });

  const cancelUnpaidBalanceAt = Number(booking.balance_due || 0) > 0 ? endOfUtcDay(booking.start_time ? new Date(new Date(booking.start_time).getTime() - (48 * 60 * 60 * 1000)).toISOString() : null) : null;

  await pool.query(
    `UPDATE bookings
     SET crm_contact_id = $1,
         crm_event_id = $2,
         cancel_unpaid_balance_at = $3
     WHERE id = $4`,
    [contactId, eventId, cancelUnpaidBalanceAt, booking.id]
  );

  console.log("CRM calendar event created:", {
    booking_id: booking.id,
    calendar_id: booking.calendar_id,
    crm_contact_id: contactId,
    crm_event_id: eventId,
  });

  return eventId;
}

function matchesPeakWindow(windowConfig = {}, startDate) {
  if (!(startDate instanceof Date) || Number.isNaN(startDate.getTime())) return false;
  const dayName = startDate.toLocaleDateString("en-US", { weekday: "long" }).toLowerCase();
  const day = String(windowConfig.day || "Everyday").toLowerCase();
  const isWeekday = startDate.getDay() >= 1 && startDate.getDay() <= 5;
  const isWeekend = startDate.getDay() === 0 || startDate.getDay() === 6;

  const dayMatch =
    day === "everyday" ||
    (day === "weekdays" && isWeekday) ||
    (day === "weekends" && isWeekend) ||
    day === dayName;

  if (!dayMatch) return false;

  const timeValue = startDate.toTimeString().slice(0, 5);
  const start = windowConfig.start_time || "00:00";
  const end = windowConfig.end_time || "23:59";
  if (start <= end) return timeValue >= start && timeValue <= end;
  return timeValue >= start || timeValue <= end;
}

function getAdditionalTrafficBufferMinutes({
  peakWindows = [],
  bookingMode = "standard",
  startTime,
  vehicleType = "",
}) {
  const startDate = new Date(startTime);
  if (Number.isNaN(startDate.getTime())) return 0;

  const selectedVehicleType = String(vehicleType || "").trim().toLowerCase();
  let extraBuffer = 0;

  for (const windowConfig of Array.isArray(peakWindows) ? peakWindows : []) {
    if (!matchesPeakWindow(windowConfig, startDate)) continue;
    const hasFixedSurcharge = Number(windowConfig.fixed_surcharge ?? windowConfig.flat_surcharge ?? 0) > 0;
    const appliesToFixed = hasFixedSurcharge;
    const appliesToStandard = !hasFixedSurcharge;
    const targetMode = appliesToFixed ? "fixed" : "standard";
    if (bookingMode !== targetMode) continue;

    const windowVehicleType = String(windowConfig.vehicle_type || "").trim().toLowerCase();
    if (bookingMode === "fixed" && windowVehicleType && windowVehicleType !== selectedVehicleType) continue;

    extraBuffer = Math.max(extraBuffer, parseInt(windowConfig.buffer_min, 10) || 0);
  }

  return extraBuffer;
}

async function getPaymentProfileForLocation(locationId) {
  const fallback = {
    provider: "stripe",
    stripeSecretKey: envStripeSecretKey,
    squareApplicationId: "",
    squareAccessToken: "",
    squareLocationId: "",
  };

  if (!locationId) return fallback;

  try {
    const profileIdColumn = await getProfileIdColumn();
    const result = await pool.query(
      `SELECT payment_provider, stripe_secret_key, square_application_id, square_access_token, square_location_id
       FROM profiles
       WHERE ${profileIdColumn} = $1
       LIMIT 1`,
      [locationId]
    );
    const row = result.rows[0] || {};
    return {
      provider: normalizePaymentProvider(row.payment_provider),
      stripeSecretKey: normalizeStripeSecretKey(row.stripe_secret_key || "") || envStripeSecretKey,
      squareApplicationId: String(row.square_application_id || "").trim(),
      squareAccessToken: String(row.square_access_token || "").trim(),
      squareLocationId: String(row.square_location_id || "").trim(),
    };
  } catch {
    return fallback;
  }
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
    push("vehicle_type", route.vehicle_type || null);
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
app.get("/rideshare-onboarding.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "rideshare-onboarding.html"));
});
app.get("/partner-onboarding.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "partner-onboarding.html"));
});
app.get("/dispatch-network-manager.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dispatch-network-manager.html"));
});
app.get("/network-dispatch.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "network-dispatch.html"));
});
app.get("/saas-sales.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "saas-sales.html"));
});
app.get("/addons.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "addons.html"));
});
app.get("/driver-tracking.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "driver-tracking.html"));
});
app.get("/customer-tracking.html", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "customer-tracking.html"));
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
      crm_api_key,
      payment_provider,
      stripe_secret_key,
      square_application_id,
      square_access_token,
      square_location_id,
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
    const normalizedWebhookUrl = String(crm_webhook_url || "").trim();

    await client.query("BEGIN");
    await ensureProfileCrmApiKeyColumn();
    await ensureProfileEntitlementColumns();
    const profileColumns = await getTableColumns("profiles");
    const profileIdColumn = profileColumns.has("location_id") ? "location_id" : "id";
    const existingProfileRes = await client.query(
      `SELECT * FROM profiles WHERE ${profileIdColumn} = $1 LIMIT 1`,
      [location_id]
    );
    const existingProfile = existingProfileRes.rows[0] || {};
    const normalizedPlanName = normalizePlanName(plan_name || existingProfile.plan_name || "starter");
    const entitlements = buildPlanEntitlements({
      planName: normalizedPlanName,
      addonBrandingUnlocked: existingProfile.addon_branding_unlocked,
      addonFunnelUnlocked: existingProfile.addon_funnel_unlocked,
      addonExtraVehicleCount: existingProfile.addon_extra_vehicle_count,
    });
    const sanitizedBranding = sanitizeBrandingByEntitlements({
      businessLogo: business_logo,
      brandColorPrimary: brand_color_primary,
      brandColorSecondary: brand_color_secondary,
      brandColorAccent: brand_color_accent,
      widgetTagline: widget_tagline,
      entitlements,
    });
    const sanitizedFleet = sanitizeFleetByEntitlements(fleet, entitlements);

    const fieldEntries = [];
    const pushProfileField = (column, value, cast = "") => {
      if (!profileColumns.has(column)) return;
      fieldEntries.push({ column, value, cast });
    };

    pushProfileField(profileIdColumn, location_id);
    pushProfileField("business_name", business_name);
    pushProfileField("business_logo", sanitizedBranding.business_logo || null);
    pushProfileField("brand_color_primary", sanitizedBranding.brand_color_primary || DEFAULT_BRAND_COLORS.primary);
    pushProfileField("brand_color_secondary", sanitizedBranding.brand_color_secondary || DEFAULT_BRAND_COLORS.secondary);
    pushProfileField("brand_color_accent", sanitizedBranding.brand_color_accent || DEFAULT_BRAND_COLORS.accent);
    pushProfileField("widget_tagline", sanitizedBranding.widget_tagline || null);
    pushProfileField("plan_name", normalizedPlanName);
    pushProfileField("crm_webhook_url", crm_webhook_url);
    pushProfileField("maps_api_key", maps_api_key);
    pushProfileField("crm_api_key", crm_api_key || null);
    pushProfileField("payment_provider", normalizePaymentProvider(payment_provider));
    pushProfileField("stripe_secret_key", stripe_secret_key || null);
    pushProfileField("square_application_id", square_application_id || null);
    pushProfileField("square_access_token", square_access_token || null);
    pushProfileField("square_location_id", square_location_id || null);
    pushProfileField("tax_rate", tax_rate);
    pushProfileField("service_lat", service_lat);
    pushProfileField("service_lng", service_lng);
    pushProfileField("service_radius", service_radius);
    pushProfileField("service_radius_miles", service_radius);
    pushProfileField("fleet", JSON.stringify(sanitizedFleet), "::jsonb");
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

    await syncFleetSettings(client, location_id, sanitizedFleet);

    await syncFixedRates(client, location_id, fixed_rates);

    await client.query("COMMIT");

    let webhookSync = {
      attempted: false,
      success: false,
      status: null,
      error: null
    };

    if (normalizedWebhookUrl && normalizedWebhookUrl.startsWith("http")) {
      webhookSync = await sendWizardSyncWebhook({
        webhookUrl: normalizedWebhookUrl,
        locationId: location_id,
        businessName: business_name,
        planName: normalizedPlanName,
        mapsApiKeyPresent: Boolean(String(maps_api_key || "").trim()),
        paymentProvider: payment_provider,
        hasStripeKey: Boolean(String(stripe_secret_key || "").trim()),
        hasSquareAccessToken: Boolean(String(square_access_token || "").trim()),
        hasSquareLocationId: Boolean(String(square_location_id || "").trim()),
        taxRate: parseFloat(tax_rate) || 0,
        serviceLat: service_lat,
        serviceLng: service_lng,
        serviceRadius: service_radius,
        fleet: sanitizedFleet,
        fixedRates: fixed_rates,
        peakWindows: peak_windows,
        events,
        addons
      });
    }

    return res.json({
      success: true,
      entitlements,
      webhook_sync: webhookSync,
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

function buildWizardSyncPayload({
  locationId,
  businessName,
  planName,
  mapsApiKeyPresent,
  paymentProvider,
  hasStripeKey,
  hasSquareAccessToken,
  hasSquareLocationId,
  taxRate,
  serviceLat,
  serviceLng,
  serviceRadius,
  fleet = [],
  fixedRates = [],
  peakWindows = [],
  events = [],
  addons = []
}) {
  return {
    webhook_type: "webhook_setup_sync",
    location_id: String(locationId || ""),
    business_name: businessName || "",
    source: "setup_wizard_sync",
    created_at: new Date().toISOString(),
    setup_sync: true,
    setup: {
      status: "synced",
      plan_name: planName || "Starter",
      maps_api_key_present: Boolean(mapsApiKeyPresent),
      payment_provider: normalizePaymentProvider(paymentProvider),
      stripe_secret_key_present: Boolean(hasStripeKey),
      square_access_token_present: Boolean(hasSquareAccessToken),
      square_location_id_present: Boolean(hasSquareLocationId),
      tax_rate: Number(taxRate || 0),
      service_area: {
        lat: serviceLat != null ? Number(serviceLat) : null,
        lng: serviceLng != null ? Number(serviceLng) : null,
        radius: serviceRadius != null ? Number(serviceRadius) : null
      },
      counts: {
        fleet_slots: Array.isArray(fleet) ? fleet.length : 0,
        fixed_rate_zones: Array.isArray(fixedRates) ? fixedRates.length : 0,
        peak_windows: Array.isArray(peakWindows) ? peakWindows.length : 0,
        events: Array.isArray(events) ? events.length : 0,
        addons: Array.isArray(addons) ? addons.length : 0
      },
      fleet: Array.isArray(fleet) ? fleet.map((row = {}) => ({
        vehicle_slot_id: row.vehicle_slot_id || "",
        vehicle_type: row.vehicle_type || "",
        calendar_id: row.calendar_id || "",
        base_rate: Number(row.base_rate || 0),
        mile_rate: Number(row.mile_rate || 0),
        outbound_buffer_min: Number(row.outbound_buffer_min || 0)
      })) : []
    }
  };
}

async function sendWizardSyncWebhook({
  webhookUrl,
  locationId,
  businessName,
  planName,
  mapsApiKeyPresent,
  paymentProvider,
  hasStripeKey,
  hasSquareAccessToken,
  hasSquareLocationId,
  taxRate,
  serviceLat,
  serviceLng,
  serviceRadius,
  fleet,
  fixedRates,
  peakWindows,
  events,
  addons
}) {
  const result = {
    attempted: false,
    success: false,
    status: null,
    error: null
  };

  const normalizedWebhookUrl = String(webhookUrl || "").trim();
  if (!normalizedWebhookUrl || !normalizedWebhookUrl.startsWith("http")) {
    result.error = "No valid webhook URL configured.";
    return result;
  }

  try {
    result.attempted = true;
    const payload = buildWizardSyncPayload({
      locationId,
      businessName,
      planName,
      mapsApiKeyPresent,
      paymentProvider,
      hasStripeKey,
      hasSquareAccessToken,
      hasSquareLocationId,
      taxRate,
      serviceLat,
      serviceLng,
      serviceRadius,
      fleet,
      fixedRates,
      peakWindows,
      events,
      addons
    });

    const response = await fetch(normalizedWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    result.status = response.status;
    result.success = response.ok;
    if (!response.ok) {
      result.error = (await response.text()).slice(0, 300);
    }

    console.log("Wizard sync webhook result:", {
      location_id: locationId,
      status: response.status,
      success: response.ok
    });
  } catch (err) {
    result.error = err?.message || "Wizard sync webhook failed.";
    console.error("Wizard sync webhook error:", err);
  }

  return result;
}

// This handles the "Save" button from your Wizard
app.post("/api/save-config", requireWizardToken, saveConfigHandler);
app.post('/api/update-profile-full', requireWizardToken, saveConfigHandler);

app.get("/api/crm/token-status/:location_id", requireWizardToken, async (req, res) => {
  try {
    const tokenRow = await getStoredCrmToken(req.params.location_id);
    const expiresAt = tokenRow?.expires_at ? new Date(tokenRow.expires_at) : null;
    const isExpired = Boolean(expiresAt && !Number.isNaN(expiresAt.getTime()) && expiresAt.getTime() <= Date.now());
    return res.json({
      connected: Boolean(tokenRow?.access_token),
      location_id: req.params.location_id,
      expires_at: expiresAt && !Number.isNaN(expiresAt.getTime()) ? expiresAt.toISOString() : null,
      is_expired: isExpired,
      has_refresh_token: Boolean(tokenRow?.refresh_token),
      scope: tokenRow?.scope || null,
      fallback_env_token: Boolean(CRM_ONESOURCE_API_KEY),
    });
  } catch (err) {
    console.error("CRM token status error:", err);
    return res.status(500).json({ connected: false, error: err.message });
  }
});

app.get("/api/crm/oauth/start", requireWizardToken, async (req, res) => {
  if (!CRM_OAUTH_CLIENT_ID || !CRM_OAUTH_REDIRECT_URI) {
    return res.status(500).json({ error: "CRM OAuth is not configured on the backend." });
  }

  const locationId = String(req.query.location_id || "").trim();
  if (!locationId) {
    return res.status(400).json({ error: "location_id is required." });
  }

  const state = Buffer.from(JSON.stringify({
    location_id: locationId,
    token: getWizardToken(req) || null,
    return_to: req.query.return_to || null,
  }), "utf8").toString("base64url");

  const authUrl = new URL("/oauth/authorize", CRM_API_BASE_URL);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", CRM_OAUTH_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", CRM_OAUTH_REDIRECT_URI);
  authUrl.searchParams.set("scope", CRM_OAUTH_SCOPES);
  authUrl.searchParams.set("state", state);

  return res.json({
    location_id: locationId,
    authorize_url: authUrl.toString(),
  });
});

app.get("/api/crm/oauth/callback", async (req, res) => {
  try {
    if (!CRM_OAUTH_CLIENT_ID || !CRM_OAUTH_CLIENT_SECRET || !CRM_OAUTH_REDIRECT_URI) {
      return res.status(500).send("CRM OAuth is not configured on the backend.");
    }

    const code = String(req.query.code || "").trim();
    const rawState = String(req.query.state || "").trim();
    if (!code || !rawState) {
      return res.status(400).send("Missing OAuth code or state.");
    }

    let state;
    try {
      state = JSON.parse(Buffer.from(rawState, "base64url").toString("utf8"));
    } catch {
      return res.status(400).send("Invalid OAuth state.");
    }

    const locationId = String(state.location_id || "").trim();
    if (!locationId) {
      return res.status(400).send("OAuth state is missing location_id.");
    }

    const body = new URLSearchParams({
      client_id: CRM_OAUTH_CLIENT_ID,
      client_secret: CRM_OAUTH_CLIENT_SECRET,
      grant_type: "authorization_code",
      code,
      redirect_uri: CRM_OAUTH_REDIRECT_URI,
    });

    const tokenResponse = await fetch(new URL("/oauth/token", CRM_API_BASE_URL), {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });

    const tokenText = await tokenResponse.text();
    let tokenData;
    try {
      tokenData = tokenText ? JSON.parse(tokenText) : {};
    } catch {
      tokenData = null;
    }

    if (!tokenResponse.ok || !tokenData?.access_token) {
      return res.status(500).send(`CRM OAuth token exchange failed: ${tokenText.slice(0, 300)}`);
    }

    await saveCrmToken(locationId, tokenData);

    const returnTo = state.return_to
      ? String(state.return_to)
      : `/setup-wizard.html?location_id=${encodeURIComponent(locationId)}${state.token ? `&token=${encodeURIComponent(state.token)}` : ""}`;

    return res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 24px;">
          <h2>CRM Connected</h2>
          <p>The CRM token for location <strong>${locationId}</strong> has been saved.</p>
          <p><a href="${returnTo}">Return to setup wizard</a></p>
        </body>
      </html>
    `);
  } catch (err) {
    console.error("CRM OAuth callback error:", err);
    return res.status(500).send(err.message);
  }
});

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

function getPublicAppUrl(req = null) {
  const configured = String(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || "").trim();
  if (configured) return configured.replace(/\/+$/, "");
  if (req) {
    return `${req.protocol}://${req.get("host")}`.replace(/\/+$/, "");
  }
  return "https://rideshare-scheduler-axx6.onrender.com";
}

const BOOKING_DISPLAY_TIMEZONE = String(process.env.BOOKING_DISPLAY_TIMEZONE || "America/Los_Angeles").trim() || "America/Los_Angeles";

function formatDisplayDateTime(isoValue, timeZone = BOOKING_DISPLAY_TIMEZONE) {
  const value = new Date(isoValue);
  if (Number.isNaN(value.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone,
  }).formatToParts(value).reduce((acc, part) => {
    if (part.type !== "literal") acc[part.type] = part.value;
    return acc;
  }, {});

  return `${parts.weekday || ""} ${parts.month || "01"}-${parts.day || "01"}-${parts.year || "1970"} ${parts.hour || "12"}:${parts.minute || "00"}${String(parts.dayPeriod || "").toLowerCase()}`;
}

function formatUtcCalendarStamp(isoValue) {
  const value = new Date(isoValue);
  if (Number.isNaN(value.getTime())) return null;
  const pad = (num) => String(num).padStart(2, "0");
  return `${value.getUTCFullYear()}${pad(value.getUTCMonth() + 1)}${pad(value.getUTCDate())}T${pad(value.getUTCHours())}${pad(value.getUTCMinutes())}${pad(value.getUTCSeconds())}Z`;
}

function escapeIcsText(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

function buildCalendarLinks({ bookingId, title, description, location, startTime, endTime }) {
  if (!bookingId || !startTime || !endTime) {
    return { ics: null, google: null, yahoo: null, outlook: null };
  }

  const baseUrl = getPublicAppUrl();
  const ics = `${baseUrl}/api/bookings/${encodeURIComponent(String(bookingId))}/calendar.ics`;
  const startUtc = formatUtcCalendarStamp(startTime);
  const endUtc = formatUtcCalendarStamp(endTime);
  const encodedTitle = encodeURIComponent(title || "Reservation");
  const encodedDescription = encodeURIComponent(description || "");
  const encodedLocation = encodeURIComponent(location || "");

  return {
    ics,
    google: startUtc && endUtc
      ? `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodedTitle}&dates=${startUtc}/${endUtc}&details=${encodedDescription}&location=${encodedLocation}`
      : null,
    yahoo: startUtc && endUtc
      ? `https://calendar.yahoo.com/?v=60&view=d&type=20&title=${encodedTitle}&st=${startUtc}&et=${endUtc}&desc=${encodedDescription}&in_loc=${encodedLocation}`
      : null,
    outlook: `https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent&subject=${encodedTitle}&startdt=${encodeURIComponent(new Date(startTime).toISOString())}&enddt=${encodeURIComponent(new Date(endTime).toISOString())}&body=${encodedDescription}&location=${encodedLocation}`,
  };
}

async function stripeFormRequest(pathname, params = {}, method = "POST", apiKey = envStripeSecretKey) {
  const normalizedKey = normalizeStripeSecretKey(apiKey);
  if (!normalizedKey) {
    throw new Error("Stripe is not configured on the backend.");
  }

  const body = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value == null) return;
    body.append(key, String(value));
  });

  const response = await fetch(`https://api.stripe.com${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${normalizedKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: method === "GET" ? undefined : body.toString(),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(json?.error?.message || `Stripe request failed with ${response.status}.`);
    err.type = json?.error?.type || null;
    err.code = json?.error?.code || null;
    err.statusCode = response.status;
    err.raw = json?.error || json;
    throw err;
  }

  return json;
}

async function createStripeCheckoutSessionForAmount({
  apiKey = envStripeSecretKey,
  amount,
  customerEmail = null,
  bookingId,
  locationId = null,
  totalPrice,
  depositAmount,
  depositPercent,
  paymentStatus,
  title,
  description,
  successUrl,
  cancelUrl,
  paymentChoice = null,
  balanceDueDeadline = null,
}) {
  return stripeFormRequest("/v1/checkout/sessions", {
    mode: "payment",
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    "metadata[booking_id]": String(bookingId),
    "metadata[location_id]": String(locationId || ""),
    "metadata[total_price]": String(Number(totalPrice || 0).toFixed(2)),
    "metadata[deposit_amount]": String(Number(depositAmount || 0).toFixed(2)),
    "metadata[deposit_percent]": String(depositPercent == null ? "" : depositPercent),
    "metadata[payment_status]": paymentStatus,
    "metadata[payment_choice]": paymentChoice || "",
    "metadata[balance_due_deadline]": balanceDueDeadline || "",
    "line_items[0][quantity]": 1,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][unit_amount]": Math.round(Number(amount || 0) * 100),
    "line_items[0][price_data][product_data][name]": title,
    "line_items[0][price_data][product_data][description]": description,
  }, "POST", apiKey);
}

async function createStripeAddonCheckoutSession({
  apiKey = envStripeSecretKey,
  locationId,
  customerEmail = null,
  addonCode,
  quantity = 1,
  successUrl,
  cancelUrl,
}) {
  const addon = SAAS_ADDON_CATALOG[addonCode];
  if (!addon) {
    throw new Error("Unknown add-on selected.");
  }

  const normalizedQuantity = Math.max(1, Number(quantity || 1));
  const params = {
    mode: addon.mode,
    success_url: successUrl,
    cancel_url: cancelUrl,
    customer_email: customerEmail || undefined,
    "metadata[location_id]": String(locationId || ""),
    "metadata[addon_code]": addon.code,
    "metadata[quantity]": String(normalizedQuantity),
    "line_items[0][quantity]": normalizedQuantity,
    "line_items[0][price_data][currency]": "usd",
    "line_items[0][price_data][product_data][name]": addon.label,
    "line_items[0][price_data][product_data][description]": addon.label,
  };

  if (addon.mode === "subscription") {
    params["line_items[0][price_data][recurring][interval]"] = "month";
    params["line_items[0][price_data][unit_amount]"] = addon.amount_cents;
  } else {
    params["line_items[0][price_data][unit_amount]"] = addon.amount_cents;
  }

  return stripeFormRequest("/v1/checkout/sessions", params, "POST", apiKey);
}

async function applyAddonPurchaseFromSession(session = {}) {
  await ensureProfileEntitlementColumns();
  await ensureSaasAddonPurchasesTable();

  const locationId = String(session.metadata?.location_id || "").trim();
  const addonCode = String(session.metadata?.addon_code || "").trim();
  const quantity = Math.max(1, Number(session.metadata?.quantity || 1));
  const addon = SAAS_ADDON_CATALOG[addonCode];

  if (!locationId || !addon) {
    throw new Error("Session metadata is missing add-on details.");
  }

  const existing = await pool.query(
    `SELECT id FROM saas_addon_purchases WHERE stripe_session_id = $1 LIMIT 1`,
    [String(session.id)]
  );
  if (existing.rows.length) {
    return { already_processed: true, addon_code: addonCode, location_id: locationId };
  }

  await pool.query("BEGIN");
  try {
    await pool.query(
      `INSERT INTO saas_addon_purchases (
        stripe_session_id,
        stripe_subscription_id,
        location_id,
        addon_code,
        quantity,
        mode,
        amount_cents,
        status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        String(session.id),
        session.subscription ? String(session.subscription) : null,
        locationId,
        addon.code,
        quantity,
        addon.mode,
        addon.amount_cents,
        "paid",
      ]
    );

    if (addon.code === "branding_unlock") {
      await pool.query(
        `UPDATE profiles SET addon_branding_unlocked = TRUE WHERE location_id = $1`,
        [locationId]
      );
    } else if (addon.code === "funnel_unlock") {
      await pool.query(
        `UPDATE profiles SET addon_funnel_unlocked = TRUE WHERE location_id = $1`,
        [locationId]
      );
    } else if (addon.code === "extra_vehicle_subscription") {
      await pool.query(
        `UPDATE profiles
         SET addon_extra_vehicle_count = LEAST(5, COALESCE(addon_extra_vehicle_count, 0) + $2)
         WHERE location_id = $1`,
        [locationId, quantity]
      );
    }

    await pool.query("COMMIT");
    return { already_processed: false, addon_code: addon.code, location_id: locationId };
  } catch (err) {
    await pool.query("ROLLBACK");
    throw err;
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

app.post("/api/create-addon-checkout-session", async (req, res) => {
  try {
    const locationId = String(req.body.location_id || "").trim();
    const addonCode = String(req.body.addon_code || "").trim();
    const quantity = Math.max(1, Number(req.body.quantity || 1));
    const returnUrl = sanitizeReturnUrl(req.body.return_url, req) || `${req.protocol}://${req.get("host")}/corporate-addons.html`;

    if (!locationId) {
      return res.status(400).json({ error: "location_id is required." });
    }

    const addon = SAAS_ADDON_CATALOG[addonCode];
    if (!addon) {
      return res.status(400).json({ error: "Unsupported add-on." });
    }

    const profileRes = await pool.query(
      `SELECT plan_name, addon_branding_unlocked, addon_funnel_unlocked, addon_extra_vehicle_count
       FROM profiles
       WHERE location_id = $1
       LIMIT 1`,
      [locationId]
    );
    if (!profileRes.rows.length) {
      return res.status(404).json({ error: "Profile not found." });
    }

    const profile = profileRes.rows[0];
    const entitlements = buildPlanEntitlements({
      planName: profile.plan_name,
      addonBrandingUnlocked: profile.addon_branding_unlocked,
      addonFunnelUnlocked: profile.addon_funnel_unlocked,
      addonExtraVehicleCount: profile.addon_extra_vehicle_count,
    });

    if (addonCode === "branding_unlock" && !entitlements.can_purchase_branding) {
      return res.status(400).json({ error: "Branding is already included on this plan." });
    }

    if (addonCode === "funnel_unlock" && !entitlements.can_purchase_funnel) {
      return res.status(400).json({ error: "Funnel access is already included on this plan." });
    }

    if (addonCode === "extra_vehicle_subscription") {
      if (!entitlements.can_purchase_extra_vehicle) {
        return res.status(400).json({ error: "This plan cannot add more fleet vehicles." });
      }
      if ((entitlements.allowed_fleet_count + quantity) > entitlements.max_fleet_count) {
        return res.status(400).json({ error: `This purchase would exceed the fleet limit of ${entitlements.max_fleet_count} vehicles.` });
      }
    }

    const stripeSecretKey = await getStripeSecretKeyForLocation(locationId);
    if (!stripeSecretKey) {
      return res.status(500).json({ error: "Stripe is not configured on this account." });
    }

    const successUrl = appendQueryParams(returnUrl, {
      addon_checkout: "success",
      session_id: "{CHECKOUT_SESSION_ID}",
      location_id: locationId,
    });
    const cancelUrl = appendQueryParams(returnUrl, {
      addon_checkout: "cancel",
      location_id: locationId,
    });

    const session = await createStripeAddonCheckoutSession({
      apiKey: stripeSecretKey,
      locationId,
      customerEmail: null,
      addonCode,
      quantity,
      successUrl,
      cancelUrl,
    });

    return res.json({
      success: true,
      checkout_url: session.url,
      addon_code: addonCode,
      quantity,
    });
  } catch (err) {
    console.error("Create add-on checkout session error:", err);
    return res.status(500).json({ error: err.message || "Failed to create add-on checkout session." });
  }
});

app.get("/api/addon-checkout-session-status", async (req, res) => {
  try {
    const sessionId = String(req.query.session_id || "").trim();
    const locationId = String(req.query.location_id || "").trim() || null;
    if (!sessionId) {
      return res.status(400).json({ error: "session_id is required." });
    }

    const stripeSecretKey = await getStripeSecretKeyForLocation(locationId);
    if (!stripeSecretKey) {
      return res.status(500).json({ error: "Stripe is not configured on the backend." });
    }

    const session = await stripeFormRequest(
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { expand: ["subscription"] },
      "GET",
      stripeSecretKey
    );

    const isPaid = session.mode === "subscription"
      ? ["active", "trialing"].includes(session.subscription?.status || "")
      : session.payment_status === "paid";

    let applied = null;
    if (isPaid) {
      applied = await applyAddonPurchaseFromSession(session);
    }

    return res.json({
      session_id: session.id,
      mode: session.mode,
      payment_status: session.payment_status || null,
      subscription_status: session.subscription?.status || null,
      addon_code: session.metadata?.addon_code || null,
      quantity: Number(session.metadata?.quantity || 1),
      applied,
      paid: isPaid,
    });
  } catch (err) {
    console.error("Add-on checkout status error:", err);
    return res.status(500).json({ error: err.message || "Failed to verify add-on checkout session." });
  }
});

app.post("/api/partners/invite", async (req, res) => {
  try {
    await ensureDispatchTables();
    const ownerLocationId = String(req.body.owner_location_id || "").trim();
    const email = String(req.body.email || "").trim().toLowerCase();
    const expiresInDays = Math.max(1, Number(req.body.expires_in_days || 7));

    if (!ownerLocationId || !email) {
      return res.status(400).json({ error: "owner_location_id and email are required." });
    }

    const inviteId = randomUUID();
    const token = randomUUID();
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString();

    await pool.query(
      `INSERT INTO partner_onboarding_invites (id, owner_location_id, email, token, status, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [inviteId, ownerLocationId, email, token, "pending", expiresAt]
    );

    return res.json({
      success: true,
      invite_id: inviteId,
      token,
      onboarding_url: `${req.protocol}://${req.get("host")}/partner-onboarding.html?token=${encodeURIComponent(token)}`,
      expires_at: expiresAt,
    });
  } catch (err) {
    console.error("Partner invite error:", err);
    return res.status(500).json({ error: err.message || "Failed to create partner invite." });
  }
});

app.get("/api/partners/onboard/:token", async (req, res) => {
  try {
    await ensureDispatchTables();
    const token = String(req.params.token || "").trim();
    const result = await pool.query(
      `SELECT id, owner_location_id, email, status, expires_at, created_at
       FROM partner_onboarding_invites
       WHERE token = $1
       LIMIT 1`,
      [token]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Invite not found." });
    }

    const invite = result.rows[0];
    return res.json({
      success: true,
      invite_id: invite.id,
      owner_location_id: invite.owner_location_id,
      email: invite.email,
      status: invite.status,
      expires_at: invite.expires_at,
      created_at: invite.created_at,
    });
  } catch (err) {
    console.error("Partner onboarding lookup error:", err);
    return res.status(500).json({ error: err.message || "Failed to load invite." });
  }
});

app.get("/api/partners/invites/:owner_location_id", async (req, res) => {
  try {
    await ensureDispatchTables();
    const ownerLocationId = String(req.params.owner_location_id || "").trim();
    const result = await pool.query(
      `SELECT id, email, token, status, expires_at, created_at
       FROM partner_onboarding_invites
       WHERE owner_location_id = $1
       ORDER BY created_at DESC`,
      [ownerLocationId]
    );

    return res.json({
      success: true,
      invites: result.rows.map((invite) => ({
        ...invite,
        onboarding_url: `${req.protocol}://${req.get("host")}/partner-onboarding.html?token=${encodeURIComponent(invite.token)}`,
      })),
    });
  } catch (err) {
    console.error("List partner invites error:", err);
    return res.status(500).json({ error: err.message || "Failed to load partner invites." });
  }
});

app.post("/api/partners/onboard/:token", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDispatchTables();
    const token = String(req.params.token || "").trim();
    const inviteResult = await client.query(
      `SELECT id, owner_location_id, email, status, expires_at
       FROM partner_onboarding_invites
       WHERE token = $1
       LIMIT 1`,
      [token]
    );

    if (!inviteResult.rows.length) {
      return res.status(404).json({ error: "Invite not found." });
    }

    const invite = inviteResult.rows[0];
    if (invite.status !== "pending") {
      return res.status(400).json({ error: "Invite is no longer active." });
    }
    if (invite.expires_at && new Date(invite.expires_at).getTime() < Date.now()) {
      return res.status(400).json({ error: "Invite has expired." });
    }

    const fleet = clampPartnerFleetRows(req.body.fleet);
    const partnerId = randomUUID();

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO partners (
        id, owner_location_id, partner_location_id, business_name, contact_name, email, phone,
        status, crm_webhook_url, crm_api_key, maps_api_key, payment_provider, stripe_account_id,
        service_lat, service_lng, service_radius_miles, timezone, dispatch_pipeline_id, dispatch_stage_id, accepts_dispatch, auto_accept,
        created_at, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,NOW(),NOW()
      )`,
      [
        partnerId,
        invite.owner_location_id,
        String(req.body.partner_location_id || "").trim(),
        String(req.body.business_name || "").trim(),
        String(req.body.contact_name || "").trim() || null,
        String(req.body.email || invite.email || "").trim().toLowerCase(),
        String(req.body.phone || "").trim() || null,
        "active",
        String(req.body.crm_webhook_url || "").trim() || null,
        String(req.body.crm_api_key || "").trim() || null,
        String(req.body.maps_api_key || "").trim() || null,
        normalizePaymentProvider(req.body.payment_provider),
        String(req.body.stripe_account_id || "").trim() || null,
        req.body.service_lat != null ? Number(req.body.service_lat) : null,
        req.body.service_lng != null ? Number(req.body.service_lng) : null,
        req.body.service_radius_miles != null ? Number(req.body.service_radius_miles) : null,
        String(req.body.timezone || "").trim() || null,
        String(req.body.dispatch_pipeline_id || "").trim() || null,
        String(req.body.dispatch_stage_id || "").trim() || null,
        req.body.accepts_dispatch !== false,
        Boolean(req.body.auto_accept),
      ]
    );

    for (const row of fleet) {
      await client.query(
        `INSERT INTO partner_fleet (
          id, partner_id, vehicle_type, vehicle_category, calendar_id, base_rate, mile_rate, active
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          randomUUID(),
          partnerId,
          String(row.vehicle_type || "").trim(),
          String(row.vehicle_category || "").trim() || null,
          String(row.calendar_id || "").trim() || null,
          Number(row.base_rate || 0),
          Number(row.mile_rate || 0),
          row.active !== false,
        ]
      );
    }

    await client.query(
      `UPDATE partner_onboarding_invites
       SET status = 'completed'
       WHERE id = $1`,
      [invite.id]
    );
    await client.query("COMMIT");

    return res.json({
      success: true,
      partner_id: partnerId,
      status: "active",
      fleet_count: fleet.length,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Partner onboarding error:", err);
    return res.status(500).json({ error: err.message || "Failed to onboard partner." });
  } finally {
    client.release();
  }
});

app.get("/api/partners/:owner_location_id", async (req, res) => {
  try {
    await ensureDispatchTables();
    const ownerLocationId = String(req.params.owner_location_id || "").trim();
    const result = await pool.query(
      `SELECT
        p.id,
        p.partner_location_id,
        p.business_name,
        p.contact_name,
        p.email,
        p.phone,
        p.status,
        p.dispatch_pipeline_id,
        p.dispatch_stage_id,
        p.accepts_dispatch,
        p.auto_accept,
        p.service_radius_miles,
        COUNT(pf.id) FILTER (WHERE pf.active = TRUE) AS active_fleet_count
       FROM partners p
       LEFT JOIN partner_fleet pf ON pf.partner_id = p.id
       WHERE p.owner_location_id = $1
       GROUP BY p.id
       ORDER BY p.business_name ASC`,
      [ownerLocationId]
    );

    return res.json({ success: true, partners: result.rows });
  } catch (err) {
    console.error("List partners error:", err);
    return res.status(500).json({ error: err.message || "Failed to load partners." });
  }
});

app.get("/api/partner-split-agreements/:owner_location_id", async (req, res) => {
  try {
    await ensureDispatchTables();
    const ownerLocationId = String(req.params.owner_location_id || "").trim();
    const result = await pool.query(
      `SELECT
        psa.id,
        psa.owner_location_id,
        psa.partner_id,
        psa.split_model,
        psa.source_operator_percent,
        psa.accepting_partner_percent,
        psa.fee_charged_to,
        psa.created_at,
        psa.updated_at,
        p.business_name,
        p.partner_location_id,
        p.contact_name,
        p.email,
        p.phone,
        p.status
       FROM partner_split_agreements psa
       JOIN partners p ON p.id = psa.partner_id
       WHERE psa.owner_location_id = $1
       ORDER BY p.business_name ASC`,
      [ownerLocationId]
    );

    return res.json({ success: true, agreements: result.rows });
  } catch (err) {
    console.error("List partner split agreements error:", err);
    return res.status(500).json({ error: err.message || "Failed to load partner split agreements." });
  }
});

app.post("/api/partner-split-agreements", async (req, res) => {
  try {
    await ensureDispatchTables();
    const ownerLocationId = String(req.body.owner_location_id || "").trim();
    const partnerId = String(req.body.partner_id || "").trim();

    if (!ownerLocationId || !partnerId) {
      return res.status(400).json({ error: "owner_location_id and partner_id are required." });
    }

    const partnerLookup = await pool.query(
      `SELECT id, business_name
       FROM partners
       WHERE id = $1
         AND owner_location_id = $2
       LIMIT 1`,
      [partnerId, ownerLocationId]
    );

    if (!partnerLookup.rows.length) {
      return res.status(404).json({ error: "Partner not found for this location." });
    }

    const split = buildPartnerSplitAgreementPayload(req.body.accepting_partner_percent);

    const result = await pool.query(
      `INSERT INTO partner_split_agreements (
        id,
        owner_location_id,
        partner_id,
        split_model,
        source_operator_percent,
        accepting_partner_percent,
        fee_charged_to,
        created_at,
        updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
      ON CONFLICT (owner_location_id, partner_id)
      DO UPDATE SET
        split_model = EXCLUDED.split_model,
        source_operator_percent = EXCLUDED.source_operator_percent,
        accepting_partner_percent = EXCLUDED.accepting_partner_percent,
        fee_charged_to = EXCLUDED.fee_charged_to,
        updated_at = NOW()
      RETURNING id, owner_location_id, partner_id, split_model, source_operator_percent, accepting_partner_percent, fee_charged_to, created_at, updated_at`,
      [
        randomUUID(),
        ownerLocationId,
        partnerId,
        split.split_model,
        split.source_operator_percent,
        split.accepting_partner_percent,
        split.fee_charged_to,
      ]
    );

    return res.json({
      success: true,
      agreement: {
        ...result.rows[0],
        business_name: partnerLookup.rows[0].business_name,
      },
    });
  } catch (err) {
    console.error("Save partner split agreement error:", err);
    return res.status(500).json({ error: err.message || "Failed to save partner split agreement." });
  }
});

app.post("/api/tracking/session/create", async (req, res) => {
  try {
    await ensureTripTrackingTables();

    const bookingId = Number(req.body.booking_id || 0);
    const explicitLocationId = String(req.body.location_id || "").trim();

    if (!bookingId) {
      return res.status(400).json({ error: "booking_id is required." });
    }

    const bookingLookup = await pool.query(
      `SELECT id, location_id, pickup_address, dropoff_address, start_time, end_time, first_name, last_name, customer_email, customer_phone
       FROM bookings
       WHERE id = $1
       LIMIT 1`,
      [bookingId]
    );

    if (!bookingLookup.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }

    const booking = bookingLookup.rows[0];
    const locationId = explicitLocationId || String(booking.location_id || "").trim();
    if (!locationId) {
      return res.status(400).json({ error: "location_id is required for tracking." });
    }

    const existing = await pool.query(
      `SELECT *
       FROM trip_tracking_sessions
       WHERE booking_id = $1
       LIMIT 1`,
      [bookingId]
    );

    if (existing.rows.length) {
      const session = existing.rows[0];
      return res.json({
        success: true,
        tracking_session_id: session.id,
        driver_token: session.driver_token,
        customer_token: session.customer_token,
        ...buildTrackingUrls(req, session.driver_token, session.customer_token),
      });
    }

    const id = randomUUID();
    const driverToken = createTrackingToken("drv");
    const customerToken = createTrackingToken("cus");

    await pool.query(
      `INSERT INTO trip_tracking_sessions (
        id, booking_id, location_id, driver_token, customer_token, status, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,'driver_assigned',NOW(),NOW())`,
      [id, bookingId, locationId, driverToken, customerToken]
    );

    return res.json({
      success: true,
      tracking_session_id: id,
      driver_token: driverToken,
      customer_token: customerToken,
      ...buildTrackingUrls(req, driverToken, customerToken),
    });
  } catch (err) {
    console.error("Create tracking session error:", err);
    return res.status(500).json({ error: err.message || "Failed to create tracking session." });
  }
});

app.get("/api/tracking/session/driver", async (req, res) => {
  try {
    await ensureTripTrackingTables();

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "token is required." });
    }

    const session = await getTrackingSessionByToken({ token, role: "driver" });
    if (!session) {
      return res.status(404).json({ error: "Tracking session not found." });
    }

    return res.json({
      success: true,
      session: buildTrackingSessionClientShape(session),
      tracking: buildTrackingResponsePayload(session, { includeDriverToken: true }),
      ...buildTrackingUrls(req, session.driver_token, session.customer_token),
    });
  } catch (err) {
    console.error("Driver tracking session lookup error:", err);
    return res.status(500).json({ error: err.message || "Failed to load driver tracking session." });
  }
});

app.get("/api/tracking/session/customer", async (req, res) => {
  try {
    await ensureTripTrackingTables();

    const token = String(req.query.token || "").trim();
    if (!token) {
      return res.status(400).json({ error: "token is required." });
    }

    const session = await getTrackingSessionByToken({ token, role: "customer" });
    if (!session) {
      return res.status(404).json({ error: "Tracking session not found." });
    }

    return res.json({
      success: true,
      session: buildTrackingSessionClientShape(session),
      tracking: buildTrackingResponsePayload(session),
      customer_url: buildTrackingUrls(req, session.driver_token, session.customer_token).customer_url,
    });
  } catch (err) {
    console.error("Customer tracking session lookup error:", err);
    return res.status(500).json({ error: err.message || "Failed to load customer tracking session." });
  }
});

app.post("/api/tracking/location", async (req, res) => {
  try {
    await ensureTripTrackingTables();

    const token = String(req.body.token || "").trim();
    const lat = parseOptionalNumber(req.body.lat);
    const lng = parseOptionalNumber(req.body.lng);
    const heading = parseOptionalNumber(req.body.heading);
    const speed = parseOptionalNumber(req.body.speed);
    const accuracy = parseOptionalNumber(req.body.accuracy);

    if (!token || lat === null || lng === null) {
      return res.status(400).json({ error: "token, lat, and lng are required." });
    }

    const lookup = await pool.query(
      `SELECT id, status
       FROM trip_tracking_sessions
       WHERE driver_token = $1
       LIMIT 1`,
      [token]
    );

    if (!lookup.rows.length) {
      return res.status(404).json({ error: "Tracking session not found." });
    }

    const session = lookup.rows[0];
    if (session.status === "completed") {
      return res.status(400).json({ error: "Trip tracking is already completed." });
    }

    await pool.query(
      `UPDATE trip_tracking_sessions
       SET current_lat = $2,
           current_lng = $3,
           heading = $4,
           speed = $5,
           accuracy = $6,
           last_location_at = NOW(),
           started_at = COALESCE(started_at, NOW()),
           updated_at = NOW()
       WHERE id = $1`,
      [session.id, lat, lng, heading, speed, accuracy]
    );

    await pool.query(
      `INSERT INTO trip_tracking_points (
        id, tracking_session_id, lat, lng, heading, speed, accuracy, recorded_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [randomUUID(), session.id, lat, lng, heading, speed, accuracy]
    );

    return res.json({
      success: true,
      tracking_session_id: session.id,
      last_location_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error("Driver tracking location update error:", err);
    return res.status(500).json({ error: err.message || "Failed to save tracking location." });
  }
});

app.post("/api/tracking/status", async (req, res) => {
  try {
    await ensureTripTrackingTables();

    const token = String(req.body.token || "").trim();
    const status = normalizeTrackingStatus(req.body.status);

    if (!token) {
      return res.status(400).json({ error: "token is required." });
    }

    const result = await pool.query(
      `UPDATE trip_tracking_sessions
       SET status = $2,
           started_at = CASE
             WHEN $2 <> 'driver_assigned' THEN COALESCE(started_at, NOW())
             ELSE started_at
           END,
           ended_at = CASE
             WHEN $2 = 'completed' THEN NOW()
             ELSE ended_at
           END,
           updated_at = NOW()
       WHERE driver_token = $1
       RETURNING id, status`,
      [token, status]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: "Tracking session not found." });
    }

    return res.json({
      success: true,
      tracking_session_id: result.rows[0].id,
      status: result.rows[0].status,
    });
  } catch (err) {
    console.error("Driver tracking status update error:", err);
    return res.status(500).json({ error: err.message || "Failed to update tracking status." });
  }
});

app.post("/api/dispatch/create", async (req, res) => {
  try {
    await ensureDispatchTables();
    const bookingId = Number(req.body.booking_id || 0);
    const ownerLocationId = String(req.body.owner_location_id || "").trim();

    if (!bookingId || !ownerLocationId) {
      return res.status(400).json({ error: "booking_id and owner_location_id are required." });
    }

    const bookingResult = await pool.query(
      `SELECT id, pickup_address, dropoff_address, start_time, end_time, vehicle_slot_id
       FROM bookings
       WHERE id = $1
       LIMIT 1`,
      [bookingId]
    );
    if (!bookingResult.rows.length) {
      return res.status(404).json({ error: "Booking not found." });
    }
    const booking = bookingResult.rows[0];
    const dispatchRequestId = randomUUID();

    await pool.query(
      `INSERT INTO dispatch_requests (
        id, booking_id, owner_location_id, requested_vehicle_type, pickup_address, dropoff_address,
        start_time, end_time, status, broadcast_mode, notes, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())`,
      [
        dispatchRequestId,
        bookingId,
        ownerLocationId,
        String(req.body.requested_vehicle_type || booking.vehicle_slot_id || "").trim() || null,
        booking.pickup_address || null,
        booking.dropoff_address || null,
        booking.start_time || null,
        booking.end_time || null,
        "open",
        String(req.body.broadcast_mode || "manual").trim(),
        String(req.body.notes || "").trim() || null,
      ]
    );

    await pool.query(
      `UPDATE bookings
       SET dispatch_status = 'open', dispatch_request_id = $2
       WHERE id = $1`,
      [bookingId, dispatchRequestId]
    );

    return res.json({
      success: true,
      dispatch_request_id: dispatchRequestId,
      status: "open",
    });
  } catch (err) {
    console.error("Create dispatch request error:", err);
    return res.status(500).json({ error: err.message || "Failed to create dispatch request." });
  }
});

app.post("/api/dispatch/:dispatch_request_id/offer", async (req, res) => {
  try {
    await ensureDispatchTables();
    const dispatchRequestId = String(req.params.dispatch_request_id || "").trim();
    const partnerIds = Array.isArray(req.body.partner_ids) ? req.body.partner_ids : [];
    if (!dispatchRequestId || !partnerIds.length) {
      return res.status(400).json({ error: "dispatch_request_id and partner_ids are required." });
    }

    const expiresInMinutes = Math.max(5, Number(req.body.expires_in_minutes || 30));
    const expiresAt = new Date(Date.now() + expiresInMinutes * 60 * 1000).toISOString();
    const dispatchLookup = await pool.query(
      `SELECT owner_location_id
       FROM dispatch_requests
       WHERE id = $1
       LIMIT 1`,
      [dispatchRequestId]
    );

    if (!dispatchLookup.rows.length) {
      return res.status(404).json({ error: "Dispatch request not found." });
    }

    const ownerLocationId = String(dispatchLookup.rows[0].owner_location_id || "").trim();
    let offersSent = 0;

    for (const partnerId of partnerIds) {
      const splitAgreement = await getPartnerSplitAgreement(ownerLocationId, String(partnerId));
      const split = splitAgreement || buildPartnerSplitAgreementPayload(req.body.accepting_partner_percent);

      await pool.query(
        `INSERT INTO dispatch_offers (
          id, dispatch_request_id, partner_id, status, sent_at, expires_at,
          quoted_price, partner_payout_amount, platform_fee_amount, notes,
          source_operator_percent, accepting_partner_percent, split_model, fee_charged_to
        ) VALUES ($1,$2,$3,$4,NOW(),$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          randomUUID(),
          dispatchRequestId,
          String(partnerId),
          "sent",
          expiresAt,
          req.body.quoted_price != null ? Number(req.body.quoted_price) : null,
          req.body.partner_payout_amount != null ? Number(req.body.partner_payout_amount) : null,
          req.body.platform_fee_amount != null ? Number(req.body.platform_fee_amount) : null,
          String(req.body.notes || "").trim() || null,
          Number(split.source_operator_percent),
          Number(split.accepting_partner_percent),
          String(split.split_model || "net_after_stripe_fee"),
          String(split.fee_charged_to || "source_operator"),
        ]
      );
      offersSent += 1;
    }

    return res.json({ success: true, offers_sent: offersSent, expires_at: expiresAt });
  } catch (err) {
    console.error("Dispatch offer error:", err);
    return res.status(500).json({ error: err.message || "Failed to create dispatch offers." });
  }
});

app.post("/api/dispatch-offers/:offer_id/respond", async (req, res) => {
  try {
    await ensureDispatchTables();
    const offerId = String(req.params.offer_id || "").trim();
    const status = String(req.body.status || "").trim().toLowerCase();
    if (!["accepted", "declined"].includes(status)) {
      return res.status(400).json({ error: "status must be accepted or declined." });
    }

    const result = await pool.query(
      `UPDATE dispatch_offers
       SET status = $2, responded_at = NOW(), notes = COALESCE($3, notes)
       WHERE id = $1
       RETURNING id, dispatch_request_id, partner_id, status`,
      [offerId, status, String(req.body.notes || "").trim() || null]
    );
    if (!result.rows.length) {
      return res.status(404).json({ error: "Offer not found." });
    }

    return res.json({ success: true, offer_id: result.rows[0].id, status: result.rows[0].status });
  } catch (err) {
    console.error("Dispatch offer response error:", err);
    return res.status(500).json({ error: err.message || "Failed to update offer response." });
  }
});

app.post("/api/dispatch/:dispatch_request_id/assign", async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureDispatchTables();
    const dispatchRequestId = String(req.params.dispatch_request_id || "").trim();
    const partnerId = String(req.body.partner_id || "").trim();
    if (!dispatchRequestId || !partnerId) {
      return res.status(400).json({ error: "dispatch_request_id and partner_id are required." });
    }

    const requestLookup = await client.query(
      `SELECT booking_id FROM dispatch_requests WHERE id = $1 LIMIT 1`,
      [dispatchRequestId]
    );
    if (!requestLookup.rows.length) {
      return res.status(404).json({ error: "Dispatch request not found." });
    }

    const acceptedOffer = await client.query(
      `SELECT id, quoted_price, partner_payout_amount, platform_fee_amount
       FROM dispatch_offers
       WHERE dispatch_request_id = $1 AND partner_id = $2 AND status = 'accepted'
       LIMIT 1`,
      [dispatchRequestId, partnerId]
    );
    if (!acceptedOffer.rows.length) {
      return res.status(400).json({ error: "Partner must accept the offer before assignment." });
    }

    const assignmentId = randomUUID();
    const bookingId = requestLookup.rows[0].booking_id || null;

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO dispatch_assignments (
        id, dispatch_request_id, partner_id, booking_id, status, assigned_at
      ) VALUES ($1,$2,$3,$4,$5,NOW())`,
      [assignmentId, dispatchRequestId, partnerId, bookingId, "assigned"]
    );

    await client.query(
      `UPDATE dispatch_requests
       SET status = 'assigned', updated_at = NOW()
       WHERE id = $1`,
      [dispatchRequestId]
    );

    await client.query(
      `UPDATE dispatch_offers
       SET status = CASE WHEN partner_id = $2 THEN 'assigned' ELSE 'closed' END
       WHERE dispatch_request_id = $1`,
      [dispatchRequestId, partnerId]
    );

    if (bookingId) {
      await client.query(
        `UPDATE bookings
         SET dispatch_status = 'assigned',
             assigned_partner_id = $2,
             dispatch_request_id = $3
         WHERE id = $1`,
        [bookingId, partnerId, dispatchRequestId]
      );
    }

    const offer = acceptedOffer.rows[0];
    await client.query(
      `INSERT INTO partner_payouts (
        id, dispatch_assignment_id, booking_id, gross_amount, partner_payout_amount, platform_fee_amount, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        assignmentId,
        bookingId,
        offer.quoted_price != null ? Number(offer.quoted_price) : 0,
        offer.partner_payout_amount != null ? Number(offer.partner_payout_amount) : 0,
        offer.platform_fee_amount != null ? Number(offer.platform_fee_amount) : 0,
        "pending",
      ]
    );

    await client.query("COMMIT");

    let crmSync = {
      attempted: false,
      success: false,
      error: null,
      contact_id: null,
      opportunity_id: null,
    };

    try {
      const partnerResult = await pool.query(
        `SELECT
          id,
          partner_location_id,
          business_name,
          crm_api_key,
          dispatch_pipeline_id,
          dispatch_stage_id
         FROM partners
         WHERE id = $1
         LIMIT 1`,
        [partnerId]
      );

      const dispatchResult = await pool.query(
        `SELECT
          dr.id AS dispatch_request_id,
          dr.owner_location_id,
          dr.start_time,
          dr.end_time,
          dr.pickup_address AS dispatch_pickup_address,
          dr.dropoff_address AS dispatch_dropoff_address,
          dr.requested_vehicle_type,
          dr.notes AS dispatch_notes,
          b.id AS booking_id,
          b.first_name,
          b.last_name,
          b.customer_email,
          b.customer_phone,
          b.pickup_address,
          b.dropoff_address,
          b.start_time AS booking_start_time,
          b.end_time AS booking_end_time,
          b.total_price,
          b.status AS booking_status,
          b.vehicle_slot_id,
          p.business_name AS source_business_name
         FROM dispatch_requests dr
         LEFT JOIN bookings b ON b.id = dr.booking_id
         LEFT JOIN profiles p ON p.location_id = dr.owner_location_id
         WHERE dr.id = $1
         LIMIT 1`,
        [dispatchRequestId]
      );

      const partnerRecord = partnerResult.rows[0] || null;
      const dispatchRecord = dispatchResult.rows[0] || null;

      if (!partnerRecord) {
        throw new Error("Assigned partner record not found.");
      }
      if (!dispatchRecord) {
        throw new Error("Dispatch request details not found.");
      }

      const dispatchData = {
        dispatch_request_id: dispatchRequestId,
        dispatch_assignment_id: assignmentId,
        booking_source: "network_dispatch",
        dispatch_status: "assigned",
        source_operator: {
          business_name: dispatchRecord.source_business_name || "Source Operator",
          location_id: dispatchRecord.owner_location_id || "",
        },
        customer: {
          first_name: dispatchRecord.first_name || "",
          last_name: dispatchRecord.last_name || "",
          full_name: [dispatchRecord.first_name, dispatchRecord.last_name].filter(Boolean).join(" ").trim(),
          phone: dispatchRecord.customer_phone || "",
          email: dispatchRecord.customer_email || "",
        },
        booking: {
          booking_id: dispatchRecord.booking_id,
          pickup_datetime: dispatchRecord.booking_start_time || dispatchRecord.start_time || null,
          end_datetime: dispatchRecord.booking_end_time || dispatchRecord.end_time || null,
          pickup_address: dispatchRecord.pickup_address || dispatchRecord.dispatch_pickup_address || "",
          dropoff_address: dispatchRecord.dropoff_address || dispatchRecord.dispatch_dropoff_address || "",
          vehicle_type_requested: dispatchRecord.requested_vehicle_type || dispatchRecord.vehicle_slot_id || "",
          passenger_count: null,
          special_instructions: dispatchRecord.dispatch_notes || "",
        },
        financials: {
          quoted_retail_price: offer.quoted_price != null ? Number(offer.quoted_price) : Number(dispatchRecord.total_price || 0),
          partner_payout_amount: offer.partner_payout_amount != null ? Number(offer.partner_payout_amount) : 0,
          payment_status: dispatchRecord.booking_status || "unpaid",
        },
      };

      const syncResult = await pushDispatchIntoPartnerCrmSafe(partnerRecord, dispatchData);
      crmSync = {
        attempted: true,
        success: true,
        error: null,
        contact_id: syncResult.contactId || null,
        opportunity_id: syncResult.opportunityId || null,
      };
    } catch (crmErr) {
      console.error("Partner CRM dispatch sync error:", crmErr);
      crmSync = {
        attempted: true,
        success: false,
        error: crmErr.message || "Partner CRM dispatch sync failed.",
        contact_id: null,
        opportunity_id: null,
      };
    }

    return res.json({
      success: true,
      assignment_id: assignmentId,
      status: "assigned",
      partner_booking_id: null,
      partner_crm_event_id: null,
      crm_sync: crmSync,
      message: crmSync.success
        ? "Partner assignment created and pushed into partner CRM."
        : "Partner assignment created, but partner CRM sync needs attention.",
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Dispatch assign error:", err);
    return res.status(500).json({ error: err.message || "Failed to assign dispatch partner." });
  } finally {
    client.release();
  }
});

app.get("/api/dispatch/:dispatch_request_id/status", async (req, res) => {
  try {
    await ensureDispatchTables();
    const dispatchRequestId = String(req.params.dispatch_request_id || "").trim();
    const requestResult = await pool.query(
      `SELECT * FROM dispatch_requests WHERE id = $1 LIMIT 1`,
      [dispatchRequestId]
    );
    if (!requestResult.rows.length) {
      return res.status(404).json({ error: "Dispatch request not found." });
    }

    const offersResult = await pool.query(
      `SELECT * FROM dispatch_offers WHERE dispatch_request_id = $1 ORDER BY sent_at ASC`,
      [dispatchRequestId]
    );
    const assignmentResult = await pool.query(
      `SELECT * FROM dispatch_assignments WHERE dispatch_request_id = $1 LIMIT 1`,
      [dispatchRequestId]
    );

    return res.json({
      success: true,
      dispatch_request: requestResult.rows[0],
      offers: offersResult.rows,
      assignment: assignmentResult.rows[0] || null,
    });
  } catch (err) {
    console.error("Dispatch status error:", err);
    return res.status(500).json({ error: err.message || "Failed to load dispatch status." });
  }
});

app.post("/api/dispatch/:dispatch_request_id/cancel", async (req, res) => {
  try {
    await ensureDispatchTables();
    const dispatchRequestId = String(req.params.dispatch_request_id || "").trim();
    const reason = String(req.body.reason || "cancelled").trim();

    const requestResult = await pool.query(
      `UPDATE dispatch_requests
       SET status = 'cancelled', updated_at = NOW(), notes = COALESCE($2, notes)
       WHERE id = $1
       RETURNING booking_id`,
      [dispatchRequestId, reason]
    );
    if (!requestResult.rows.length) {
      return res.status(404).json({ error: "Dispatch request not found." });
    }

    await pool.query(
      `UPDATE dispatch_offers
       SET status = 'cancelled'
       WHERE dispatch_request_id = $1 AND status IN ('sent', 'accepted')`,
      [dispatchRequestId]
    );

    if (requestResult.rows[0].booking_id) {
      await pool.query(
        `UPDATE bookings
         SET dispatch_status = 'cancelled'
         WHERE id = $1`,
        [requestResult.rows[0].booking_id]
      );
    }

    return res.json({ success: true, status: "cancelled", reason });
  } catch (err) {
    console.error("Dispatch cancel error:", err);
    return res.status(500).json({ error: err.message || "Failed to cancel dispatch." });
  }
});

app.post("/api/partners/:partner_id/check-availability", async (req, res) => {
  try {
    await ensureDispatchTables();
    const partnerId = String(req.params.partner_id || "").trim();
    const vehicleType = String(req.body.vehicle_type || "").trim();
    const startTime = String(req.body.start_time || "").trim();
    const endTime = String(req.body.end_time || "").trim();

    if (!partnerId || !vehicleType || !startTime || !endTime) {
      return res.status(400).json({ error: "partner_id, vehicle_type, start_time, and end_time are required." });
    }

    const partnerLookup = await pool.query(
      `SELECT p.id, p.partner_location_id, pf.calendar_id
       FROM partners p
       JOIN partner_fleet pf ON pf.partner_id = p.id
       WHERE p.id = $1
         AND p.status = 'active'
         AND p.accepts_dispatch = TRUE
         AND pf.active = TRUE
         AND pf.vehicle_type = $2
       LIMIT 1`,
      [partnerId, vehicleType]
    );

    if (!partnerLookup.rows.length) {
      return res.json({ success: true, available: false, calendar_id: null });
    }

    const partner = partnerLookup.rows[0];
    if (!partner.calendar_id) {
      return res.json({ success: true, available: false, calendar_id: null });
    }

    const events = await getCrmCalendarEvents({
      locationId: partner.partner_location_id,
      calendarId: partner.calendar_id,
      startTime,
      endTime,
    });
    const conflict = findCalendarConflict(events, startTime, endTime);

    return res.json({
      success: true,
      available: !conflict,
      calendar_id: partner.calendar_id,
      conflict: conflict || null,
    });
  } catch (err) {
    console.error("Partner availability error:", err);
    return res.status(500).json({ error: err.message || "Failed to check partner availability." });
  }
});

app.post("/api/cancel-booking", async (req, res) => {
  try {
    const bookingId = Number(req.body.booking_id || req.body.id || 0);
    const reason = String(req.body.reason || "unpaid_balance").trim();

    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return res.status(400).json({ error: "booking_id is required." });
    }

    const bookingLookup = await pool.query(
      `SELECT id, location_id, crm_event_id
       FROM bookings
       WHERE id = $1
       LIMIT 1`,
      [bookingId]
    );

    if (!bookingLookup.rows.length) {
      return res.status(404).json({ error: "Booking not found for cancellation." });
    }

    const existingBooking = bookingLookup.rows[0];
    let calendarSync = null;

    if (existingBooking.crm_event_id) {
      try {
        await deleteCrmEvent(existingBooking.location_id, existingBooking.crm_event_id);
        calendarSync = {
          attempted: true,
          success: true,
          crm_event_id: existingBooking.crm_event_id,
          action: "deleted",
        };
      } catch (calendarErr) {
        console.error("CRM calendar delete error during cancellation:", calendarErr);
        calendarSync = {
          attempted: true,
          success: false,
          crm_event_id: existingBooking.crm_event_id,
          error: calendarErr?.message || "Failed to delete CRM calendar event.",
        };
      }
    }

    const result = await pool.query(
      `UPDATE bookings
       SET status = $1,
           crm_event_id = CASE WHEN $2 THEN NULL ELSE crm_event_id END
       WHERE id = $3
       RETURNING id, location_id, status`,
      ["cancelled", Boolean(calendarSync?.success), bookingId]
    );

    await triggerCrmWebhook(result.rows[0].location_id, result.rows[0].id);

    return res.json({
      success: true,
      booking_id: result.rows[0].id,
      location_id: result.rows[0].location_id,
      status: result.rows[0].status,
      reason,
      calendar_sync: calendarSync,
      message: "Booking cancelled successfully.",
    });
  } catch (err) {
    console.error("Cancel booking error:", err);
    return res.status(500).json({ error: err.message || "Failed to cancel booking." });
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
  const balanceDueDeadline = financials.balance_due_deadline || (
    booking.start_time && Number(financials.balance_due || 0) > 0
      ? new Date(new Date(booking.start_time).getTime() - (48 * 60 * 60 * 1000)).toISOString()
      : null
  );
  const cancelUnpaidBalanceAt = balanceDueDeadline && Number(financials.balance_due || 0) > 0
    ? endOfUtcDay(balanceDueDeadline)
    : null;
  const balanceReminder5DayAt = booking.start_time && Number(financials.balance_due || 0) > 0
    ? new Date(new Date(booking.start_time).getTime() - (5 * 24 * 60 * 60 * 1000)).toISOString()
    : null;
  const paymentProvider = normalizePaymentProvider(financials.payment_provider || meta.payment_provider || "stripe");
  const calendarTitle = `${businessName || "Chauffeur Deluxe"} Reservation #${booking.booking_id}`;
  const calendarDescription = [
    customer.first_name || customer.last_name ? `Reservation for ${[customer.first_name, customer.last_name].filter(Boolean).join(" ")}` : null,
    booking.pickup_address ? `Pickup: ${booking.pickup_address}` : null,
    booking.dropoff_address ? `Dropoff: ${booking.dropoff_address}` : null,
    vehicle.vehicle_type ? `Vehicle: ${vehicle.vehicle_type}` : null,
  ].filter(Boolean).join("\n");
  const calendarLinks = buildCalendarLinks({
    bookingId: booking.booking_id,
    title: calendarTitle,
    description: calendarDescription,
    location: booking.dropoff_address || booking.pickup_address || "",
    startTime: booking.start_time,
    endTime: booking.end_time,
  });

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
      start_time_display: booking.start_time ? formatDisplayDateTime(booking.start_time) : null,
      end_time: booking.end_time || null,
      end_time_display: booking.end_time ? formatDisplayDateTime(booking.end_time) : null,
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
      balance_payment_link: financials.balance_payment_link || null,
      payment_choice: financials.payment_choice || null,
      amount_due_now: Number(financials.amount_due_now || financials.deposit_amount || financials.total_price || 0),
      balance_due_deadline: balanceDueDeadline,
      payment_provider: paymentProvider,
    },
    follow_up: {
      send_payment_sms: paymentRequired,
      send_payment_email: paymentRequired,
      reminder_reason: paymentRequired ? "complete_booking_payment" : null,
      send_balance_invoice: Number(financials.balance_due || 0) > 0,
      send_balance_link_immediately: Number(financials.balance_due || 0) > 0,
      send_balance_link_5d: Number(financials.balance_due || 0) > 0,
      send_balance_link_48h: Number(financials.balance_due || 0) > 0,
      balance_link_5d_at: balanceReminder5DayAt,
      balance_invoice_due_at: balanceDueDeadline,
      balance_link_immediate_message: Number(financials.balance_due || 0) > 0
        ? `Your remaining balance of $${Number(financials.balance_due || 0).toFixed(2)} can be paid any time using the link below. Final payment is due at least 48 hours before pickup to keep this reservation active.`
        : null,
      balance_link_5d_message: Number(financials.balance_due || 0) > 0
        ? `Friendly reminder: your remaining balance of $${Number(financials.balance_due || 0).toFixed(2)} is still open. You can pay now using the link below. Final payment is due 48 hours before pickup.`
        : null,
      balance_invoice_message: Number(financials.balance_due || 0) > 0
        ? `Your remaining balance of $${Number(financials.balance_due || 0).toFixed(2)} must be paid at least 48 hours before pickup to keep this reservation active.`
        : null,
      balance_payment_link: financials.balance_payment_link || null,
      payment_provider: paymentProvider,
      cancellation_policy: {
        refund_24_to_48_hours: "50_percent",
        refund_under_24_hours: "no_refund",
      },
      cancel_unpaid_balance_same_day: Number(financials.balance_due || 0) > 0,
      cancel_unpaid_balance_at: cancelUnpaidBalanceAt,
      cancel_unpaid_balance_message: Number(financials.balance_due || 0) > 0
        ? `If the remaining balance is not paid by the end of the 48-hour reminder day, this reservation will be cancelled.`
        : null,
      add_to_calendar_ics_link: calendarLinks.ics,
      add_to_calendar_google_link: calendarLinks.google,
      add_to_calendar_yahoo_link: calendarLinks.yahoo,
      add_to_calendar_outlook_link: calendarLinks.outlook,
    },
  };
}

function getHoursUntilRide(startTime) {
  const rideDate = new Date(startTime);
  if (Number.isNaN(rideDate.getTime())) return 0;
  return (rideDate.getTime() - Date.now()) / (1000 * 60 * 60);
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

  try {
    await syncConfirmedBookingCalendarEvent(result.rows[0].id);
  } catch (calendarErr) {
    console.error("CRM calendar sync error after confirmation:", calendarErr);
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

async function createBalancePaymentLink(bookingRow) {
  const totalPrice = Number(bookingRow.total_price || 0);
  const depositAmount = Number(bookingRow.deposit_amount || 0);
  const balanceDue = Number((totalPrice - depositAmount).toFixed(2));

  const paymentProfile = await getPaymentProfileForLocation(bookingRow?.location_id);
  if (paymentProfile.provider !== "stripe" || !paymentProfile.stripeSecretKey || balanceDue <= 0 || !bookingRow?.id) {
    return null;
  }

  const baseUrl = getPublicAppUrl();
  const successUrl = appendQueryParams(`${baseUrl}/payment-complete.html`, {
    checkout: "success",
    session_id: "{CHECKOUT_SESSION_ID}",
    booking_id: bookingRow.id,
  });
  const cancelUrl = appendQueryParams(`${baseUrl}/payment-cancelled.html`, {
    checkout: "cancel",
    booking_id: bookingRow.id,
  });
  const companyName = bookingRow.business_name || "Chauffeur";
  const vehicleType = bookingRow.vehicle_type || bookingRow.vehicle_slot_id || "Private ride";
  const customerName = [bookingRow.first_name, bookingRow.last_name].filter(Boolean).join(" ").trim() || "Customer";
  const balanceDueDeadline = bookingRow.start_time
    ? new Date(new Date(bookingRow.start_time).getTime() - (48 * 60 * 60 * 1000)).toISOString()
    : null;

  const session = await createStripeCheckoutSessionForAmount({
    apiKey: paymentProfile.stripeSecretKey,
    amount: balanceDue,
    customerEmail: bookingRow.customer_email || null,
    bookingId: bookingRow.id,
    locationId: bookingRow.location_id || null,
    totalPrice,
    depositAmount: totalPrice,
    depositPercent: 100,
    paymentStatus: "paid_in_full",
    paymentChoice: "balance",
    balanceDueDeadline,
    title: `Rideshare Chauffeur Reservation ${companyName} Balance`,
    description: `${vehicleType} balance payment for ${customerName}`,
    successUrl,
    cancelUrl,
  });

  return session?.url || null;
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
    payment_provider = null,
    booking_confirmed,
      deposit_percent = 0,
      deposit_amount = 0,
      booking_mode = "standard",
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
    `SELECT crm_webhook_url, business_name, maps_api_key, fleet, payment_provider, peak_windows
     FROM profiles
     WHERE location_id = $1`,
    [location_id]
  );
  const profile = profileLookup.rows[0] || {};
  const resolvedPaymentProvider = normalizePaymentProvider(payment_provider || profile.payment_provider);

  let fleetVehicle = null;
  if (await tableExists("fleet_slots")) {
    const fleetLookup = await pool.query(
        `SELECT
           calendar_id,
           name AS vehicle_type,
           NULL AS vehicle_category,
           outbound_buffer_min
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
           NULL AS vehicle_category,
           outbound_buffer_min
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
  const generalBufferMinutes = parseInt(fleetVehicle?.outbound_buffer_min, 10) || BOOKING_BUFFER_MINUTES;
  const additionalTrafficBufferMinutes = getAdditionalTrafficBufferMinutes({
    peakWindows: safeParseJson(profile.peak_windows),
    bookingMode: booking_mode || "standard",
    startTime: start_time,
    vehicleType: fleetVehicle?.vehicle_type || "",
  });
  const bookingDurationMinutes = routeMetrics.durationMinutes + generalBufferMinutes + additionalTrafficBufferMinutes;
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
  let calendarSync = null;

  if (isBookingConfirmed && booking_id) {
    try {
      const crmEventId = await syncConfirmedBookingCalendarEvent(booking_id);
      calendarSync = {
        attempted: true,
        success: Boolean(crmEventId),
        crm_event_id: crmEventId || null,
      };
    } catch (calendarErr) {
      console.error("CRM calendar sync error during booking creation:", calendarErr);
      calendarSync = {
        attempted: true,
        success: false,
        error: calendarErr?.message || "CRM calendar sync failed.",
      };
    }
  }

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
        payment_provider: resolvedPaymentProvider,
      },
      meta: {
        source: "booking_widget",
        payment_provider: resolvedPaymentProvider,
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
    business_name: profile.business_name || null,
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
      balance_due,
      payment_provider: resolvedPaymentProvider,
    },
    calendar_sync: calendarSync,
    meta: {
      created_at: new Date().toISOString(),
      source: "booking_widget",
      route_distance_miles: routeMetrics.distanceMiles,
        route_duration_minutes: routeMetrics.durationMinutes,
        booking_buffer_minutes: generalBufferMinutes + additionalTrafficBufferMinutes,
        booking_duration_minutes: bookingDurationMinutes,
      timing_source: routeMetrics.source
    }
  };
}

app.post("/api/create-checkout-session", async (req, res) => {
  let bookingId = null;
  try {
    const paymentProfile = await getPaymentProfileForLocation(req.body.location_id);
    const paymentProvider = paymentProfile.provider;
    const locationId = req.body.location_id;
    const vehicleSlotId = req.body.vehicle_slot_id;

    const returnUrl = sanitizeReturnUrl(req.body.return_url, req);
    const totalPrice = Number(req.body.total_price || 0);
    const minimumDepositAmount = Number(req.body.deposit_amount || 0);
    const depositPercent = Number(req.body.deposit_percent || 0);
    const hoursUntilRide = getHoursUntilRide(req.body.start_time);
    const depositEligible = hoursUntilRide >= 72 && minimumDepositAmount > 0 && minimumDepositAmount < totalPrice;
    const requestedChoice = String(req.body.payment_choice || "deposit").toLowerCase();
    const payInFull = !depositEligible || requestedChoice === "full";
    const amountToCharge = payInFull ? totalPrice : minimumDepositAmount;
    const confirmedDepositAmount = payInFull ? totalPrice : minimumDepositAmount;
    const paymentStatus = payInFull ? "paid_in_full" : "paid_deposit";
    const balanceDueDeadline = req.body.start_time
      ? new Date(new Date(req.body.start_time).getTime() - (48 * 60 * 60 * 1000)).toISOString()
      : null;

    if (!amountToCharge || amountToCharge < 0.5) {
      return res.status(400).json({ error: "Charge amount must be at least $0.50." });
    }

    if (!req.body.accepted_terms) {
      return res.status(400).json({ error: "Cancellation and payment terms must be accepted before checkout." });
    }

    const profileLookup = await pool.query(
      `SELECT maps_api_key, fleet, peak_windows
       FROM profiles
       WHERE location_id = $1
       LIMIT 1`,
      [locationId]
    );
    const profile = profileLookup.rows[0] || {};

    let fleetVehicle = null;
    if (await tableExists("fleet_slots")) {
      const fleetLookup = await pool.query(
        `SELECT calendar_id, name AS vehicle_type, NULL AS vehicle_category, outbound_buffer_min
         FROM fleet_slots
         WHERE vehicle_slot_id = $1 AND location_id = $2
         LIMIT 1`,
        [vehicleSlotId, locationId]
      );
      fleetVehicle = fleetLookup.rows[0] || null;
    }

    if (!fleetVehicle && await tableExists("fleet_settings")) {
      const fleetSettingsLookup = await pool.query(
        `SELECT calendar_id, vehicle_slot_id, base_rate, per_mile_rate, NULL AS vehicle_category, outbound_buffer_min
         FROM fleet_settings
         WHERE vehicle_slot_id = $1 AND location_id = $2
         LIMIT 1`,
        [vehicleSlotId, locationId]
      );
      fleetVehicle = fleetSettingsLookup.rows[0]
        ? {
            ...fleetSettingsLookup.rows[0],
            vehicle_type: fleetSettingsLookup.rows[0].vehicle_slot_id,
          }
        : null;
    }

    if (!fleetVehicle) {
      const profileFleet = safeParseJson(profile.fleet);
      fleetVehicle = (Array.isArray(profileFleet) ? profileFleet : []).find(
        (vehicle) => String(vehicle.vehicle_slot_id || "") === String(vehicleSlotId)
      ) || null;
    }

    const routeMetrics = await getRouteMetrics({
      origin: req.body.pickup_address,
      destination: req.body.dropoff_address,
      originLat: req.body.pickup_lat,
      originLng: req.body.pickup_lng,
      destinationLat: req.body.dropoff_lat,
      destinationLng: req.body.dropoff_lng,
      mapsApiKey: profile.maps_api_key || null,
    });
    const generalBufferMinutes = parseInt(fleetVehicle?.outbound_buffer_min, 10) || BOOKING_BUFFER_MINUTES;
    const additionalTrafficBufferMinutes = getAdditionalTrafficBufferMinutes({
      peakWindows: safeParseJson(profile.peak_windows),
      bookingMode: req.body.booking_mode || "standard",
      startTime: req.body.start_time,
      vehicleType: fleetVehicle?.vehicle_type || "",
    });
    const bookingDurationMinutes = routeMetrics.durationMinutes + generalBufferMinutes + additionalTrafficBufferMinutes;
    const calculatedEndTime = new Date(
      new Date(req.body.start_time).getTime() + bookingDurationMinutes * 60000
    ).toISOString();

    if (fleetVehicle?.calendar_id) {
      const calendarEvents = await getCrmCalendarEvents({
        locationId,
        calendarId: fleetVehicle.calendar_id,
        startTime: req.body.start_time,
        endTime: calculatedEndTime,
      });
      const conflictingEvent = findCalendarConflict(
        calendarEvents,
        req.body.start_time,
        calculatedEndTime
      );

      if (conflictingEvent) {
        return res.status(409).json({
          error: "This vehicle is not available for that time. Please call to check other fleet availability. We can add you to the waitlist.",
          waitlist_recommended: true,
          conflict: {
            title: conflictingEvent.title,
            start_time: conflictingEvent.start,
            end_time: conflictingEvent.end,
            calendar_id: fleetVehicle.calendar_id,
          },
        });
      }
    }

    if (paymentProvider !== "stripe") {
      const bookingResult = await createBookingRecord(
        {
          ...req.body,
          booking_confirmed: false,
          payment_status: "unpaid",
          payment_paid: false,
          deposit_paid: false,
          balance_paid: false,
          deposit_amount: minimumDepositAmount,
          payment_provider: paymentProvider,
        },
        { triggerWebhook: true, paymentLink: null }
      );

      bookingId = bookingResult.booking?.id;
      return res.json({
        success: true,
        requires_manual_payment: true,
        booking_id: bookingId,
        payment_provider: paymentProvider,
        payment_status: "unpaid",
        amount_due_now: Number(amountToCharge.toFixed(2)),
        payment_choice: payInFull ? "full" : "deposit",
        deposit_eligible: depositEligible,
        balance_due: Number((totalPrice - confirmedDepositAmount).toFixed(2)),
        balance_due_deadline: balanceDueDeadline,
        message: paymentProvider === "square"
          ? "Square is selected for this account. Your reservation request has been saved and a payment request will be sent to complete the booking."
          : "Your reservation request has been saved and a payment request will be sent to complete the booking.",
        booking: bookingResult.booking,
      });
    }

    if (!paymentProfile.stripeSecretKey) {
      return res.status(500).json({ error: "Stripe is not configured on the backend." });
    }

    const bookingResult = await createBookingRecord(
      {
        ...req.body,
        booking_confirmed: false,
        payment_status: "unpaid",
        payment_paid: false,
        deposit_paid: false,
        balance_paid: false,
        deposit_amount: minimumDepositAmount,
        payment_provider: paymentProvider,
      },
      { triggerWebhook: false }
    );

    bookingId = bookingResult.booking?.id;
    const businessName = bookingResult.booking?.customer?.first_name
      ? `${bookingResult.booking.customer.first_name} ${bookingResult.booking.customer.last_name}`.trim()
      : "Customer";
    const companyName = bookingResult.business_name || "Chauffeur";
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

    const checkoutTitle = payInFull
      ? `Rideshare Chauffeur Reservation ${companyName} Payment`
      : `Rideshare Chauffeur Reservation ${companyName} Deposit`;
    const checkoutActionLabel = payInFull ? "Payment" : "Deposit";

    const session = await createStripeCheckoutSessionForAmount({
      apiKey: paymentProfile.stripeSecretKey,
      amount: amountToCharge,
      customerEmail: req.body.email || null,
      bookingId,
      locationId: req.body.location_id || null,
      totalPrice,
      depositAmount: confirmedDepositAmount,
      depositPercent: payInFull ? 100 : depositPercent,
      paymentStatus,
      paymentChoice: payInFull ? "full" : "deposit",
      balanceDueDeadline,
      title: checkoutTitle,
      description: `${vehicleType} ${checkoutActionLabel.toLowerCase()} for ${businessName}`,
      successUrl,
      cancelUrl,
    });

    return res.json({
      success: true,
      checkout_url: session.url,
      booking_id: bookingId,
      payment_status: paymentStatus,
      amount_due_now: Number(amountToCharge.toFixed(2)),
      payment_choice: payInFull ? "full" : "deposit",
      deposit_eligible: depositEligible,
      balance_due: Number((totalPrice - confirmedDepositAmount).toFixed(2)),
      balance_due_deadline: balanceDueDeadline,
      payment_provider: paymentProvider,
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
    const sessionId = String(req.query.session_id || "").trim();
    const locationId = String(req.query.location_id || "").trim() || null;
    const stripeSecretKey = await getStripeSecretKeyForLocation(locationId);
    if (!stripeSecretKey) {
      return res.status(500).json({ error: "Stripe is not configured on the backend." });
    }
    if (!sessionId) {
      return res.status(400).json({ error: "session_id is required." });
    }

    const session = await stripeFormRequest(`/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {}, "GET", stripeSecretKey);
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
    stripe_configured: Boolean(envStripeSecretKey),
    env_key_prefix: envStripeSecretKey ? envStripeSecretKey.slice(0, 7) : null,
    env_key_length: envStripeSecretKey ? envStripeSecretKey.length : 0,
    proxy_env: {
      HTTPS_PROXY: process.env.HTTPS_PROXY || null,
      HTTP_PROXY: process.env.HTTP_PROXY || null,
      ALL_PROXY: process.env.ALL_PROXY || null,
    },
    raw_balance_call: null,
  };

  if (!envStripeSecretKey) {
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
          Authorization: `Bearer ${envStripeSecretKey}`,
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

    let balancePaymentLink = null;
    try {
      balancePaymentLink = await createBalancePaymentLink({
        ...b,
        business_name: p.business_name,
      });
    } catch (balanceLinkError) {
      console.error("Balance payment link generation error:", balanceLinkError);
    }

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
        balance_payment_link: balancePaymentLink,
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
    await ensureProfileEntitlementColumns();
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
const entitlements = buildPlanEntitlements({
  planName: profile.plan_name || "starter",
  addonBrandingUnlocked: profile.addon_branding_unlocked,
  addonFunnelUnlocked: profile.addon_funnel_unlocked,
  addonExtraVehicleCount: profile.addon_extra_vehicle_count,
});
const sanitizedBranding = sanitizeBrandingByEntitlements({
  businessLogo: profile.business_logo,
  brandColorPrimary: profile.brand_color_primary,
  brandColorSecondary: profile.brand_color_secondary,
  brandColorAccent: profile.brand_color_accent,
  widgetTagline: profile.widget_tagline,
  entitlements,
});
const sanitizedFleet = sanitizeFleetByEntitlements(safeParseJson(profile.fleet), entitlements);

res.json({
  location_id: profile.location_id || profile.id,
  plan_name: entitlements.plan_name,
  entitlements,

  business_name: profile.business_name,
  business_logo: sanitizedBranding.business_logo || "",
  brand_color_primary: sanitizedBranding.brand_color_primary || DEFAULT_BRAND_COLORS.primary,
  brand_color_secondary: sanitizedBranding.brand_color_secondary || DEFAULT_BRAND_COLORS.secondary,
  brand_color_accent: sanitizedBranding.brand_color_accent || DEFAULT_BRAND_COLORS.accent,
  widget_tagline: sanitizedBranding.widget_tagline || "",
  maps_api_key: profile.maps_api_key,
  crm_api_key: profile.crm_api_key || "",
  payment_provider: normalizePaymentProvider(profile.payment_provider),
  stripe_secret_key: profile.stripe_secret_key || "",
  square_application_id: profile.square_application_id || "",
  square_access_token: profile.square_access_token || "",
  square_location_id: profile.square_location_id || "",
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

  fleet: sanitizedFleet.map(v => ({
    vehicle_slot_id: v.vehicle_slot_id,
    vehicle_type: v.vehicle_type,
    vehicle_category: v.vehicle_category || null,
    base_rate: parseFloat(v.base_rate) || 0,
    mile_rate: parseFloat(v.mile_rate) || 0,
    deposit_percent: parseFloat(v.deposit_percent) || 0,
    deposit_flat_cents: parseInt(v.deposit_flat_cents) || 0,
    calendar_id: v.calendar_id || null,
    outbound_buffer_min: parseInt(v.outbound_buffer_min, 10) || BOOKING_BUFFER_MINUTES
  })),

  general_buffer_min: sanitizedFleet[0]?.outbound_buffer_min ?? BOOKING_BUFFER_MINUTES,

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
          error: "Pickup is outside this operator's service boundary. If fixed destination is chosen, use the standard selection."
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
    await ensureProfileEntitlementColumns();
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
      const entitlements = buildPlanEntitlements({
        planName: p.plan_name || "starter",
        addonBrandingUnlocked: p.addon_branding_unlocked,
        addonFunnelUnlocked: p.addon_funnel_unlocked,
        addonExtraVehicleCount: p.addon_extra_vehicle_count,
      });
      const sanitizedBranding = sanitizeBrandingByEntitlements({
        businessLogo: p.business_logo,
        brandColorPrimary: p.brand_color_primary,
        brandColorSecondary: p.brand_color_secondary,
        brandColorAccent: p.brand_color_accent,
        widgetTagline: p.widget_tagline,
        entitlements,
      });
      const sanitizedFleet = sanitizeFleetByEntitlements(safeParseJson(p.fleet), entitlements);

      return res.json({
        plan_name: entitlements.plan_name,
        entitlements,
        business_name: p.business_name || "",
        business_logo: sanitizedBranding.business_logo || "",
        brand_color_primary: sanitizedBranding.brand_color_primary || DEFAULT_BRAND_COLORS.primary,
        brand_color_secondary: sanitizedBranding.brand_color_secondary || DEFAULT_BRAND_COLORS.secondary,
        brand_color_accent: sanitizedBranding.brand_color_accent || DEFAULT_BRAND_COLORS.accent,
        widget_tagline: sanitizedBranding.widget_tagline || "",
        maps_api_key: p.maps_api_key,
        maps_key: p.maps_api_key,
        payment_provider: normalizePaymentProvider(p.payment_provider),
        tax_rate: p.tax_rate,
        fleet: sanitizedFleet,
        general_buffer_min: sanitizedFleet[0]?.outbound_buffer_min ?? BOOKING_BUFFER_MINUTES,
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

app.get("/api/bookings/:booking_id/calendar.ics", async (req, res) => {
  try {
    const bookingId = Number(req.params.booking_id || 0);
    if (!Number.isInteger(bookingId) || bookingId <= 0) {
      return res.status(400).send("Invalid booking id.");
    }
    const profileIdColumn = await getProfileIdColumn();

    const result = await pool.query(
      `SELECT
        b.id,
        b.first_name,
        b.last_name,
        b.pickup_address,
        b.dropoff_address,
        b.start_time,
        b.end_time,
        b.vehicle_slot_id,
        p.business_name
       FROM bookings b
       LEFT JOIN profiles p ON p.${profileIdColumn} = b.location_id
       WHERE b.id = $1
       LIMIT 1`,
      [bookingId]
    );

    if (!result.rows.length) {
      return res.status(404).send("Booking not found.");
    }

    const booking = result.rows[0];
    const title = `${booking.business_name || "Chauffeur Deluxe"} Reservation #${booking.id}`;
    const description = [
      [booking.first_name, booking.last_name].filter(Boolean).join(" ").trim() ? `Reservation for ${[booking.first_name, booking.last_name].filter(Boolean).join(" ").trim()}` : null,
      booking.vehicle_slot_id ? `Vehicle Slot: ${booking.vehicle_slot_id}` : null,
      booking.pickup_address ? `Pickup: ${booking.pickup_address}` : null,
      booking.dropoff_address ? `Dropoff: ${booking.dropoff_address}` : null,
    ].filter(Boolean).join("\\n");
    const location = booking.dropoff_address || booking.pickup_address || "";
    const dtStart = formatUtcCalendarStamp(booking.start_time);
    const dtEnd = formatUtcCalendarStamp(booking.end_time);
    const dtStamp = formatUtcCalendarStamp(new Date().toISOString());

    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Rideshare Scheduler//Booking Calendar//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:booking-${booking.id}@rideshare-scheduler`,
      `DTSTAMP:${dtStamp}`,
      `DTSTART:${dtStart}`,
      `DTEND:${dtEnd}`,
      `SUMMARY:${escapeIcsText(title)}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      `LOCATION:${escapeIcsText(location)}`,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");

    res.setHeader("Content-Type", "text/calendar; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename=\"booking-${booking.id}.ics\"`);
    return res.status(200).send(ics);
  } catch (err) {
    console.error("Calendar ICS error:", err);
    return res.status(500).send("Failed to generate calendar file.");
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
