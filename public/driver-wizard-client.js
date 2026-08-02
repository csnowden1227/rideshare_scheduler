(function () {
  const query = new URLSearchParams(window.location.search);
  const locationId = (query.get("location_id") || "ouXMpSTMKm4kREXw3kzP").trim();
  const demoLocationId = "ouXMpSTMKm4kREXw3kzP";
  const wizardToken = (query.get("token") || "").trim();
  const stripeConnectState = String(query.get("stripe_connect") || "").trim();
  const backendHeaders = wizardToken ? { "X-Setup-Wizard-Token": wizardToken } : {};

  const displayNameEl = document.getElementById("display_name");
  const driverEmailEl = document.getElementById("driver_email");
  const driverCalendarUrlEl = document.getElementById("driver_calendar_url");
  const stripeAccountIdEl = document.getElementById("stripe_account_id");
  const stripeLiveSecretKeyEl = document.getElementById("stripe_live_secret_key");
  const stripeTestSecretKeyEl = document.getElementById("stripe_test_secret_key");
  const stripeConnectBtn = document.getElementById("stripe_connect_btn");
  const stripeStatusEl = document.getElementById("stripe_status");
  const photoUploadEl = document.getElementById("photo_upload");
  const photoPreviewEl = document.getElementById("photo_preview");
  const photoPlaceholderEl = document.getElementById("photo_placeholder");
  const radiusEl = document.getElementById("service_radius");
  const serviceLatEl = document.getElementById("service_lat");
  const serviceLngEl = document.getElementById("service_lng");
  const serviceMapSearchEl = document.getElementById("service_map_search");
  const useLocationBtn = document.getElementById("use_location_btn");
  const saveBtn = document.getElementById("save_btn");
  const previewBtn = document.getElementById("preview_btn");
  const saveStatusEl = document.getElementById("save_status");
  const mapRingEl = document.getElementById("map_ring");
  const mapPreviewEl = document.getElementById("map_preview");
  const autocompleteStatusEl = document.getElementById("autocomplete_status");

  let mapsScriptPromise = null;
  let map = null;
  let marker = null;
  let circle = null;
  let geocoder = null;
  let autocomplete = null;
  let mapReady = false;

  const vehicleLabels = {
    maybach: { name: "Mercedes-Maybach Sedan", category: "Luxury Sedan", image_url: "/assets/driver-partner-program/luxury-sedan-maybach.png" },
    cts: { name: "Cadillac CTS", category: "Luxury Sedan", image_url: "/assets/driver-partner-program/luxury-sedan-cts.png" },
    escalade: { name: "Cadillac Escalade ESV", category: "Luxury XL SUV", image_url: "/assets/driver-partner-program/luxury-xl-suv-escalade-esv.png" },
    suburban: { name: "Chevrolet Suburban", category: "Luxury XL SUV", image_url: "/assets/driver-partner-program/luxury-xl-suv-suburban.png" },
  };

  const defaultPhotoData = "/assets/driver-partner-program/driver-thumbnail-default.jpg";
  let photoData = defaultPhotoData;
  const demoVehicleKeys = new Set(["maybach", "cts", "escalade"]);

  function initialsFor(value) {
    const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "CD";
    return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function slugify(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .join(" ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "first-last";
  }

  function showStatus(message, isError = false) {
    if (!saveStatusEl) return;
    saveStatusEl.textContent = message;
    saveStatusEl.classList.remove("hidden", "error");
    if (isError) saveStatusEl.classList.add("error");
  }

  function showStripeStatus(message, isError = false) {
    if (!stripeStatusEl) return;
    stripeStatusEl.textContent = message;
    stripeStatusEl.classList.toggle("error", Boolean(isError));
  }

  function renderPhotoPreview(src) {
    if (!photoPreviewEl || !photoPlaceholderEl || !displayNameEl) return;
    if (src) {
      photoPreviewEl.src = src;
      photoPreviewEl.classList.remove("hidden");
      photoPlaceholderEl.classList.add("hidden");
    } else {
      photoPlaceholderEl.textContent = initialsFor(displayNameEl.value || "Chauffeur Deluxe");
      photoPlaceholderEl.classList.remove("hidden");
      photoPreviewEl.classList.add("hidden");
    }
  }

  function selectedVehicleCards() {
    return Array.from(document.querySelectorAll(".vehicle-toggle"))
      .map((el) => {
        const meta = vehicleLabels[el.dataset.vehicleKey] || {};
        return {
          vehicle_key: el.dataset.vehicleKey,
          vehicle_name: el.dataset.vehicleName || meta.name || "",
          vehicle_category: el.dataset.vehicleCategory || meta.category || "",
          image_url: el.dataset.imageUrl || meta.image_url || "",
          enabled: el.checked,
        };
      });
  }

  function updateMapRing() {
    if (!radiusEl || !mapRingEl) return;
    const radius = Number(radiusEl.value || 30);
    const scale = Math.max(0.9, Math.min(1.55, radius / 30));
    mapRingEl.style.transform = `scale(${scale})`;
  }

  function setAutocompleteStatus(message, isError = false) {
    if (!autocompleteStatusEl) return;
    autocompleteStatusEl.textContent = message;
    autocompleteStatusEl.classList.toggle("error", Boolean(isError));
  }

  function setMapFromInputs() {
    if (!map || !circle || !marker) return;
    const lat = parseFloat(serviceLatEl?.value);
    const lng = parseFloat(serviceLngEl?.value);
    const radius = parseFloat(radiusEl?.value) || 30;
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;

    const pos = { lat, lng };
    map.setCenter(pos);
    map.setZoom(11);
    marker.setPosition(pos);
    circle.setCenter(pos);
    circle.setRadius(radius * 1609.34);
  }

  function syncInputsFromMap() {
    if (!circle || !marker) return;
    const center = circle.getCenter();
    if (!center) return;
    serviceLatEl.value = center.lat().toFixed(6);
    serviceLngEl.value = center.lng().toFixed(6);
    radiusEl.value = Math.round(circle.getRadius() / 1609.34);
    marker.setPosition(center);
    updateMapRing();
  }

  function moveServiceMapToLocation(lat, lng) {
    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

    if (serviceLatEl) serviceLatEl.value = latitude.toFixed(6);
    if (serviceLngEl) serviceLngEl.value = longitude.toFixed(6);
    if (map) map.setCenter({ lat: latitude, lng: longitude });
    if (marker) marker.setPosition({ lat: latitude, lng: longitude });
    if (circle) circle.setCenter({ lat: latitude, lng: longitude });
    updateMapRing();
  }

  function updateCircleFromInput() {
    if (!circle) {
      updateMapRing();
      return;
    }
    const r = parseFloat(radiusEl?.value || 30) || 30;
    circle.setRadius(r * 1609.34);
    updateMapRing();
  }

  function useCurrentLocation() {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((position) => {
      if (!position?.coords) return;
      moveServiceMapToLocation(position.coords.latitude, position.coords.longitude);
      if (map) {
        map.setZoom(11);
      }
    });
  }

  async function loadGoogleMapsScript(apiKey) {
    const key = String(apiKey || "").trim();
    if (!key) {
      return false;
    }
    if (window.google?.maps) {
      return true;
    }
    if (mapsScriptPromise) {
      return mapsScriptPromise;
    }

    mapsScriptPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-driver-wizard-maps="true"]');
      if (existing) {
        existing.addEventListener("load", () => resolve(true), { once: true });
        existing.addEventListener("error", () => reject(new Error("Google Maps failed to load.")), { once: true });
        return;
      }

      const script = document.createElement("script");
      script.dataset.driverWizardMaps = "true";
      script.async = true;
      script.defer = true;
      script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places,geometry&v=weekly&loading=async&auth_referrer_policy=origin&callback=__cdDriverWizardMapsReady`;
      script.onerror = () => reject(new Error("Google Maps failed to load."));
      window.__cdDriverWizardMapsReady = () => resolve(true);
      document.head.appendChild(script);
    });

    return mapsScriptPromise;
  }

  async function initServiceMap(lat = 34.0522, lng = -118.2437, radiusMiles = 30) {
    if (!window.google?.maps || !mapPreviewEl) return;

    const center = {
      lat: Number(lat) || 34.0522,
      lng: Number(lng) || -118.2437,
    };

    map = new google.maps.Map(mapPreviewEl, {
      center,
      zoom: 10,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      clickableIcons: false,
      gestureHandling: "cooperative",
    });
    geocoder = new google.maps.Geocoder();

    marker = new google.maps.Marker({
      position: center,
      map,
      draggable: true,
    });

    circle = new google.maps.Circle({
      map,
      center,
      radius: (Number(radiusMiles) || 30) * 1609.34,
      fillColor: "#d4af37",
      fillOpacity: 0.18,
      strokeColor: "#b58900",
      strokeOpacity: 0.95,
      strokeWeight: 3,
      visible: true,
      editable: true,
      draggable: true,
      zIndex: 1,
    });

    circle.addListener("center_changed", syncInputsFromMap);
    circle.addListener("radius_changed", syncInputsFromMap);
    marker.addListener("drag", () => {
      if (circle) circle.setCenter(marker.getPosition());
    });

    const attachAutocomplete = () => {
      if (!serviceMapSearchEl || !window.google?.maps?.places?.Autocomplete) {
        setAutocompleteStatus("Address autocomplete unavailable. Manual city or ZIP entry is enabled.", true);
        return;
      }

      if (serviceMapSearchEl.dataset.autocompleteEnhanced === "true") {
        return;
      }

      autocomplete = new google.maps.places.Autocomplete(serviceMapSearchEl, {
        componentRestrictions: { country: "us" },
        fields: ["formatted_address", "geometry", "name", "place_id"],
        types: ["geocode"],
      });
      serviceMapSearchEl.dataset.autocompleteEnhanced = "true";

      autocomplete.addListener("place_changed", () => {
        const place = autocomplete.getPlace();
        const location = place?.geometry?.location;
        if (!location || typeof location.lat !== "function" || typeof location.lng !== "function") {
          return;
        }
        moveServiceMapToLocation(location.lat(), location.lng());
        if (circle) circle.setCenter({ lat: location.lat(), lng: location.lng() });
        if (marker) marker.setPosition({ lat: location.lat(), lng: location.lng() });
      });

      serviceMapSearchEl.addEventListener("keydown", async (event) => {
        if (event.key !== "Enter" || !geocoder) return;
        event.preventDefault();
        const query = String(serviceMapSearchEl.value || "").trim();
        if (!query) return;
        try {
          const response = await geocoder.geocode({ address: query });
          const match = response?.results?.[0];
          const location = match?.geometry?.location;
          if (!location) return;
          moveServiceMapToLocation(location.lat(), location.lng());
          if (circle) circle.setCenter({ lat: location.lat(), lng: location.lng() });
          if (marker) marker.setPosition({ lat: location.lat(), lng: location.lng() });
        } catch (err) {
          console.error("Driver wizard geocode search failed:", err);
        }
      });

      setAutocompleteStatus("Address autocomplete is ready.");
    };

    attachAutocomplete();

    if (radiusEl) {
      radiusEl.addEventListener("input", updateCircleFromInput);
    }
    if (serviceLatEl) {
      serviceLatEl.addEventListener("input", setMapFromInputs);
    }
    if (serviceLngEl) {
      serviceLngEl.addEventListener("input", setMapFromInputs);
    }
    if (useLocationBtn && !useLocationBtn.dataset.bound) {
      useLocationBtn.dataset.bound = "true";
      useLocationBtn.addEventListener("click", useCurrentLocation);
    }

    mapReady = true;
    syncInputsFromMap();
    updateMapRing();
  }

  function applyDemoVehicleDefaults() {
    document.querySelectorAll(".vehicle-toggle").forEach((el) => {
      el.checked = demoVehicleKeys.has(String(el.dataset.vehicleKey || ""));
    });
  }

  function applyStripeConnectState() {
    if (stripeConnectState === "refresh") {
      showStripeStatus("Stripe onboarding session expired or needs to be refreshed.", true);
    } else if (stripeConnectState === "complete") {
      showStripeStatus("Stripe onboarding finished for this driver payout account.");
    }
  }

  async function loadProfile() {
    if (!locationId) return;
    try {
      const url = wizardToken
        ? `/api/get-profile/${encodeURIComponent(locationId)}?token=${encodeURIComponent(wizardToken)}`
        : `/api/get-profile/${encodeURIComponent(locationId)}`;
      const res = await fetch(url, {
        cache: "no-store",
        headers: backendHeaders,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Failed to load profile (${res.status})`);

      displayNameEl.value = data.business_name || "";
      driverEmailEl.value = data.driver_email || "";
      driverCalendarUrlEl.value = data.driver_calendar_url || "";
      stripeAccountIdEl.value = data.stripe_account_id || "";
      if (stripeLiveSecretKeyEl) stripeLiveSecretKeyEl.value = data.stripe_secret_key || "";
      if (stripeTestSecretKeyEl) stripeTestSecretKeyEl.value = data.stripe_test_secret_key || "";
      photoData = data.driver_photo_data || defaultPhotoData;
      renderPhotoPreview(photoData);
      serviceLatEl.value = data.service_lat ?? 29.7604;
      serviceLngEl.value = data.service_lng ?? -95.3698;
      radiusEl.value = data.service_radius ?? 30;
      showStripeStatus(
        data.stripe_account_id
          ? `Stripe payout account linked: ${data.stripe_account_id}`
          : "Stripe payout account not linked yet."
      );
      try {
        const mapsLoaded = await loadGoogleMapsScript(data.maps_api_key || "");
        if (mapsLoaded) {
          await initServiceMap(
            data.service_lat ?? 29.7604,
            data.service_lng ?? -95.3698,
            data.service_radius ?? 30
          );
          if (mapReady) {
            setAutocompleteStatus("Address autocomplete is ready.");
          }
        } else {
          setAutocompleteStatus("Map not available yet. Add a Maps API key to enable search and drag radius controls.", true);
        }
      } catch (mapsError) {
        console.warn("Driver wizard map load failed:", mapsError);
        setAutocompleteStatus("Map failed to load. Check the Maps API key and allowed referrers.", true);
      }
      const cards = Array.isArray(data.driver_page_vehicle_cards) ? data.driver_page_vehicle_cards : [];
      if (cards.length) {
        document.querySelectorAll(".vehicle-toggle").forEach((el) => {
          const enabledCard = cards.find((card) => String(card.vehicle_key || "") === String(el.dataset.vehicleKey || ""));
          if (enabledCard) el.checked = enabledCard.enabled !== false;
        });
      } else if (locationId === demoLocationId) {
        applyDemoVehicleDefaults();
      }
      updateMapRing();
    } catch (error) {
      if (locationId === demoLocationId) {
        applyDemoVehicleDefaults();
        updateMapRing();
        return;
      }
      showStatus(error?.message || "Unable to load profile data.", true);
    }
  }

  async function saveSetup() {
    const displayName = String(displayNameEl?.value || "").trim();
    const driverEmail = String(driverEmailEl?.value || "").trim();
    if (!displayName) {
      showStatus("Please add the public display name first.", true);
      return;
    }
    if (!driverEmail) {
      showStatus("Please add the driver email address.", true);
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
      const payload = {
        location_id: locationId,
        display_name: displayName,
        driver_email: driverEmail,
        driver_calendar_url: String(driverCalendarUrlEl.value || "").trim(),
        stripe_account_id: String(stripeAccountIdEl.value || "").trim(),
        stripe_secret_key: String(stripeLiveSecretKeyEl?.value || "").trim(),
        stripe_test_secret_key: String(stripeTestSecretKeyEl?.value || "").trim(),
        driver_photo_data: photoData || defaultPhotoData,
        driver_page_vehicle_cards: selectedVehicleCards(),
        service_area_rules: { cities: [], counties: [], zips: [] },
        service_lat: serviceLatEl.value,
        service_lng: serviceLngEl.value,
        service_radius: radiusEl.value,
      };

      const res = await fetch("/api/driver-partner/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...backendHeaders,
        },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Save failed (${res.status})`);
      showStatus("Setup saved. The driver's page settings are updated.");
      if (data.stripe_account_id) {
        stripeAccountIdEl.value = data.stripe_account_id;
        showStripeStatus(`Stripe payout account linked: ${data.stripe_account_id}`);
      }
    } catch (error) {
      showStatus(error?.message || "Unable to save setup.", true);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Setup";
    }
  }

  async function connectStripePayouts() {
    if (!stripeConnectBtn) return;
    stripeConnectBtn.disabled = true;
    stripeConnectBtn.textContent = "Connecting...";
    try {
      const res = await fetch("/api/driver-partner/stripe-connect/onboarding-link", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...backendHeaders,
        },
        body: JSON.stringify({
          location_id: locationId,
          refresh_url: `${window.location.origin}${window.location.pathname}?location_id=${encodeURIComponent(locationId)}&stripe_connect=refresh`,
          return_url: `${window.location.origin}${window.location.pathname}?location_id=${encodeURIComponent(locationId)}&stripe_connect=complete`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || `Connect failed (${res.status})`);
      stripeAccountIdEl.value = data.stripe_account_id || "";
      showStripeStatus(
        data.onboarding_url
          ? "Stripe onboarding link opened in a new tab."
          : `Stripe payout account linked: ${data.stripe_account_id || ""}`
      );
      if (data.onboarding_url) {
        window.open(data.onboarding_url, "_blank", "noopener,noreferrer");
      }
    } catch (error) {
      showStripeStatus(error?.message || "Unable to connect Stripe payouts.", true);
    } finally {
      stripeConnectBtn.disabled = false;
      stripeConnectBtn.textContent = "Connect Stripe Payouts";
    }
  }

  function bindEvents() {
    displayNameEl?.addEventListener("input", () => {
      renderPhotoPreview(photoData);
      document.title = `${displayNameEl.value || "Driver Partner Setup"} - Chauffeur Deluxe`;
      const heroTitle = document.querySelector(".hero h1");
      if (heroTitle) {
        heroTitle.textContent = `Build ${displayNameEl.value || "your"} page. Pick your service area. Keep CRM notifications private.`;
      }
      const note = document.querySelector(".hero-note");
      if (note) {
        note.textContent = "Chauffeur Deluxe keeps the webhook, LeadConnector routing, and payment handling on the backend. You only control the public-facing driver page settings here.";
      }
    });

    photoUploadEl?.addEventListener("change", () => {
      const file = photoUploadEl.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        photoData = String(reader.result || "");
        renderPhotoPreview(photoData);
      };
      reader.readAsDataURL(file);
    });

    radiusEl?.addEventListener("input", updateCircleFromInput);
    stripeConnectBtn?.addEventListener("click", connectStripePayouts);
    saveBtn?.addEventListener("click", saveSetup);
    previewBtn?.addEventListener("click", async () => {
      const slug = slugify(displayNameEl?.value || "first-last");
      const previewPayload = {
        driver_name: displayNameEl?.value || "Your Name",
        driver_title: "Luxury Chauffeur",
        location_id: locationId,
        driver_page_slug: slug,
        driver_photo_data: photoData || defaultPhotoData,
      };
      let previewUrl = `https://${encodeURIComponent(slug)}.drivers.chauffeursdeluxe.com/?driver_name=${encodeURIComponent(previewPayload.driver_name)}&driver_title=${encodeURIComponent(previewPayload.driver_title)}&location_id=${encodeURIComponent(previewPayload.location_id)}`;
      try {
        const response = await fetch("/api/driver-preview-sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(previewPayload),
        });
        if (response.ok) {
          const data = await response.json();
          if (data?.preview_url) {
            previewUrl = data.preview_url;
          } else if (data?.token) {
            previewUrl = `https://${encodeURIComponent(slug)}.drivers.chauffeursdeluxe.com/?preview_token=${encodeURIComponent(data.token)}`;
          }
        }
      } catch (err) {
        console.warn("Preview session creation failed, falling back to direct preview URL.", err);
      }
      window.open(previewUrl, "_blank", "noopener,noreferrer");
    });
  }

  renderPhotoPreview(photoData);
  applyStripeConnectState();
  updateMapRing();
  bindEvents();
  loadProfile();
})();
