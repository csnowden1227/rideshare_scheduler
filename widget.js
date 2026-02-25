(function() {
    // 1. Configuration
    const BACKEND_URL = "https://chauffeur.crmonesource.com";

    // 2. Identify the SaaS User (Location ID)
    const scriptTag = document.currentScript;
    const urlParams = new URLSearchParams(scriptTag.src.split('?')[1]);
    const locationId = urlParams.get('loc');

    if (!locationId) {
        console.error("Chauffeur Deluxe Widget: Missing 'loc' parameter.");
        return;
    }

    const container = document.getElementById('chauffeur-booking-widget');
    if (!container) return;

    // 3. Global Variables to store captured data
    let pickupCoords = null;
    let dropoffCoords = null;
    let globalConfig = null;

    async function initWidget() {
        try {
            // Fetch Fleet & Pricing for this specific location
            const response = await fetch(`${BACKEND_URL}/api/get-profile/${locationId}`);
            globalConfig = await response.json();
            
            renderUI();
            setupGoogleAutocomplete();
        } catch (err) {
            console.error("Chauffeur Widget: Failed to load profile.", err);
        }
    }

    function renderUI() {
        // Map the fleet to the dropdown using your tied ID logic
        const vehicleOptions = globalConfig.fleet.map(v => 
            `<option value="${v.vehicle_id}">${v.vehicle_type} - $${v.base_rate} base</option>`
        ).join('');

        container.innerHTML = `
            <div id="cd-widget-wrapper" style="font-family: 'Inter', system-ui, sans-serif; max-width: 450px; border: 1px solid #e5e7eb; padding: 24px; border-radius: 16px; background: #ffffff; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
                <div id="cd-booking-form">
                    <h3 style="margin: 0 0 16px 0; font-size: 20px; color: #111827;">Book Your Chauffeur</h3>
                    
                    <div style="margin-bottom: 12px;">
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">Pickup Address</label>
                        <input type="text" id="cd_pickup" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;" placeholder="123 Luxury Ln, City...">
                    </div>
                    
                    <div style="margin-bottom: 12px;">
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">Dropoff Address</label>
                        <input type="text" id="cd_dropoff" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;" placeholder="Airport, Event, etc...">
                    </div>

                    <div style="margin-bottom: 20px;">
                        <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">Select Vehicle</label>
                        <select id="cd_vehicle_select" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;">
                            ${vehicleOptions}
                        </select>
                    </div>
                    
                    <button id="cd_btn_quote" style="width: 100%; background: #111827; color: #ffffff; padding: 12px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; transition: background 0.2s;">Get Instant Quote</button>
                    
                    <div id="cd_quote_result" style="margin-top: 20px; display: none; padding: 16px; background: #f9fafb; border-radius: 12px; border: 1px solid #f3f4f6;">
                        <div style="display: flex; justify-content: space-between; font-size: 14px; color: #4b5563; margin-bottom: 6px;">
                            <span>Estimated Miles:</span> <span id="cd_res_miles">0</span>
                        </div>
                        <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 20px; color: #111827; border-top: 1px solid #e5e7eb; padding-top: 12px;">
                            <span>Total Price:</span> <span id="cd_res_total">$0.00</span>
                        </div>
                        <button id="cd_btn_confirm" style="width: 100%; background: #2563eb; color: #ffffff; padding: 12px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; margin-top: 16px;">Schedule Ride</button>
                    </div>
                    
                    <p id="cd_msg" style="margin-top: 12px; font-size: 13px; text-align: center; color: #dc2626; display: none;"></p>
                </div>
            </div>
        `;

        document.getElementById('cd_btn_quote').addEventListener('click', getQuote);
        document.getElementById('cd_btn_confirm').addEventListener('click', submitFinalBooking);
    }

    function setupGoogleAutocomplete() {
        const pAuto = new google.maps.places.Autocomplete(document.getElementById('cd_pickup'));
        pAuto.addListener('place_changed', () => {
            const place = pAuto.getPlace();
            if (place.geometry) {
                pickupCoords = `(${place.geometry.location.lat()}, ${place.geometry.location.lng()})`;
            }
        });

        const dAuto = new google.maps.places.Autocomplete(document.getElementById('cd_dropoff'));
        dAuto.addListener('place_changed', () => {
            const place = dAuto.getPlace();
            if (place.geometry) {
                dropoffCoords = `(${place.geometry.location.lat()}, ${place.geometry.location.lng()})`;
            }
        });
    }

    async function getQuote() {
        const pickup = document.getElementById('cd_pickup').value;
        const dropoff = document.getElementById('cd_dropoff').value;
        const vehicleId = document.getElementById('cd_vehicle_select').value;

        if (!pickup || !dropoff) {
            showMessage("Please enter both addresses.");
            return;
        }

        const btn = document.getElementById('cd_btn_quote');
        btn.innerText = "Calculating...";
        
        try {
            const response = await fetch(`${BACKEND_URL}/api/calculate-quote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: locationId,
                    vehicleId: vehicleId,
                    pickup: pickup,
                    dropoff: dropoff
                })
            });
            const data = await response.json();
            
            document.getElementById('cd_res_miles').innerText = data.miles;
            document.getElementById('cd_res_total').innerText = `$${data.total}`;
            document.getElementById('cd_quote_result').style.display = "block";
            document.getElementById('cd_msg').style.display = "none";
        } catch (err) {
            showMessage("Quote error. Please try again.");
        } finally {
            btn.innerText = "Get Instant Quote";
        }
    }

    async function submitFinalBooking() {
        const payload = {
            saas_location_id: locationId,
            vehicle_slot_id: document.getElementById('cd_vehicle_select').value,
            pickup_address: document.getElementById('cd_pickup').value,
            pickup_coords: pickupCoords,
            dropoff_address: document.getElementById('cd_dropoff').value,
            dropoff_coords: dropoffCoords,
            total_price: document.getElementById('cd_res_total').innerText.replace('$', '')
        };

        const response = await fetch(`${BACKEND_URL}/api/create-booking`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (response.ok) alert("Booking Successful!");
    }

    function showMessage(text) {
        const msg = document.getElementById('cd_msg');
        msg.innerText = text;
        msg.style.display = "block";
    }

    initWidget();
})();