(function () {
  const scriptTag = document.currentScript;
  const params = new URL(scriptTag.src).searchParams;
  const locationId = params.get("loc");
  const widgetMode = String(params.get("mode") || "live").toLowerCase() === "practice" ? "practice" : "live";
  const BACKEND_URL = scriptTag.src.split("/widget.js")[0];
  const rootId = "chauffeur-booking-widget";

  const state = {
    config: null,
    quote: null,
    route: null,
    places: {
      pickup: null,
      dropoff: null,
    },
  };

  function currentPageUrl() {
    try {
      const url = new URL(window.location.href);
      ["checkout", "session_id", "booking_id"].forEach((key) => url.searchParams.delete(key));
      url.hash = "";
      return url.toString();
    } catch {
      return window.location.href;
    }
  }

  function isPracticeMode() {
    return widgetMode === "practice";
  }

  function money(value) {
    return `$${Number(value || 0).toFixed(2)}`;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function getRoot() {
    return document.getElementById(rootId) || scriptTag.parentElement;
  }

  function toNumber(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function getDayLabel(date) {
    return ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][date.getDay()];
  }

  function haversineMiles(lat1, lng1, lat2, lng2) {
    const toRad = (deg) => (deg * Math.PI) / 180;
    const earthRadiusMiles = 3958.8;
    const dLat = toRad(lat2 - lat1);
    const dLng = toRad(lng2 - lng1);
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return earthRadiusMiles * c;
  }

  function getConfigTaxRate() {
    return toNumber(state.config?.tax_rate ?? state.config?.financials?.tax_rate, 0);
  }

  function getBrandColors() {
    const plan = String(state.config?.plan_name || "starter").toLowerCase();
    if (plan === "pro") {
      return {
        primary: state.config?.brand_color_primary || "#082f49",
        secondary: state.config?.brand_color_secondary || "#0f766e",
        accent: state.config?.brand_color_accent || "#ecfeff",
        heroText: "#ffffff",
        heroMuted: "rgba(255,255,255,.88)",
        heroPanel: "rgba(255,255,255,.16)",
        heroBorder: "rgba(255,255,255,.18)",
        heroBackground: null,
      };
    }

    return {
      primary: "#0f172a",
      secondary: "#0f766e",
      accent: "#e5e7eb",
      heroText: "#0f172a",
      heroMuted: "#475569",
      heroPanel: "#f3f4f6",
      heroBorder: "#d1d5db",
      heroBackground: "#e5e7eb",
    };
  }

  function isProPlan() {
    return String(state.config?.plan_name || "starter").toLowerCase() === "pro";
  }

  function getBusinessLogo() {
    return state.config?.business_logo || "";
  }

  function getProfileDepositDefaults() {
    return {
      percent: toNumber(state.config?.financials?.default_deposit_percent, 0),
      flatCents: toNumber(state.config?.financials?.default_deposit_flat_cents, 0),
    };
  }

  function getPaymentProvider() {
    return String(state.config?.payment_provider || "stripe").toLowerCase();
  }

  function providerSupportsDirectCheckout() {
    return getPaymentProvider() === "stripe";
  }

  function selectedVehicle() {
    const slotId = document.getElementById("cd_vehicle_slot_id")?.value;
    return (state.config?.fleet || []).find((vehicle) => vehicle.vehicle_slot_id === slotId) || null;
  }

  function selectedAddonDetails() {
    const selectedIds = Array.from(document.querySelectorAll('input[name="cd_addons"]:checked'))
      .map((input) => input.value);
    if (!selectedIds.length) return [];
    return (state.config?.addons || []).filter((addon, index) => selectedIds.includes(addon.id || `addon_${index}`));
  }

  function selectedAddons() {
    return selectedAddonDetails().map((addon, index) => addon.id || `addon_${index}`);
  }

  function selectedPaymentChoice() {
    return document.querySelector('input[name="cd_payment_choice"]:checked')?.value || "full";
  }

  function eventByName(name) {
    if (!name) return null;
    return (state.config?.events || []).find((event) => event.event_name === name) || null;
  }

  function selectedBookingMode() {
    return document.getElementById("cd_booking_mode")?.value || "standard";
  }

  function fixedRateByName(name) {
    if (!name) return null;
    return (state.config?.fixed_rates || []).find((zone) => {
      const label = zone.location_name || zone.route_name || "";
      return label === name;
    }) || null;
  }

  function fixedRateLabel(zone) {
    return zone?.location_name || zone?.route_name || "";
  }

  function matchesPeakWindow(windowConfig, startDate) {
    const dayName = getDayLabel(startDate);
    const day = (windowConfig.day || "Everyday").toLowerCase();
    const isWeekday = startDate.getDay() >= 1 && startDate.getDay() <= 5;
    const isWeekend = startDate.getDay() === 0 || startDate.getDay() === 6;

    const dayMatch =
      day === "everyday" ||
      (day === "weekdays" && isWeekday) ||
      (day === "weekends" && isWeekend) ||
      day === dayName.toLowerCase();

    if (!dayMatch) return false;

    const timeValue = startDate.toTimeString().slice(0, 5);
    const start = windowConfig.start_time || "00:00";
    const end = windowConfig.end_time || "23:59";

    if (start <= end) return timeValue >= start && timeValue <= end;
    return timeValue >= start || timeValue <= end;
  }

  function getPeakMultiplier(startDate) {
    const windows = Array.isArray(state.config?.peak_windows) ? state.config.peak_windows : [];
    let multiplier = 1;

    windows.forEach((windowConfig) => {
      if (matchesPeakWindow(windowConfig, startDate)) {
        multiplier = Math.max(multiplier, toNumber(windowConfig.multiplier, 1));
      }
    });

    return multiplier;
  }

  function getFixedSurcharge(startDate, vehicle = null) {
    const windows = Array.isArray(state.config?.peak_windows) ? state.config.peak_windows : [];
    let surcharge = 0;
    const selectedVehicleType = String(vehicle?.vehicle_type || "").trim().toLowerCase();

    windows.forEach((windowConfig) => {
      const windowVehicleType = String(windowConfig.vehicle_type || "").trim().toLowerCase();
      const vehicleMatches = !windowVehicleType || windowVehicleType === selectedVehicleType;
      if (vehicleMatches && matchesPeakWindow(windowConfig, startDate)) {
        surcharge = Math.max(
          surcharge,
          toNumber(windowConfig.fixed_surcharge ?? windowConfig.flat_surcharge, 0)
        );
      }
    });

    return surcharge;
  }

  function resolveFixedRate(route, selectedName = "", vehicle = null) {
    const fixedRates = Array.isArray(state.config?.fixed_rates) ? state.config.fixed_rates : [];
    const pickup = route.pickupCoords;
    const dropoff = route.dropoffCoords;
    const touchingZones = fixedRates.filter((zone) => {
      const lat = toNumber(zone.lat, NaN);
      const lng = toNumber(zone.lng, NaN);
      const radius = toNumber(zone.radius, 0);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || radius <= 0) return false;
      if (selectedName && fixedRateLabel(zone) !== selectedName) return false;

      const pickupDistance = haversineMiles(pickup.lat, pickup.lng, lat, lng);
      const dropoffDistance = haversineMiles(dropoff.lat, dropoff.lng, lat, lng);
      return pickupDistance <= radius || dropoffDistance <= radius;
    });

    return touchingZones[0] || null;
  }

  function isWithinServiceArea(route) {
    const centerLat = toNumber(state.config?.service_lat, NaN);
    const centerLng = toNumber(state.config?.service_lng, NaN);
    const radius = toNumber(state.config?.service_radius, 0);

    if (!Number.isFinite(centerLat) || !Number.isFinite(centerLng) || radius <= 0) return true;

    const pickupDistance = haversineMiles(route.pickupCoords.lat, route.pickupCoords.lng, centerLat, centerLng);
    return pickupDistance <= radius;
  }

  async function loadConfig() {
    const res = await fetch(`${BACKEND_URL}/api/get-profile-widget/${locationId}`);
    if (!res.ok) throw new Error("Failed to load booking config");
    state.config = await res.json();

    const mapsKey = String(state.config.maps_api_key || "").trim();
    if (!mapsKey) return;

    const existing = document.getElementById("cd-google-maps");
    const existingKey = existing?.dataset?.mapsKey || "";
    const shouldReloadScript = Boolean(existing && existingKey && existingKey !== mapsKey);

    if (shouldReloadScript) {
      existing.remove();
      window.google = undefined;
    }

    if (!window.google && !document.getElementById("cd-google-maps")) {
      const script = document.createElement("script");
      script.id = "cd-google-maps";
      script.dataset.mapsKey = mapsKey;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(mapsKey)}&libraries=places,geometry`;
      script.async = true;
      document.head.appendChild(script);
    }
  }

  function initAutocomplete() {
    if (!window.google?.maps?.places) return;

    const pickup = document.getElementById("cd_pickup");
    const dropoff = document.getElementById("cd_dropoff");
    if (!pickup || !dropoff) return;

    const pickupAutocomplete = new google.maps.places.Autocomplete(pickup, { types: ["address"] });
    const dropoffAutocomplete = new google.maps.places.Autocomplete(dropoff, { types: ["address"] });

    pickupAutocomplete.addListener("place_changed", () => {
      state.places.pickup = pickupAutocomplete.getPlace();
    });

    dropoffAutocomplete.addListener("place_changed", () => {
      state.places.dropoff = dropoffAutocomplete.getPlace();
    });
  }

  async function waitForGoogleMaps() {
    if (!state.config?.maps_api_key) return;

    await new Promise((resolve, reject) => {
      const started = Date.now();
      const check = setInterval(() => {
        if (window.google?.maps?.places) {
          clearInterval(check);
          resolve();
        } else if (Date.now() - started > 10000) {
          clearInterval(check);
          reject(new Error("Google Maps failed to load"));
        }
      }, 100);
    });
  }

  function renderAddonOptions() {
    const addons = Array.isArray(state.config?.addons) ? state.config.addons : [];

    if (!addons.length) {
      return `<div style="font-size:13px;color:#64748b;padding:10px 0;">No add-on services configured yet.</div>`;
    }

    const options = addons.map((addon, index) => {
      const id = addon.id || `addon_${index}`;
      const desc = escapeHtml(addon.description || `Service ${index + 1}`);
      const price = money(addon.price || 0);
      const type = addon.type === "per_person" ? "Per person" : "Per booking";
      return `
        <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 0;border-bottom:1px solid #e2e8f0;cursor:pointer;">
          <input type="checkbox" name="cd_addons" value="${escapeHtml(id)}" style="margin-top:3px;width:16px;height:16px;" />
          <span style="display:grid;gap:2px;min-width:0;">
            <span style="font-size:13px;font-weight:700;color:#0f172a;">${desc}</span>
            <span style="font-size:12px;color:#64748b;">${price} (${escapeHtml(type)})</span>
          </span>
        </label>
      `;
    }).join("");

    return `
      <div style="display:grid;gap:8px;">
        <span style="display:block;font-size:12px;font-weight:700;color:#334155;">Select all that apply</span>
        <div style="border:1px solid #cbd5e1;border-radius:14px;background:#fff;padding:0 14px;max-height:220px;overflow:auto;">
          ${options}
        </div>
      </div>
    `;
  }

  function renderEventSelect() {
    const events = Array.isArray(state.config?.events) ? state.config.events : [];
    if (!events.length) return "";

    const options = [
      `<option value="">Select event</option>`,
      ...events.map((event) => {
        const label = `${event.event_name || "Special Event"}${event.event_date ? ` - ${event.event_date}` : ""}`;
        return `<option value="${escapeHtml(event.event_name || "")}">${escapeHtml(label)}</option>`;
      }),
    ];

    return `
      <div id="cd_event_select_inner">
        <label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Select Event</label>
        <select id="cd_special_event" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;">
          ${options.join("")}
        </select>
      </div>
    `;
  }

  function renderFixedDestinationSelect() {
    const fixedRates = Array.isArray(state.config?.fixed_rates) ? state.config.fixed_rates : [];
    if (!fixedRates.length) return "";

    const uniqueLabels = Array.from(
      new Set(
        fixedRates
          .map((zone) => zone.location_name || zone.route_name || "")
          .filter(Boolean)
      )
    );

    const options = [
      `<option value="">Select fixed destination</option>`,
      ...uniqueLabels.map((label) => `<option value="${escapeHtml(label)}">${escapeHtml(label)}</option>`),
    ];

    return `
      <div id="cd_fixed_destination_wrap" style="display:none;">
        <label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Select Destination</label>
        <select id="cd_fixed_destination" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;">
          ${options.join("")}
        </select>
      </div>
    `;
  }

  function updateBookingModeUI() {
    const mode = selectedBookingMode();
    const eventWrap = document.getElementById("cd_event_wrap");
    const fixedWrap = document.getElementById("cd_fixed_destination_wrap");
    const eventSelect = document.getElementById("cd_special_event");
    const fixedSelect = document.getElementById("cd_fixed_destination");

    if (eventWrap) eventWrap.style.display = mode === "event" ? "block" : "none";
    if (fixedWrap) fixedWrap.style.display = mode === "fixed" ? "block" : "none";

    if (mode !== "event" && eventSelect) eventSelect.value = "";
    if (mode !== "fixed" && fixedSelect) fixedSelect.value = "";
  }

  function render() {
    const root = getRoot();
    const fleet = Array.isArray(state.config?.fleet) ? state.config.fleet : [];
    const colors = getBrandColors();
    const proPlan = isProPlan();
    const businessLogo = getBusinessLogo();
    const tagline = state.config?.widget_tagline || "Luxury airport transfers, executive rides, and premium service tailored to every reservation.";
    const vehicleOptions = fleet.map((vehicle) =>
      `<option value="${escapeHtml(vehicle.vehicle_slot_id)}">${escapeHtml(vehicle.vehicle_type || vehicle.name || vehicle.vehicle_slot_id)}</option>`
    ).join("");
    const eventSelect = renderEventSelect();
    const fixedDestinationSelect = renderFixedDestinationSelect();
    const serviceRadius = toNumber(state.config?.service_radius, 0);
    const addonTitle = "Addons (car seat, wheelchair, food & beverage, etc)";

    root.innerHTML = `
      <div style="max-width:1080px;margin:0 auto;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;color:#0f172a;">
        <style>
          #${rootId}, #${rootId} * { box-sizing: border-box; }
          @media (max-width: 767px) {
            #${rootId} #cd_main_grid,
            #${rootId} #cd_name_grid,
            #${rootId} #cd_contact_grid,
            #${rootId} #cd_vehicle_grid,
            #${rootId} #cd_datetime_grid,
            #${rootId} #cd_success_grid {
              grid-template-columns: 1fr !important;
            }
            #${rootId} #cd_luggage_grid {
              grid-template-columns: 1fr 1fr !important;
            }
            #${rootId} #cd_hero_panel {
              padding: 20px !important;
            }
            #${rootId} #cd_hero_header {
              flex-direction: column !important;
              align-items: center !important;
            }
            #${rootId} #cd_logo_wrap {
              min-width: 0 !important;
              width: 100% !important;
              justify-content: center !important;
            }
            #${rootId} #cd_logo_wrap img {
              max-width: 140px !important;
              max-height: 80px !important;
            }
            #${rootId} #cd_actions_col {
              align-content: stretch !important;
            }
          }
          @media (max-width: 520px) {
            #${rootId} #cd_luggage_grid {
              grid-template-columns: 1fr !important;
            }
          }
        </style>
        <div style="background:${proPlan ? `linear-gradient(135deg,${escapeHtml(colors.primary)} 0%,${escapeHtml(colors.secondary)} 52%,${escapeHtml(colors.accent)} 100%)` : escapeHtml(colors.heroBackground)};padding:28px;border-radius:28px;box-shadow:0 30px 60px rgba(15,23,42,.18);overflow:hidden;">
          <div id="cd_hero_panel" style="background:${escapeHtml(colors.heroPanel)};${proPlan ? "backdrop-filter:blur(8px);" : ""}border:1px solid ${escapeHtml(colors.heroBorder)};border-radius:24px;padding:26px;color:${escapeHtml(colors.heroText)};">
            <div id="cd_hero_header" style="display:flex;align-items:flex-start;justify-content:space-between;gap:18px;">
              <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;min-height:150px;">
                <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:10px;">
                  <div style="font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.18em;opacity:.85;">Premium Booking Console</div>
                  ${isPracticeMode() ? `<div style="padding:6px 12px;border-radius:999px;background:${proPlan ? "rgba(255,255,255,.16)" : "#ffffff"};border:1px solid ${escapeHtml(colors.heroBorder)};font-size:10px;font-weight:900;text-transform:uppercase;letter-spacing:.16em;">Practice Mode</div>` : ``}
                </div>
                <h2 style="margin:6px 0 0;font-size:32px;line-height:1.1;font-weight:900;">${escapeHtml(state.config?.business_name || "Luxury Ride Reservations")}</h2>
                <p style="margin:18px 0 0;font-size:15px;line-height:1.6;max-width:580px;color:${escapeHtml(colors.heroMuted)};">
                ${escapeHtml(tagline)}
                </p>
              </div>
              <div id="cd_logo_wrap" style="display:flex;justify-content:flex-end;min-width:120px;">
                ${businessLogo ? `<img src="${escapeHtml(businessLogo)}" alt="Business logo" style="max-width:120px;max-height:88px;object-fit:contain;border-radius:16px;background:rgba(255,255,255,.94);padding:10px;border:1px solid ${escapeHtml(colors.heroBorder)};" />` : ``}
              </div>
            </div>
          </div>
          ${proPlan ? "" : `<div style="margin-top:18px;text-align:center;font-size:12px;color:#475569;font-weight:700;">Powered by CRM ONE SOURCE - Your all-in-one digital solution for any business.</div>`}
        </div>

        <div id="cd_main_grid" style="margin-top:20px;display:grid;grid-template-columns:minmax(0,1.45fr) minmax(320px,1fr);gap:22px;">
          <div style="background:#fff;border:1px solid #e2e8f0;border-radius:24px;box-shadow:0 24px 50px rgba(15,23,42,.08);padding:24px;">
            <div style="display:grid;gap:18px;">
              <div>
                <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Passenger Details</div>
                <div id="cd_name_grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">First Name</label><input id="cd_first_name" placeholder="First name" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Last Name</label><input id="cd_last_name" placeholder="Last name" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                </div>
                <div id="cd_contact_grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Email</label><input id="cd_email" type="email" placeholder="Email address" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Phone</label><input id="cd_phone" type="tel" placeholder="Mobile phone" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                </div>
              </div>

              <div>
                <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Trip Setup</div>
                <div id="cd_vehicle_grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Vehicle</label><select id="cd_vehicle_slot_id" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;"><option value="">Select vehicle</option>${vehicleOptions}</select></div>
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Passengers</label><input id="cd_passenger_count" type="number" min="1" value="1" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                </div>
                <div style="display:grid;grid-template-columns:1fr;gap:12px;margin-top:12px;">
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Route Option</label><select id="cd_booking_mode" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;"><option value="standard">Standard Booking</option><option value="fixed">Fixed Destinations</option><option value="event">Events</option></select></div>
                </div>
                <div style="display:grid;grid-template-columns:1fr;gap:12px;margin-top:12px;">
                  <div id="cd_event_wrap" style="display:none;">${eventSelect || ""}</div>
                  ${fixedDestinationSelect}
                </div>
                <div id="cd_datetime_grid" style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px;">
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Pickup Date & Time</label><input id="cd_start_time" type="datetime-local" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                </div>
                <div style="display:grid;grid-template-columns:1fr;gap:12px;margin-top:12px;">
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Pickup Address</label><input id="cd_pickup" placeholder="Street address or airport terminal" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Dropoff Address</label><input id="cd_dropoff" placeholder="Destination address" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                </div>
              </div>

              <div>
                <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Luggage & Special Items</div>
                <div id="cd_luggage_grid" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-top:12px;">
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Carry-On Bags</label><input id="cd_carry_on_count" type="number" min="0" value="0" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Checked Bags</label><input id="cd_checked_bag_count" type="number" min="0" value="0" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
                  <div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Preset Item</label><select id="cd_additional_item_select" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;"><option value="">None</option><option>Instrument</option><option>Stroller</option><option>Car Seat</option><option>Wheelchair</option><option>Golf Clubs</option><option>Cooler</option><option>Custom</option></select></div>
                </div>
                <div style="margin-top:12px;"><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Custom Item / Trip Notes</label><input id="cd_additional_item_custom" placeholder="Anything the chauffeur should prepare for" style="width:100%;padding:13px 14px;border:1px solid #cbd5e1;border-radius:14px;background:#fff;" /></div>
              </div>
            </div>
          </div>

          <div id="cd_actions_col" style="display:grid;gap:18px;align-content:start;">
            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:24px;box-shadow:0 24px 50px rgba(15,23,42,.08);padding:22px;">
              <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">${escapeHtml(addonTitle)}</div>
              <div style="display:grid;gap:10px;margin-top:14px;">${renderAddonOptions()}</div>
            </div>

            <div style="background:#fff;border:1px solid #e2e8f0;border-radius:24px;box-shadow:0 24px 50px rgba(15,23,42,.08);padding:22px;">
              <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Actions</div>
              <div style="margin-top:14px;padding:16px;border-radius:18px;background:#fff7ed;border:1px solid #fed7aa;">
                <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:#9a3412;">Cancellation Terms</div>
                <div style="margin-top:10px;font-size:13px;line-height:1.6;color:#7c2d12;">
                  Bookings made 72 hours or more in advance may secure the reservation with a minimum deposit. Remaining balances are due 48 hours before pickup.
                  Cancellations made 24 to 48 hours before pickup receive a 50% refund. Cancellations made less than 24 hours before pickup are non-refundable.
                </div>
                <label style="display:flex;gap:10px;align-items:flex-start;margin-top:12px;font-size:13px;color:#7c2d12;font-weight:600;cursor:pointer;">
                  <input id="cd_accept_terms" type="checkbox" style="margin-top:3px;width:16px;height:16px;" />
                  <span>I agree to the cancellation and payment terms above.</span>
                </label>
              </div>
              <div style="display:grid;gap:12px;margin-top:14px;">
                <button id="cd_btn_quote" style="padding:15px 18px;border:none;border-radius:16px;background:${escapeHtml(colors.primary)};color:#fff;font-size:15px;font-weight:800;cursor:pointer;">Calculate Smart Quote</button>
              </div>
              <div id="cd_payment_options" style="display:none;margin-top:16px;padding:16px;border-radius:18px;background:#f8fafc;border:1px solid #dbe4f0;">
                <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Payment Choice</div>
                <div style="margin-top:10px;font-size:13px;color:#475569;">For rides booked 72 hours or more in advance, a minimum deposit can secure this reservation. You may also choose to pay in full.</div>
                <div style="display:grid;gap:10px;margin-top:12px;">
                  <label style="display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid #dbe4f0;border-radius:14px;background:#fff;">
                    <input type="radio" name="cd_payment_choice" value="deposit" />
                    <span><strong>Pay minimum deposit now</strong><br><span style="font-size:12px;color:#64748b;">Reserve the slot now and receive an invoice for the balance 48 hours before pickup.</span></span>
                  </label>
                  <label style="display:flex;gap:10px;align-items:flex-start;padding:12px;border:1px solid #dbe4f0;border-radius:14px;background:#fff;">
                    <input type="radio" name="cd_payment_choice" value="full" checked />
                    <span><strong>Pay in full now</strong><br><span style="font-size:12px;color:#64748b;">Complete the entire reservation payment now.</span></span>
                  </label>
                </div>
                <div id="cd_payment_notice" style="margin-top:12px;font-size:12px;color:#475569;"></div>
              </div>
              <div id="cd_summary" style="display:none;margin-top:14px;padding:18px;border-radius:20px;background:#f8fafc;border:1px solid #dbe4f0;">
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><span>Base + Distance</span><strong id="res_quoted_price">$0.00</strong></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><span>Add-Ons</span><strong id="res_addons">$0.00</strong></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><span>Tax</span><strong id="res_tax">$0.00</strong></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><span>Minimum Deposit</span><strong id="res_deposit_amount">$0.00</strong></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><span>Due Now</span><strong id="res_due_now">$0.00</strong></div>
                <div style="display:flex;justify-content:space-between;margin-bottom:10px;"><span>Remaining Balance</span><strong id="res_balance_due">$0.00</strong></div>
                <div style="height:1px;background:#cbd5e1;margin:12px 0;"></div>
                <div style="display:flex;justify-content:space-between;font-size:20px;"><span>Total</span><strong id="res_total">$0.00</strong></div>
                <div id="cd_meta" style="margin-top:12px;font-size:12px;color:#64748b;"></div>
              </div>
              <div id="cd_book_wrap" style="display:none;gap:12px;margin-top:14px;">
                <button id="cd_btn_book" style="padding:15px 18px;border:none;border-radius:16px;background:${escapeHtml(colors.secondary)};color:#fff;font-size:15px;font-weight:800;cursor:pointer;">Confirm & Submit Booking</button>
              </div>
              <div id="cd_error" style="display:none;margin-top:14px;padding:12px 14px;border-radius:14px;background:#fef2f2;color:#991b1b;font-size:14px;border:1px solid #fecaca;"></div>
            </div>
          </div>
        </div>
      </div>
    `;

    document.getElementById("cd_btn_quote").onclick = getQuote;
    document.getElementById("cd_btn_book").onclick = submitBooking;

    document.getElementById("cd_booking_mode")?.addEventListener("change", () => {
      updateBookingModeUI();
      if (state.quote) getQuote();
    });

    document.querySelectorAll('input[name="cd_addons"], #cd_passenger_count, #cd_special_event, #cd_fixed_destination').forEach((input) => {
      input?.addEventListener("change", () => {
        if (state.quote) getQuote();
      });
    });
    document.querySelectorAll('input[name="cd_payment_choice"]').forEach((input) => {
      input?.addEventListener("change", () => {
        if (state.quote) getQuote();
      });
    });

    updateBookingModeUI();
    initAutocomplete();
  }

  function showError(message) {
    const el = document.getElementById("cd_error");
    if (!el) return;
    el.textContent = message;
    el.style.display = "block";
  }

  function clearError() {
    const el = document.getElementById("cd_error");
    if (!el) return;
    el.textContent = "";
    el.style.display = "none";
  }

  function setRouteStatus(message, isError = false) {
    const el = document.getElementById("cd_route_status");
    if (!el) return;
    el.textContent = message;
    el.style.background = isError ? "#fff1f2" : "#f8fafc";
    el.style.borderColor = isError ? "#fecdd3" : "#e2e8f0";
    el.style.color = isError ? "#9f1239" : "#475569";
  }

  function formPayload() {
    return {
      location_id: locationId,
      vehicle_slot_id: document.getElementById("cd_vehicle_slot_id")?.value,
      first_name: document.getElementById("cd_first_name")?.value.trim(),
      last_name: document.getElementById("cd_last_name")?.value.trim(),
      email: document.getElementById("cd_email")?.value.trim(),
      phone: document.getElementById("cd_phone")?.value.trim(),
      pickup_address: document.getElementById("cd_pickup")?.value.trim(),
      dropoff_address: document.getElementById("cd_dropoff")?.value.trim(),
      start_time: document.getElementById("cd_start_time")?.value,
      booking_mode: selectedBookingMode(),
      payment_choice: selectedPaymentChoice(),
      passenger_count: toNumber(document.getElementById("cd_passenger_count")?.value, 1),
      selected_event_name: document.getElementById("cd_special_event")?.value || null,
      selected_fixed_destination: document.getElementById("cd_fixed_destination")?.value || null,
      selected_addons: selectedAddons(),
      accepted_terms: !!document.getElementById("cd_accept_terms")?.checked,
      carry_on_count: toNumber(document.getElementById("cd_carry_on_count")?.value, 0),
      checked_bag_count: toNumber(document.getElementById("cd_checked_bag_count")?.value, 0),
      additional_items_aboard: JSON.stringify({
        preset: document.getElementById("cd_additional_item_select")?.value || "",
        custom: document.getElementById("cd_additional_item_custom")?.value.trim() || "",
      }),
    };
  }

  async function geocodeInput(address, placeKey) {
    const place = state.places[placeKey];
    const location = place?.geometry?.location;

    if (location && typeof location.lat === "function" && typeof location.lng === "function") {
      return {
        lat: location.lat(),
        lng: location.lng(),
        formattedAddress: place.formatted_address || address,
      };
    }

    if (!window.google?.maps?.Geocoder) {
      throw new Error("Maps services are still loading. Please wait a moment and try again.");
    }

    const geocoder = new google.maps.Geocoder();
    const result = await new Promise((resolve, reject) => {
      geocoder.geocode({ address }, (results, status) => {
        if (status === "OK" && results?.[0]) resolve(results[0]);
        else reject(new Error(`Unable to locate ${placeKey} address.`));
      });
    });

    return {
      lat: result.geometry.location.lat(),
      lng: result.geometry.location.lng(),
      formattedAddress: result.formatted_address || address,
    };
  }

  function computeAddonTotal(addons, passengerCount) {
    return addons.reduce((total, addon) => {
      const price = toNumber(addon.price, 0);
      return total + (addon.type === "per_person" ? price * passengerCount : price);
    }, 0);
  }

  function computeDeposit(total, vehicle) {
    const defaults = getProfileDepositDefaults();
    const vehiclePercent = toNumber(vehicle?.deposit_percent, defaults.percent);
    const vehicleFlat = toNumber(vehicle?.deposit_flat_cents, defaults.flatCents) / 100;
    const vehicleBaseRate = toNumber(vehicle?.base_rate, 0);
    const percentDeposit = vehiclePercent > 0 ? total * (vehiclePercent / 100) : 0;
    const depositAmount = Math.max(percentDeposit, vehicleFlat, vehicleBaseRate, 0);

    return {
      depositPercent: vehiclePercent,
      depositAmount: Number(Math.min(depositAmount, total).toFixed(2)),
    };
  }

  function computePaymentPolicy(startDate, total, depositAmount) {
    const hoursUntilRide = (startDate.getTime() - Date.now()) / (1000 * 60 * 60);
    const depositEligible = hoursUntilRide >= 72 && depositAmount > 0 && depositAmount < total;
    const balanceDueDeadline = new Date(startDate.getTime() - (48 * 60 * 60 * 1000));
    return {
      hoursUntilRide,
      depositEligible,
      minimumDueNow: depositEligible ? depositAmount : total,
      balanceDueDeadline: Number.isNaN(balanceDueDeadline.getTime()) ? null : balanceDueDeadline.toISOString(),
    };
  }

  async function buildQuote() {
    const payload = formPayload();
    const vehicle = selectedVehicle();
    if (!vehicle) throw new Error("Select a vehicle first.");
    if (!payload.pickup_address || !payload.dropoff_address || !payload.start_time) {
      throw new Error("Enter pickup, dropoff, and pickup date/time first.");
    }

    const [pickupCoords, dropoffCoords] = await Promise.all([
      geocodeInput(payload.pickup_address, "pickup"),
      geocodeInput(payload.dropoff_address, "dropoff"),
    ]);

    const miles = haversineMiles(
      pickupCoords.lat,
      pickupCoords.lng,
      dropoffCoords.lat,
      dropoffCoords.lng
    );

    const route = {
      pickupCoords,
      dropoffCoords,
      miles: Number(miles.toFixed(2)),
    };

    if (!isWithinServiceArea(route)) {
      throw new Error(`Pickup is outside the configured ${toNumber(state.config?.service_radius, 0)} mile service area.`);
    }

    const startDate = new Date(payload.start_time);
    if (Number.isNaN(startDate.getTime())) throw new Error("Choose a valid pickup date and time.");

    const eventConfig = payload.booking_mode === "event" ? eventByName(payload.selected_event_name) : null;
    const selectedFixedName = payload.booking_mode === "fixed" ? String(payload.selected_fixed_destination || "").trim() : "";
    const matchedFixedRate = payload.booking_mode === "fixed" ? resolveFixedRate(route, selectedFixedName, vehicle) : resolveFixedRate(route, "", vehicle);
    const fixedRate = payload.booking_mode === "fixed" ? matchedFixedRate : null;
    const peakMultiplier = getPeakMultiplier(startDate);
    const fixedSurcharge = getFixedSurcharge(startDate, vehicle);
    const passengerCount = Math.max(1, payload.passenger_count || 1);
    const addons = selectedAddonDetails();
    const addonTotal = computeAddonTotal(addons, passengerCount);

    if (payload.booking_mode === "event" && !eventConfig) {
      throw new Error("Select an event option to continue.");
    }

    if (payload.booking_mode === "fixed") {
      if (!selectedFixedName) {
        throw new Error("Select a fixed destination to continue.");
      }

      const matchedFixedName = fixedRateLabel(matchedFixedRate);
      if (!matchedFixedRate || selectedFixedName !== matchedFixedName) {
        throw new Error(`This trip must touch the ${selectedFixedName} fixed destination geofence.`);
      }
    }

    let baseRate = toNumber(vehicle.base_rate, 0);
    let mileRate = toNumber(vehicle.mile_rate, 0);
    let pricingLabel = `${vehicle.vehicle_type || "Selected vehicle"} standard pricing`;

    if (eventConfig) {
      mileRate = toNumber(eventConfig.mile_rate, mileRate);
      pricingLabel = `${eventConfig.event_name || "Event"} pricing using ${vehicle.vehicle_type || "selected vehicle"} base rate`;
    }

    let rideSubtotal = baseRate + route.miles * mileRate;

    if (fixedRate) {
      rideSubtotal = toNumber(fixedRate.fixed_price, rideSubtotal);
      pricingLabel = `${fixedRate.location_name || "Fixed zone"} flat rate`;
    }

    if (fixedRate && fixedSurcharge > 0) {
      rideSubtotal += fixedSurcharge;
      pricingLabel = `${pricingLabel} + $${fixedSurcharge.toFixed(2)} time-based surcharge`;
    } else if (peakMultiplier > 1) {
      rideSubtotal *= peakMultiplier;
      pricingLabel = `${pricingLabel} with peak multiplier ${peakMultiplier.toFixed(2)}x`;
    }

    const taxAmount = (rideSubtotal + addonTotal) * (getConfigTaxRate() / 100);
    const total = rideSubtotal + addonTotal + taxAmount;
    const deposit = computeDeposit(total, vehicle);
    const paymentPolicy = computePaymentPolicy(startDate, Number(total.toFixed(2)), deposit.depositAmount);
    const paymentChoice = paymentPolicy.depositEligible && payload.payment_choice === "full" ? "full" : (paymentPolicy.depositEligible ? payload.payment_choice : "full");
    const amountDueNow = paymentChoice === "full"
      ? Number(total.toFixed(2))
      : Number(paymentPolicy.minimumDueNow.toFixed(2));
    const balanceDue = Number((Number(total.toFixed(2)) - amountDueNow).toFixed(2));

    state.route = route;
    state.quote = {
      quoted_price: Number(rideSubtotal.toFixed(2)),
      addon_total: Number(addonTotal.toFixed(2)),
      tax_amount: Number(taxAmount.toFixed(2)),
      total: Number(total.toFixed(2)),
      deposit_percent: deposit.depositPercent,
      deposit_amount: deposit.depositAmount,
      deposit_eligible: paymentPolicy.depositEligible,
      payment_choice: paymentChoice,
      amount_due_now: amountDueNow,
      balance_due: balanceDue,
      balance_due_deadline: paymentPolicy.balanceDueDeadline,
      hours_until_ride: paymentPolicy.hoursUntilRide,
      miles: route.miles,
      pricing_label: pricingLabel,
      fixed_rate_name: fixedRate?.location_name || null,
      peak_multiplier: peakMultiplier,
      fixed_surcharge: fixedRate ? fixedSurcharge : 0,
      booking_mode: payload.booking_mode,
    };

    return state.quote;
  }

  function renderQuoteSummary() {
    if (!state.quote) return;

    document.getElementById("res_quoted_price").textContent = money(state.quote.quoted_price);
    document.getElementById("res_addons").textContent = money(state.quote.addon_total);
    document.getElementById("res_tax").textContent = money(state.quote.tax_amount);
    document.getElementById("res_deposit_amount").textContent = money(state.quote.deposit_amount);
    document.getElementById("res_due_now").textContent = money(state.quote.amount_due_now || state.quote.total);
    document.getElementById("res_balance_due").textContent = money(state.quote.balance_due || 0);
    document.getElementById("res_total").textContent = money(state.quote.total);
    document.getElementById("cd_summary").style.display = "block";
    const bookWrap = document.getElementById("cd_book_wrap");
    if (bookWrap) bookWrap.style.display = "grid";
    const metaParts = [`${state.quote.miles.toFixed(2)} miles estimated.`, `${state.quote.pricing_label}.`];
    if (state.quote.balance_due > 0 && state.quote.balance_due_deadline) {
      metaParts.push(`Balance invoice due by ${new Date(state.quote.balance_due_deadline).toLocaleString()}.`);
    } else {
      metaParts.push(`Paid in full at checkout.`);
    }
    document.getElementById("cd_meta").textContent = metaParts.join(" ");

    const paymentOptions = document.getElementById("cd_payment_options");
    const paymentNotice = document.getElementById("cd_payment_notice");
    const depositRadio = document.querySelector('input[name="cd_payment_choice"][value="deposit"]');
    const fullRadio = document.querySelector('input[name="cd_payment_choice"][value="full"]');
    if (paymentOptions && paymentNotice && depositRadio && fullRadio) {
      if (isPracticeMode()) {
        paymentOptions.style.display = "block";
        depositRadio.disabled = true;
        fullRadio.disabled = false;
        fullRadio.checked = true;
        depositRadio.checked = false;
        paymentNotice.textContent = `Practice mode uses your Stripe test key and still runs the full booking confirmation workflow. No live customer charge will be created.`;
      } else if (!providerSupportsDirectCheckout()) {
        paymentOptions.style.display = "block";
        depositRadio.disabled = true;
        fullRadio.disabled = true;
        if (state.quote.deposit_eligible) {
          depositRadio.checked = true;
          paymentNotice.textContent = `This account is set to ${getPaymentProvider() === "square" ? "Square" : "invoice-only"} follow-up. We will save the booking request and send a payment request for the minimum deposit of ${money(state.quote.amount_due_now)} to secure the reservation.`;
        } else {
          fullRadio.checked = true;
          paymentNotice.textContent = `This ride is less than 72 hours away and requires full payment. We will save the booking request and send a payment request for ${money(state.quote.amount_due_now)}.`;
        }
      } else if (state.quote.deposit_eligible) {
        paymentOptions.style.display = "block";
        depositRadio.disabled = false;
        fullRadio.disabled = false;
        if (state.quote.payment_choice === "full") {
          fullRadio.checked = true;
        } else {
          depositRadio.checked = true;
        }
        paymentNotice.textContent = `Deposit bookings must have the remaining balance paid 48 hours before pickup to keep the reservation active. Cancellations 24-48 hours before pickup receive a 50% refund. Cancellations under 24 hours are non-refundable.`;
      } else {
        paymentOptions.style.display = "block";
        fullRadio.checked = true;
        depositRadio.checked = false;
        depositRadio.disabled = true;
        fullRadio.disabled = true;
        paymentNotice.textContent = `This ride is less than 72 hours away, so full payment is required to confirm the reservation.`;
      }
    }

    const notes = [];
    if (state.quote.fixed_rate_name) notes.push(`Fixed-rate zone applied: ${state.quote.fixed_rate_name}.`);
    if (state.quote.fixed_surcharge > 0) {
      notes.push(`Time-based fixed-route surcharge applied: ${money(state.quote.fixed_surcharge)}.`);
    }
    if (state.quote.peak_multiplier > 1 && !state.quote.fixed_rate_name) {
      notes.push(`Peak pricing applied at ${state.quote.peak_multiplier.toFixed(2)}x.`);
    }
    notes.push(
      state.quote.balance_due > 0
        ? `Minimum deposit due today: ${money(state.quote.amount_due_now)}. Remaining balance will be invoiced 48 hours before pickup.`
        : `Full payment due today: ${money(state.quote.amount_due_now)}.`
    );
    setRouteStatus(notes.join(" "));

    const payNow = Number(state.quote.amount_due_now || state.quote.total || 0);
    const button = document.getElementById("cd_btn_book");
    if (button) {
      if (providerSupportsDirectCheckout()) {
        button.textContent = payNow < Number(state.quote.total || 0)
          ? `Pay Deposit & Confirm Booking (${money(payNow)})`
          : `Pay & Confirm Booking (${money(payNow)})`;
      } else {
        button.textContent = payNow < Number(state.quote.total || 0)
          ? `Request Deposit Follow-Up (${money(payNow)})`
          : `Request Booking Follow-Up (${money(payNow)})`;
      }
    }
  }

  function renderSuccess(bookingId, payload, options = {}) {
    const root = getRoot();
    const businessName = state.config?.business_name || "Our Team";
    const colors = getBrandColors();
    const proPlan = isProPlan();
    const successTitle = options.title || "Booking Confirmed";
    const successMessage = escapeHtml(options.message || `${payload.first_name} your reservation has been synced successfully and routed to ${businessName}.`);
    const tracking = options.tracking || null;

    root.innerHTML = `
      <div style="max-width:920px;margin:0 auto;background:#fff;border:1px solid #dbe4f0;border-radius:28px;overflow:hidden;box-shadow:0 30px 60px rgba(15,23,42,.12);font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
        <div style="padding:48px;background:${proPlan ? `linear-gradient(135deg,${escapeHtml(colors.primary)} 0%,${escapeHtml(colors.secondary)} 100%)` : escapeHtml(colors.heroBackground)};color:${escapeHtml(colors.heroText)};text-align:center;">
          ${isPracticeMode() ? `<div style="display:inline-flex;align-items:center;gap:8px;padding:8px 14px;border-radius:999px;background:${proPlan ? "rgba(255,255,255,.18)" : "#ffffff"};border:1px solid ${escapeHtml(colors.heroBorder)};font-size:11px;font-weight:900;letter-spacing:.16em;text-transform:uppercase;margin-bottom:16px;">Practice Mode</div>` : ``}
          <div style="width:86px;height:86px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${proPlan ? "rgba(255,255,255,.16)" : "#ffffff"};margin:0 auto 18px;font-size:38px;border:1px solid ${escapeHtml(colors.heroBorder)};">OK</div>
          <h2 style="margin:0;font-size:34px;font-weight:900;">${escapeHtml(successTitle)}</h2>
          <p style="margin:12px auto 0;max-width:580px;color:${escapeHtml(colors.heroMuted)};font-size:16px;line-height:1.6;">
            ${successMessage}
          </p>
        </div>
        <div style="padding:30px;display:grid;gap:16px;background:#f8fafc;">
          <div style="background:#fff;border:1px solid #dbe4f0;border-radius:22px;padding:22px;">
            <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Reservation Snapshot</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px;font-size:14px;color:#475569;">
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Confirmation ID</strong>#${escapeHtml(bookingId || "Pending")}</div>
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Pickup Time</strong>${escapeHtml(new Date(payload.start_time).toLocaleString())}</div>
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Pickup</strong>${escapeHtml(payload.pickup_address)}</div>
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Dropoff</strong>${escapeHtml(payload.dropoff_address)}</div>
            </div>
          </div>
          ${tracking ? `
          <div style="background:#fff;border:1px solid #dbe4f0;border-radius:22px;padding:22px;">
            <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Tracking Links Ready</div>
            <div style="margin-top:12px;font-size:14px;color:#475569;line-height:1.7;">Open the driver link first, then use the customer link to confirm the same end-to-end tracking experience your workflow will deliver.</div>
            <div style="display:grid;gap:10px;margin-top:14px;">
              <a href="${escapeHtml(tracking.driver_url || "#")}" target="_blank" rel="noopener" style="display:block;padding:14px 16px;border-radius:16px;background:${escapeHtml(colors.primary)};color:#fff;text-decoration:none;font-weight:800;">Open Driver Tracking</a>
              <a href="${escapeHtml(tracking.customer_url || "#")}" target="_blank" rel="noopener" style="display:block;padding:14px 16px;border-radius:16px;background:${escapeHtml(colors.secondary)};color:#fff;text-decoration:none;font-weight:800;">Open Customer Tracking</a>
            </div>
          </div>` : ``}
          <div style="font-size:13px;color:#64748b;text-align:center;">
            ${isPracticeMode()
              ? "Practice booking confirmation is complete. Calendar sync and tracking creation used the same live workflow path."
              : "Confirmation messaging and CRM follow-up are now queued from the synced backend workflow."}
          </div>
          ${proPlan ? "" : `<div style="font-size:12px;color:#475569;text-align:center;font-weight:700;">Powered by CRM ONE SOURCE - Your all-in-one digital solution for any business.</div>`}
        </div>
      </div>
    `;

    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderPendingPayment(bookingId, payload, message) {
    const root = getRoot();
    const businessName = state.config?.business_name || "Our Team";
    const colors = getBrandColors();
    const proPlan = isProPlan();

    root.innerHTML = `
      <div style="max-width:920px;margin:0 auto;background:#fff;border:1px solid #dbe4f0;border-radius:28px;overflow:hidden;box-shadow:0 30px 60px rgba(15,23,42,.12);font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
        <div style="padding:48px;background:${proPlan ? `linear-gradient(135deg,${escapeHtml(colors.primary)} 0%,${escapeHtml(colors.secondary)} 100%)` : escapeHtml(colors.heroBackground)};color:${escapeHtml(colors.heroText)};text-align:center;">
          <div style="width:86px;height:86px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${proPlan ? "rgba(255,255,255,.16)" : "#ffffff"};margin:0 auto 18px;font-size:38px;border:1px solid ${escapeHtml(colors.heroBorder)};">!</div>
          <h2 style="margin:0;font-size:34px;font-weight:900;">Booking Request Saved</h2>
          <p style="margin:12px auto 0;max-width:620px;color:${escapeHtml(colors.heroMuted)};font-size:16px;line-height:1.6;">
            ${escapeHtml(message || `${payload.first_name} your reservation request has been saved. ${businessName} will send your payment request shortly.`)}
          </p>
        </div>
        <div style="padding:30px;display:grid;gap:16px;background:#f8fafc;">
          <div style="background:#fff;border:1px solid #dbe4f0;border-radius:22px;padding:22px;">
            <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${escapeHtml(colors.secondary)};">Reservation Snapshot</div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:14px;font-size:14px;color:#475569;">
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Request ID</strong>#${escapeHtml(bookingId || "Pending")}</div>
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Pickup Time</strong>${escapeHtml(new Date(payload.start_time).toLocaleString())}</div>
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Pickup</strong>${escapeHtml(payload.pickup_address)}</div>
              <div><strong style="display:block;color:#0f172a;margin-bottom:4px;">Dropoff</strong>${escapeHtml(payload.dropoff_address)}</div>
            </div>
          </div>
          <div style="font-size:13px;color:#64748b;text-align:center;">
            Payment follow-up and CRM messaging are now queued from the synced backend workflow.
          </div>
          ${proPlan ? "" : `<div style="font-size:12px;color:#475569;text-align:center;font-weight:700;">Powered by CRM ONE SOURCE - Your all-in-one digital solution for any business.</div>`}
        </div>
      </div>
    `;

    root.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function getQuote() {
    clearError();
    const button = document.getElementById("cd_btn_quote");
    const original = button.textContent;
    button.textContent = "Calculating...";
    button.disabled = true;

    try {
      await buildQuote();
      renderQuoteSummary();
    } catch (error) {
      state.quote = null;
      state.route = null;
      setRouteStatus(error.message || "Unable to calculate quote.", true);
      showError(error.message || "Pricing error.");
    } finally {
      button.textContent = original;
      button.disabled = false;
    }
  }

  async function submitBooking() {
    clearError();
    const payload = formPayload();

    if (!payload.first_name || !payload.last_name || !payload.email || !payload.phone || !payload.start_time) {
      return showError("Please complete first name, last name, email, phone, and pickup date/time.");
    }

    if (!payload.accepted_terms) {
      return showError("Please accept the cancellation and payment terms before continuing.");
    }

    if (!state.quote || !state.route) {
      try {
        await buildQuote();
        renderQuoteSummary();
      } catch (error) {
        return showError(error.message || "Please calculate the quote before confirming the booking.");
      }
    }

    Object.assign(payload, {
      pickup_address: state.route.pickupCoords.formattedAddress || payload.pickup_address,
      dropoff_address: state.route.dropoffCoords.formattedAddress || payload.dropoff_address,
      pickup_lat: state.route.pickupCoords.lat,
      pickup_lng: state.route.pickupCoords.lng,
      dropoff_lat: state.route.dropoffCoords.lat,
      dropoff_lng: state.route.dropoffCoords.lng,
      quoted_price: Number(state.quote.quoted_price || 0),
      addon_total: Number(state.quote.addon_total || 0),
      tax_amount: Number(state.quote.tax_amount || 0),
      total_price: Number(state.quote.total || 0),
      deposit_percent: Number(state.quote.deposit_percent || 0),
      deposit_amount: Number(state.quote.deposit_amount || 0),
      deposit_eligible: !!state.quote.deposit_eligible,
      amount_due_now: Number(state.quote.amount_due_now || state.quote.total || 0),
      hours_until_ride: Number(state.quote.hours_until_ride || 0),
      balance_due_deadline: state.quote.balance_due_deadline || null,
      pricing_label: state.quote.pricing_label || null,
      fixed_rate_name: state.quote.fixed_rate_name || null,
      peak_multiplier: Number(state.quote.peak_multiplier || 1),
      fixed_surcharge: Number(state.quote.fixed_surcharge || 0),
      route_distance_miles: Number(state.quote.miles || state.route.miles || 0),
      route_duration_minutes: Number(state.route.durationMinutes || 0),
      return_url: currentPageUrl(),
      practice_mode: isPracticeMode(),
    });

    const button = document.getElementById("cd_btn_book");
    const original = button.textContent;
    button.textContent = providerSupportsDirectCheckout()
      ? "Redirecting to secure checkout..."
      : "Saving booking request...";
    button.disabled = true;

    try {
      const response = await fetch(`${BACKEND_URL}/api/create-checkout-session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Checkout setup failed.");
      if (data.requires_manual_payment) {
        renderPendingPayment(data.booking_id, payload, data.message);
        return;
      }
      if (!data.checkout_url) throw new Error("Checkout link was not returned.");

      window.location.href = data.checkout_url;
    } catch (error) {
      showError(error.message || "Checkout failed.");
      button.textContent = original;
      button.disabled = false;
    }
  }

  async function handleCheckoutReturn() {
    const url = new URL(window.location.href);
    const checkoutState = url.searchParams.get("checkout");
    const sessionId = url.searchParams.get("session_id");
    const bookingId = url.searchParams.get("booking_id");

    if (!checkoutState) return false;

    if (checkoutState === "cancel") {
      render();
      showError("Checkout was canceled. Your reservation has not been confirmed yet.");
      window.history.replaceState({}, document.title, currentPageUrl());
      return true;
    }

    if (checkoutState === "success" && sessionId) {
      const root = getRoot();
      if (root) {
        root.innerHTML = `
          <div style="max-width:920px;margin:0 auto;padding:28px;background:#fff;border:1px solid #dbe4f0;border-radius:28px;box-shadow:0 24px 50px rgba(15,23,42,.08);font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
            <div style="font-size:12px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:#64748b;">Secure Checkout</div>
            <h2 style="margin:10px 0 0;font-size:28px;color:#0f172a;">Finalizing your reservation...</h2>
            <p style="margin:12px 0 0;color:#475569;">We're verifying your payment and syncing your confirmed booking now.</p>
          </div>
        `;
      }

      const response = await fetch(`${BACKEND_URL}/api/checkout-session-status?session_id=${encodeURIComponent(sessionId)}&location_id=${encodeURIComponent(locationId)}&practice_mode=${isPracticeMode() ? "1" : "0"}`);
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to verify the checkout session.");
      if (!data.paid) throw new Error("Payment has not been completed yet.");

      let tracking = null;
      if (isPracticeMode() && (data.booking?.booking_id || bookingId)) {
        tracking = await fetch(`${BACKEND_URL}/api/tracking/session/create`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            booking_id: Number(data.booking?.booking_id || bookingId),
            location_id: locationId,
          }),
        }).then(async (trackingResponse) => {
          const trackingData = await trackingResponse.json().catch(() => ({}));
          if (!trackingResponse.ok) {
            throw new Error(trackingData.error || "Payment succeeded, but tracking could not be created yet.");
          }
          return trackingData;
        });
      }

      renderSuccess(data.booking?.booking_id || bookingId, {
        first_name: data.reservation?.first_name || "Your",
        pickup_address: data.reservation?.pickup_address || "Payment received",
        dropoff_address: data.reservation?.dropoff_address || "Reservation confirmed",
        start_time: data.reservation?.start_time || new Date().toISOString(),
      }, isPracticeMode() ? {
        title: "Practice Booking Confirmed",
        message: `${data.reservation?.first_name || "Your"} practice reservation is confirmed and the tracking workflow is ready to rehearse.`,
        tracking,
      } : {});
      window.history.replaceState({}, document.title, currentPageUrl());
      return true;
    }

    return false;
  }

  (async function init() {
    try {
      if (!locationId) throw new Error("Missing location id.");
      await loadConfig();
      await waitForGoogleMaps();
      try {
        const handledCheckout = await handleCheckoutReturn();
        if (!handledCheckout) {
          render();
        }
      } catch (checkoutError) {
        console.error("Checkout Return Error:", checkoutError);
        render();
        showError(checkoutError.message || "We couldn't verify the checkout result. Please contact support if your card was charged.");
      }
    } catch (error) {
      console.error("Widget Init Error:", error);
      const root = getRoot();
      if (root) {
        root.innerHTML = `
          <div style="padding:18px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:16px;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
            <strong>Booking widget unavailable:</strong> ${escapeHtml(error.message || "Please try again shortly.")}
          </div>
        `;
      }
    }
  })();
})();
