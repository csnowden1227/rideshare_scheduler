(function() {
    const BACKEND_URL = "https://rideshare-scheduler-axx6.onrender.com/";
    const scriptTag = document.currentScript;
    const urlParams = new URLSearchParams(scriptTag.src.split('?')[1]);
    const locationId = urlParams.get('loc');

    if (!locationId) return console.error("Chauffeur Widget: Missing 'loc' parameter.");

    const container = document.getElementById('chauffeur-booking-widget');
    if (!container) return;

    let state = { config: null, pickupCoords: null, dropoffCoords: null };

    // --- INITIALIZATION ---
    async function init() {
        try {
            const res = await fetch(`${BACKEND_URL}/api/get-profile/${locationId}`);
            if (!res.ok) throw new Error("Profile not found");
            state.config = await res.json();
            render();
        } catch (err) {
            console.error("Chauffeur Widget Error:", err);
            container.innerHTML = `<p style="color:red; font-size:12px;">Service temporarily unavailable.</p>`;
        }
    }

    // --- UI RENDERING ---
    function render() {
        const fleetOpts = (state.config.fleet || []).map(v => 
            `<option value="${v.vehicle_id}">${v.vehicle_type}</option>`
        ).join('');

        container.innerHTML = `
        <div id="cd-container" style="max-width: 480px; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; font-family: 'Inter', sans-serif; box-shadow: 0 10px 15px -3px rgba(0,0,0,0.1); overflow: hidden;">
            <div style="background: #111827; padding: 20px; color: #fff;">
                <h3 style="margin:0; font-size: 18px;">${state.config.business_name || 'Book Your Chauffeur'}</h3>
            </div>
            
            <div style="padding: 20px;">
                <div style="display: flex; gap: 8px; margin-bottom: 12px;">
                    <input type="text" id="cd_fname" placeholder="First Name" style="width:50%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
                    <input type="text" id="cd_lname" placeholder="Last Name" style="width:50%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
                </div>
                
                <input type="email" id="cd_email" placeholder="Email Address" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; margin-bottom:12px;">

                <input type="text" id="cd_pickup" placeholder="Pickup Address" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; margin-bottom:12px;">
                <input type="text" id="cd_dropoff" placeholder="Dropoff Address" style="width:100%; padding:10px; border:1px solid #d1d5db; border-radius:8px; margin-bottom:12px;">

                <div style="display: flex; gap: 8px; margin-bottom: 20px;">
                    <input type="datetime-local" id="cd_start" style="width:60%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
                    <select id="cd_vehicle_select" style="width:40%; padding:10px; border:1px solid #d1d5db; border-radius:8px;">
                        ${fleetOpts}
                    </select>
                </div>

                <button id="cd_btn_quote" style="width:100%; background:#111827; color:#fff; padding:14px; border:none; border-radius:8px; cursor:pointer; font-weight:600;">Get Instant Quote</button>

                <div id="cd_summary" style="display:none; margin-top:15px; padding:15px; background:#f9fafb; border-radius:10px; border:1px solid #f3f4f6;">
                    <div style="display:flex; justify-content:space-between; margin-bottom:10px;">
                        <span style="color:#6b7280;">Estimated Total:</span>
                        <span style="font-weight:700; font-size:20px;" id="res_total">$0.00</span>
                    </div>
                    <button id="cd_btn_book" style="width:100%; background:#2563eb; color:#fff; padding:12px; border:none; border-radius:8px; cursor:pointer; font-weight:600;">Confirm Booking</button>
                </div>
            </div>
        </div>
        `;

        document.getElementById('cd_btn_quote').onclick = getQuote;
        document.getElementById('cd_btn_book').onclick = submitBooking;
    }

    // --- LOGIC FUNCTIONS ---
    async function getQuote() {
        const pickup = document.getElementById('cd_pickup').value;
        const dropoff = document.getElementById('cd_dropoff').value;

        if(!pickup || !dropoff) return alert("Please enter both pickup and dropoff addresses.");

        const btn = document.getElementById('cd_btn_quote');
        btn.innerText = "Calculating...";
        btn.disabled = true;
        
        try {
            const res = await fetch(`${BACKEND_URL}/api/calculate-quote`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({
                    userId: locationId,
                    vehicleId: document.getElementById('cd_vehicle_select').value,
                    pickup: pickup,
                    dropoff: dropoff
                })
            });
            const data = await res.json();
            
            document.getElementById('res_total').innerText = '$' + (data.total || "0.00");
            document.getElementById('cd_summary').style.display = 'block';
        } catch (err) {
            alert("Error calculating quote. Please try again.");
        } finally {
            btn.innerText = "Get Instant Quote";
            btn.disabled = false;
        }
    }

    async function submitBooking() {
        const email = document.getElementById('cd_email').value;
        const start = document.getElementById('cd_start').value;

        if(!email || !start) return alert("Please provide your email and pickup time.");

        const payload = {
            saas_location_id: locationId,
            vehicle_slot_id: document.getElementById('cd_vehicle_select').value,
            first_name: document.getElementById('cd_fname').value,
            last_name: document.getElementById('cd_lname').value,
            email: email,
            pickup_address: document.getElementById('cd_pickup').value,
            dropoff_address: document.getElementById('cd_dropoff').value,
            start_time: start,
            total_price: document.getElementById('res_total').innerText.replace('$', '')
        };

        try {
            const res = await fetch(`${BACKEND_URL}/api/create-booking`, {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(payload)
            });

            if (res.ok) {
                alert("Booking confirmed! You will receive a notification shortly.");
                document.getElementById('cd_summary').style.display = 'none';
            } else {
                throw new Error("Submission failed");
            }
        } catch (err) {
            alert("Failed to save booking. Please try again.");
        }
    }

    init();
})();