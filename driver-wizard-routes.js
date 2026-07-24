function buildDriverConnectStatusUrl(baseUrl, locationId, state = "complete") {
  const url = new URL(`${String(baseUrl || "").replace(/\/+$/, "")}/driver-partner-setup.html`);
  if (locationId) url.searchParams.set("location_id", String(locationId));
  if (state) url.searchParams.set("stripe_connect", String(state));
  return url.toString();
}

async function ensureStripeConnectedAccountForProfile({
  locationId,
  driverEmail = null,
  driverName = null,
  deps,
}) {
  const {
    pool,
    getProfileIdColumn,
    getPaymentProfileForLocation,
    stripeFormRequest,
    ensureProfilePaymentProviderColumns,
  } = deps;

  if (!locationId) {
    throw new Error("location_id is required for Stripe Connect.");
  }

  await ensureProfilePaymentProviderColumns();
  const profileIdColumn = await getProfileIdColumn();
  const profileLookup = await pool.query(
    `SELECT ${profileIdColumn} AS profile_id, business_name, driver_display_name, driver_email, payment_provider, stripe_account_id
     FROM profiles
     WHERE ${profileIdColumn} = $1
     LIMIT 1`,
    [String(locationId)]
  );

  if (!profileLookup.rows.length) {
    throw new Error("Profile not found for Stripe Connect onboarding.");
  }

  const profile = profileLookup.rows[0];
  if (String(profile.stripe_account_id || "").trim()) {
    return {
      profile,
      stripeAccountId: String(profile.stripe_account_id).trim(),
      created: false,
    };
  }

  const paymentProfile = await getPaymentProfileForLocation(locationId);
  if (!paymentProfile.stripeSecretKey) {
    throw new Error("Stripe must be configured before creating driver payout onboarding links.");
  }

  const account = await stripeFormRequest("/v1/accounts", {
    type: "express",
    country: "US",
    email: String(driverEmail || profile.driver_email || "").trim() || undefined,
    "business_profile[name]": String(driverName || profile.driver_display_name || profile.business_name || "").trim() || undefined,
    "capabilities[transfers][requested]": true,
  }, "POST", paymentProfile.stripeSecretKey);

  const stripeAccountId = String(account?.id || "").trim();
  if (!stripeAccountId) {
    throw new Error("Stripe did not return a connected account ID.");
  }

  await pool.query(
    `UPDATE profiles
     SET stripe_account_id = $2,
         updated_at = NOW()
     WHERE ${profileIdColumn} = $1`,
    [String(locationId), stripeAccountId]
  );

  return {
    profile: {
      ...profile,
      stripe_account_id: stripeAccountId,
    },
    stripeAccountId,
    created: true,
  };
}

async function createStripeConnectOnboardingLinkForProfile({
  locationId,
  driverEmail = null,
  driverName = null,
  baseUrl,
  refreshUrl = null,
  returnUrl = null,
  deps,
}) {
  const { getPaymentProfileForLocation, stripeFormRequest } = deps;
  const paymentProfile = await getPaymentProfileForLocation(locationId);
  if (!paymentProfile.stripeSecretKey) {
    throw new Error("Stripe must be configured before creating driver payout onboarding links.");
  }

  const connected = await ensureStripeConnectedAccountForProfile({
    locationId,
    driverEmail,
    driverName,
    deps,
  });
  const resolvedBaseUrl = baseUrl || process.env.PUBLIC_APP_URL || "";
  const resolvedRefreshUrl = refreshUrl || buildDriverConnectStatusUrl(resolvedBaseUrl, locationId, "refresh");
  const resolvedReturnUrl = returnUrl || buildDriverConnectStatusUrl(resolvedBaseUrl, locationId, "complete");

  const link = await stripeFormRequest("/v1/account_links", {
    account: connected.stripeAccountId,
    refresh_url: resolvedRefreshUrl,
    return_url: resolvedReturnUrl,
    type: "account_onboarding",
  }, "POST", paymentProfile.stripeSecretKey);

  return {
    stripe_account_id: connected.stripeAccountId,
    onboarding_url: link?.url || null,
    expires_at: link?.expires_at
      ? new Date(Number(link.expires_at) * 1000).toISOString()
      : null,
    created_account: connected.created,
  };
}

export function registerDriverWizardRoutes(app, deps) {
  app.post("/api/driver-partner/setup", deps.requireWizardToken, async (req, res) => {
    const client = await deps.pool.connect();
    try {
      const locationId = String(req.body.location_id || "").trim();
      if (!locationId) {
        return res.status(400).json({ error: "location_id is required." });
      }

      await deps.ensureProfileDriverPageColumns();
      await deps.ensureProfileServiceAreaColumns();
      await deps.ensureProfilePricingColumns();
      const profileColumns = await deps.getTableColumns("profiles");
      const profileIdColumn = profileColumns.has("location_id") ? "location_id" : "id";

      const displayName = String(req.body.display_name || "").trim();
      const driverEmail = deps.normalizeDriverEmail(req.body.driver_email);
      const driverCalendarUrl = String(req.body.driver_calendar_url || "").trim() || null;
      const stripeAccountId = String(req.body.stripe_account_id || "").trim() || null;
      const driverPhotoData = deps.normalizeImageDataUrl(req.body.driver_photo_data);
      const driverPageVehicleCards = deps.normalizeDriverPageVehicleCards(req.body.driver_page_vehicle_cards || []);
      const serviceLat = req.body.service_lat !== "" && req.body.service_lat != null ? Number(req.body.service_lat) : null;
      const serviceLng = req.body.service_lng !== "" && req.body.service_lng != null ? Number(req.body.service_lng) : null;
      const serviceRadius = req.body.service_radius !== "" && req.body.service_radius != null ? Number(req.body.service_radius) : null;

      await client.query("BEGIN");
      const fieldEntries = [];
      const pushField = (column, value, cast = "") => {
        if (!profileColumns.has(column)) return;
        fieldEntries.push({ column, value, cast });
      };

      pushField(profileIdColumn, locationId);
      pushField("driver_display_name", displayName || null);
      pushField("driver_email", driverEmail || null);
      pushField("driver_calendar_url", driverCalendarUrl);
      pushField("stripe_account_id", stripeAccountId);
      pushField("driver_photo_data", driverPhotoData || null);
      pushField("driver_page_vehicle_cards", JSON.stringify(driverPageVehicleCards), "::jsonb");
      pushField("service_area_type", "radius");
      pushField("service_area_rules", JSON.stringify({ cities: [], counties: [], zips: [] }), "::jsonb");
      pushField("service_lat", Number.isFinite(serviceLat) ? serviceLat : null);
      pushField("service_lng", Number.isFinite(serviceLng) ? serviceLng : null);
      pushField("service_radius", Number.isFinite(serviceRadius) ? serviceRadius : null);
      pushField("service_radius_miles", Number.isFinite(serviceRadius) ? serviceRadius : null);

      const fields = fieldEntries.map((entry) => entry.column);
      const values = fieldEntries.map((entry) => entry.value);
      const placeholders = fieldEntries.map((entry, index) => `$${index + 1}${entry.cast || ""}`);
      const updateAssignments = fields
        .filter((field) => field !== profileIdColumn)
        .map((field) => `${field} = EXCLUDED.${field}`);
      const updateClause = updateAssignments.length ? `DO UPDATE SET ${updateAssignments.join(", ")}` : "DO NOTHING";

      await client.query(
        `INSERT INTO profiles (${fields.join(", ")})
         VALUES (${placeholders.join(", ")})
         ON CONFLICT (${profileIdColumn})
         ${updateClause}`,
        values
      );

      await client.query("COMMIT");

      return res.json({
        success: true,
        location_id: locationId,
        driver_calendar_url: driverCalendarUrl || "",
        stripe_account_id: stripeAccountId || "",
      });
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch (_) {}
      console.error("Driver partner setup save error:", err);
      return res.status(err.statusCode || 500).json({ error: err.message || "Failed to save driver setup." });
    } finally {
      client.release();
    }
  });

  app.post("/api/driver-partner/stripe-connect/onboarding-link", deps.requireWizardToken, async (req, res) => {
    try {
      const locationId = String(req.body.location_id || "").trim();
      if (!locationId) {
        return res.status(400).json({ error: "location_id is required." });
      }

      const baseUrl = deps.getPublicAppUrl(req);
      const profileIdColumn = await deps.getProfileIdColumn();
      const profileLookup = await deps.pool.query(
        `SELECT ${profileIdColumn} AS profile_id, business_name, driver_display_name, driver_email
         FROM profiles
         WHERE ${profileIdColumn} = $1
         LIMIT 1`,
        [locationId]
      );

      if (!profileLookup.rows.length) {
        return res.status(404).json({ error: "Profile not found for this driver setup." });
      }

      const profile = profileLookup.rows[0];
      const link = await createStripeConnectOnboardingLinkForProfile({
        locationId,
        driverEmail: profile.driver_email || null,
        driverName: profile.driver_display_name || profile.business_name || null,
        baseUrl,
        refreshUrl: String(req.body.refresh_url || "").trim() || null,
        returnUrl: String(req.body.return_url || "").trim() || null,
        deps,
      });

      return res.json({
        success: true,
        location_id: locationId,
        stripe_account_id: link.stripe_account_id,
        onboarding_url: link.onboarding_url,
        expires_at: link.expires_at,
        created_account: link.created_account,
      });
    } catch (err) {
      console.error("Driver Stripe Connect onboarding link error:", err);
      return res.status(500).json({ error: err.message || "Failed to create a driver payout onboarding link." });
    }
  });
}
