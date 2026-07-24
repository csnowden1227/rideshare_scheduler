(function () {
  const query = new URLSearchParams(window.location.search);
  const locationId = (query.get("location_id") || "mamDGnLGy7zhvZmCPDku").trim();
  const wizardToken = (query.get("token") || "").trim();
  const stripeConnectState = String(query.get("stripe_connect") || "").trim();
  const backendHeaders = wizardToken ? { "X-Setup-Wizard-Token": wizardToken } : {};

  const displayNameEl = document.getElementById("display_name");
  const driverEmailEl = document.getElementById("driver_email");
  const driverCalendarUrlEl = document.getElementById("driver_calendar_url");
  const stripeAccountIdEl = document.getElementById("stripe_account_id");
  const stripeConnectBtn = document.getElementById("stripe_connect_btn");
  const stripeStatusEl = document.getElementById("stripe_status");
  const photoUploadEl = document.getElementById("photo_upload");
  const photoPreviewEl = document.getElementById("photo_preview");
  const photoPlaceholderEl = document.getElementById("photo_placeholder");
  const radiusEl = document.getElementById("service_radius");
  const serviceLatEl = document.getElementById("service_lat");
  const serviceLngEl = document.getElementById("service_lng");
  const saveBtn = document.getElementById("save_btn");
  const previewBtn = document.getElementById("preview_btn");
  const saveStatusEl = document.getElementById("save_status");
  const mapRingEl = document.getElementById("map_ring");

  const vehicleLabels = {
    maybach: { name: "Mercedes-Maybach Sedan", category: "Luxury Sedan", image_url: "/assets/driver-partner-program/luxury-sedan-maybach.png" },
    cts: { name: "Cadillac CTS", category: "Luxury Sedan", image_url: "/assets/driver-partner-program/luxury-sedan-cts.png" },
    escalade: { name: "Cadillac Escalade ESV", category: "Luxury XL SUV", image_url: "/assets/driver-partner-program/luxury-xl-suv-escalade-esv.png" },
    suburban: { name: "Chevrolet Suburban", category: "Luxury XL SUV", image_url: "/assets/driver-partner-program/luxury-xl-suv-suburban.png" },
  };

  const defaultPhotoData = "/assets/driver-partner-program/driver-thumbnail-default.jpg";
  let photoData = defaultPhotoData;

  function initialsFor(value) {
    const parts = String(value || "").trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return "CD";
    return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  }

  function slugify(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "john-smith";
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
      const cards = Array.isArray(data.driver_page_vehicle_cards) ? data.driver_page_vehicle_cards : [];
      if (cards.length) {
        document.querySelectorAll(".vehicle-toggle").forEach((el) => {
          const enabledCard = cards.find((card) => String(card.vehicle_key || "") === String(el.dataset.vehicleKey || ""));
          if (enabledCard) el.checked = enabledCard.enabled !== false;
        });
      }
      updateMapRing();
    } catch (error) {
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

    radiusEl?.addEventListener("input", updateMapRing);
    stripeConnectBtn?.addEventListener("click", connectStripePayouts);
    saveBtn?.addEventListener("click", saveSetup);
    previewBtn?.addEventListener("click", () => {
      const slug = slugify(displayNameEl?.value || "john-smith");
      const previewUrl = `/driver-partner-page.html?driver_name=${encodeURIComponent(displayNameEl?.value || "Your Name")}&driver_title=${encodeURIComponent("Luxury Chauffeur")}&slug=${encodeURIComponent(`chauffeursdeluxe.com/partner/${slug}`)}${photoData ? `&driver_photo=${encodeURIComponent(photoData)}` : ""}`;
      window.open(previewUrl, "_blank", "noopener,noreferrer");
    });
  }

  renderPhotoPreview(photoData);
  applyStripeConnectState();
  updateMapRing();
  bindEvents();
  loadProfile();
})();
