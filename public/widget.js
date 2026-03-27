(() => {
  const scriptTag = document.currentScript;
  const params = new URL(scriptTag.src).searchParams;
  const locationId = params.get('loc');
  const BACKEND_URL = scriptTag.src.split('/widget.js')[0];
  const rootId = 'chauffeur-booking-widget';

  const state = { config: null, quote: null };

  function money(n) { return `$${Number(n || 0).toFixed(2)}`; }
  function escapeHtml(v) { return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function getRoot() { return document.getElementById(rootId) || scriptTag.parentElement; }

  async function loadConfig() {
    const res = await fetch(`${BACKEND_URL}/api/get-profile/${locationId}`);
    if (!res.ok) throw new Error('Failed to load booking config');
    state.config = await res.json();
    if (state.config.maps_api_key && !window.google && !document.getElementById('cd-google-maps')) {
      const s = document.createElement('script');
      s.id = 'cd-google-maps';
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(state.config.maps_api_key)}&libraries=places&callback=__cdInitAutocomplete`;
      s.async = true;
      window.__cdInitAutocomplete = initAutocomplete;
      document.head.appendChild(s);
    }
  }

  function initAutocomplete() {
    const pickup = document.getElementById('cd_pickup');
    const dropoff = document.getElementById('cd_dropoff');
    if (window.google?.maps?.places) {
      if (pickup) new google.maps.places.Autocomplete(pickup, { types: ['address'] });
      if (dropoff) new google.maps.places.Autocomplete(dropoff, { types: ['address'] });
    }
  }

  function renderAddonOptions() {
    // 1. Safety check for the config structure
    const addons = Array.isArray(state.config?.addons) ? state.config.addons : [];
    
    if (addons.length === 0) {
      return `<div style="font-size:13px;color:#64748b;padding:10px;">No additional services available for this route.</div>`;
    }

    return addons.map((addon, idx) => {
      // 2. Prioritize the Permanent ID, fallback only if absolutely necessary
      const id = addon.id || `addon_${idx}`;
      const desc = escapeHtml(addon.description || `Service ${idx + 1}`);
      const price = money(addon.price || 0);
      const typeLabel = addon.type === 'per_passenger' ? 'Per Person' : 'Flat Rate';
      
      // 3. Check if this specific ID is already in our state.selected_addons array
      const isChecked = state.selected_addons && state.selected_addons.includes(id) ? 'checked' : '';

      return `
        <label style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; padding:12px; border:1px solid ${isChecked ? '#2563eb' : '#e2e8f0'}; border-radius:12px; background:${isChecked ? '#f8fafc' : '#fff'}; cursor:pointer; transition: all 0.2s;">
          <span style="display:flex; gap:10px; align-items:flex-start;">
            <input type="checkbox" 
                   class="cd-addon-check" 
                   data-id="${escapeHtml(id)}" 
                   ${isChecked} 
                   style="margin-top:4px; width:16px; height:16px; accent-color:#2563eb;" 
            />
            <span>
              <span style="display:block; font-weight:600; color:#0f172a; font-size:14px;">${desc}</span>
              <span style="display:block; font-size:11px; color:#64748b; text-transform:uppercase; letter-spacing:0.025em;">${escapeHtml(typeLabel)}</span>
            </span>
          </span>
          <strong style="white-space:nowrap; color:#1e293b; font-size:14px;">${price}</strong>
        </label>
      `.trim();
    }).join('<div style="height:8px;"></div>'); // Adds consistent spacing between items
}

  function renderEventSelect() {
    const events = Array.isArray(state.config?.events) ? state.config.events : [];
    if (!events.length) return '';
    const options = ['<option value="">No special event</option>'].concat(
      events.map((event) => `<option value="${escapeHtml(event.event_name || '')}">${escapeHtml(event.event_name || 'Special Event')}${event.event_date ? ` — ${escapeHtml(event.event_date)}` : ''}</option>`)
    );
    return `<div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Special Event</label><select id="cd_special_event" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;">${options.join('')}</select></div>`;
  }

  function render() {
    const root = getRoot();
    const fleet = Array.isArray(state.config?.fleet) ? state.config.fleet : [];
    const vehicleOptions = fleet.map((v) => `<option value="${escapeHtml(v.vehicle_slot_id)}">${escapeHtml(v.vehicle_type || v.name || v.vehicle_slot_id)}</option>`).join('');
    const logoUrl = state.config?.logo_url || '';
    const eventSelect = renderEventSelect();

    root.innerHTML = `<div style="max-width:820px;margin:0 auto;background:#fff;border:1px solid #e5e7eb;border-radius:20px;overflow:hidden;box-shadow:0 18px 50px rgba(15,23,42,.12);font-family:Inter,Arial,sans-serif;"><div style="padding:24px 26px;background:#0f172a;color:#fff;"><div style="display:flex;align-items:center;gap:14px;">${logoUrl ? `<img src="${escapeHtml(logoUrl)}" alt="Logo" style="width:62px;height:62px;object-fit:cover;border-radius:999px;border:2px solid rgba(255,255,255,.18);" />` : ''}<div><div style="font-size:26px;font-weight:800;letter-spacing:.02em;">${escapeHtml(state.config.business_name || 'Reserve Your Ride')}</div><div style="opacity:.82;margin-top:6px;font-size:13px;">Complete the booking details below and we’ll route the reservation to the correct vehicle slot calendar.</div></div></div></div><div style="padding:24px;display:grid;gap:16px;background:#f8fafc;"><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">First Name</label><input id="cd_first_name" placeholder="First name" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Last Name</label><input id="cd_last_name" placeholder="Last name" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Email</label><input id="cd_email" type="email" placeholder="Email" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Phone</label><input id="cd_phone" type="tel" placeholder="Phone" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Vehicle Type</label><select id="cd_vehicle_slot_id" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;"><option value="">Select vehicle</option>${vehicleOptions}</select></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Pickup Address</label><input id="cd_pickup" placeholder="Pickup address" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Dropoff Address</label><input id="cd_dropoff" placeholder="Dropoff address" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Pickup Date & Time</label><input id="cd_start_time" type="datetime-local" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div>${eventSelect || '<div></div>'}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;"># of Carry-On Bags</label><input id="cd_carry_on_count" type="number" min="0" value="0" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;"># of Checked Bags</label><input id="cd_checked_bag_count" type="number" min="0" value="0" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div></div><div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;"><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Additional Items Aboard</label><select id="cd_additional_item_select" style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;"><option value="">Select item</option><option>Instrument</option><option>Stroller</option><option>Car Seat</option><option>Wheelchair</option><option>Golf Clubs</option><option>Cooler</option><option>Custom</option></select></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:6px;">Custom Item / Notes</label><input id="cd_additional_item_custom" placeholder="Instrument, stroller, car seat, etc." style="width:100%;padding:12px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;" /></div></div><div><label style="display:block;font-size:12px;font-weight:700;color:#334155;margin-bottom:8px;">Additional Services</label><div style="display:grid;gap:10px;">${renderAddonOptions()}</div></div><div style="display:flex;gap:12px;"><button id="cd_btn_quote" style="flex:1;padding:14px;border:none;border-radius:12px;background:#111827;color:#fff;font-weight:700;cursor:pointer;">Get Quote</button><button id="cd_btn_book" style="flex:1;padding:14px;border:none;border-radius:12px;background:#2563eb;color:#fff;font-weight:700;cursor:pointer;">Confirm Booking</button></div><div id="cd_error" style="display:none;padding:12px 14px;border-radius:12px;background:#fef2f2;color:#991b1b;font-size:14px;"></div><div id="cd_summary" style="display:none;padding:18px;border-radius:16px;background:#fff;border:1px solid #e2e8f0;"><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Ride Price</span><strong id="res_quoted_price">$0.00</strong></div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Add-On Services</span><strong id="res_addons">$0.00</strong></div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Tax</span><strong id="res_tax">$0.00</strong></div><div style="display:flex;justify-content:space-between;margin-bottom:8px;"><span>Deposit</span><strong id="res_deposit_amount">$0.00</strong></div><div style="display:flex;justify-content:space-between;font-size:19px;"><span>Total</span><strong id="res_total">$0.00</strong></div></div></div></div>`;

    document.getElementById('cd_btn_quote').onclick = getQuote;
    document.getElementById('cd_btn_book').onclick = submitBooking;
    initAutocomplete();
  }

  function showError(message) {
    const el = document.getElementById('cd_error');
    el.textContent = message;
    el.style.display = 'block';
  }
  function clearError() {
    const el = document.getElementById('cd_error');
    el.textContent = '';
    el.style.display = 'none';
  }

  function selectedAddons() {
    const configAddons = Array.isArray(state.config?.addons) ? state.config.addons : [];
    const chosen = [];
    document.querySelectorAll('.cd-addon:checked').forEach((el) => {
      const match = configAddons.find((addon, idx) => String(addon.id || addon.description || `addon_${idx}`) === el.value);
      if (match) chosen.push(match);
    });
    return chosen;
  }

  function formPayload() {
    return {
      location_id: locationId,
      vehicle_slot_id: document.getElementById('cd_vehicle_slot_id').value,
      first_name: document.getElementById('cd_first_name').value.trim(),
      last_name: document.getElementById('cd_last_name').value.trim(),
      email: document.getElementById('cd_email').value.trim(),
      phone: document.getElementById('cd_phone').value.trim(),
      pickup_address: document.getElementById('cd_pickup').value.trim(),
      dropoff_address: document.getElementById('cd_dropoff').value.trim(),
      start_time: document.getElementById('cd_start_time').value,
      selected_event_name: document.getElementById('cd_special_event') ? document.getElementById('cd_special_event').value || null : null,
      selected_addons: selectedAddons(),
      carry_on_count: Number(document.getElementById('cd_carry_on_count').value || 0),
      checked_bag_count: Number(document.getElementById('cd_checked_bag_count').value || 0),
      additional_items_aboard: JSON.stringify({ preset: document.getElementById('cd_additional_item_select').value || '', custom: document.getElementById('cd_additional_item_custom').value.trim() })
    };
  }

  async function getQuote() {
    clearError();
    const payload = formPayload();
    if (!payload.vehicle_slot_id || !payload.pickup_address || !payload.dropoff_address || !payload.start_time) return showError('Select a vehicle, pickup time, pickup address, and dropoff address first.');
    const btn = document.getElementById('cd_btn_quote');
    const original = btn.textContent;
    btn.textContent = 'Calculating...'; btn.disabled = true;
    try {
      const res = await fetch(`${BACKEND_URL}/api/calculate-quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Unable to calculate quote.');
      state.quote = data;
      document.getElementById('res_quoted_price').textContent = money(data.quoted_price);
      document.getElementById('res_addons').textContent = money(data.addon_total);
      document.getElementById('res_tax').textContent = money(data.tax_amount);
      document.getElementById('res_deposit_amount').textContent = money(data.deposit_amount);
      document.getElementById('res_total').textContent = money(data.total);
      document.getElementById('cd_summary').style.display = 'block';
    } catch (error) {
      showError(error.message || 'Pricing error.');
    } finally { btn.textContent = original; btn.disabled = false; }
  }

  async function submitBooking() {
    clearError();
    const payload = formPayload();
    if (!payload.first_name || !payload.last_name || !payload.email || !payload.phone || !payload.start_time) return showError('Please complete first name, last name, email, phone, and pickup date/time.');
    if (!state.quote) return showError('Please calculate the quote before confirming the booking.');
    Object.assign(payload, {
      quoted_price: Number(state.quote.quoted_price || 0),
      total_price: Number(state.quote.total || 0),
      deposit_percent: Number(state.quote.deposit_percent || 0),
      deposit_amount: Number(state.quote.deposit_amount || 0)
    });
    const btn = document.getElementById('cd_btn_book');
    const original = btn.textContent;
    btn.textContent = 'Booking...'; btn.disabled = true;
    try {
      const res = await fetch(`${BACKEND_URL}/api/create-booking`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Booking failed.');
      alert('Booking confirmed.');
      window.location.reload();
    } catch (error) {
      showError(error.message || 'Booking failed.');
    } finally { btn.textContent = original; btn.disabled = false; }
  }

  (async function init() {
    try {
      if (!locationId) throw new Error('Missing location id.');
      await loadConfig();
      render();
    } catch (error) {
      console.error(error);
      const root = getRoot();
      if (root) root.innerHTML = `<div style="padding:16px;color:#991b1b;background:#fef2f2;border:1px solid #fecaca;border-radius:12px;">Booking widget unavailable.</div>`;
    }
  })();
})();
