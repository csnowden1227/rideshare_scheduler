(function() {
    // 1. Configuration - Pointing to your specific Render domain
    const BACKEND_URL = "https://chauffeur.crmonesource.com";

    // 2. Identify the SaaS User (Location ID) from the script parameters
    const scriptTag = document.currentScript;
    const urlParams = new URLSearchParams(scriptTag.src.split('?')[1]);
    const locationId = urlParams.get('loc');

    if (!locationId) {
        console.error("Chauffeur Deluxe Widget: Missing 'loc' parameter in script tag.");
        return;
    }

    // 3. Find the container on the client's website
    const container = document.getElementById('chauffeur-booking-widget');
    if (!container) {
        console.warn("Chauffeur Deluxe Widget: Container #chauffeur-booking-widget not found on page.");
        return;
    }

    // 4. Inject the HTML Structure
    container.innerHTML = `
        <div id="cd-widget-wrapper" style="font-family: 'Inter', system-ui, sans-serif; max-width: 450px; border: 1px solid #e5e7eb; padding: 24px; border-radius: 16px; background: #ffffff; box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);">
            <div id="cd-booking-form">
                <h3 style="margin: 0 0 16px 0; font-size: 20px; color: #111827;">Book Your Chauffeur</h3>
                
                <div style="margin-bottom: 12px;">
                    <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">Pickup Address</label>
                    <input type="text" id="cd_pickup" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;" placeholder="123 Luxury Ln, City...">
                </div>
                
                <div style="margin-bottom: 20px;">
                    <label style="display: block; font-size: 13px; font-weight: 600; color: #374151; margin-bottom: 4px;">Dropoff Address</label>
                    <input type="text" id="cd_dropoff" style="width: 100%; padding: 10px; border: 1px solid #d1d5db; border-radius: 8px; box-sizing: border-box;" placeholder="Airport, Event, etc...">
                </div>
                
                <button id="cd_btn_quote" style="width: 100%; background: #111827; color: #ffffff; padding: 12px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; transition: background 0.2s;">Get Instant Quote</button>
                
                <div id="cd_quote_result" style="margin-top: 20px; display: none; padding: 16px; background: #f9fafb; border-radius: 12px; border: 1px solid #f3f4f6;">
                    <div style="display: flex; justify-content: space-between; font-size: 14px; color: #4b5563; margin-bottom: 6px;">
                        <span>Estimated Miles:</span> <span id="cd_res_miles">0</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 14px; color: #4b5563; margin-bottom: 6px;">
                        <span>Subtotal:</span> <span id="cd_res_subtotal">$0.00</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-size: 14px; color: #4b5563; margin-bottom: 12px;">
                        <span>Tax:</span> <span id="cd_res_tax">$0.00</span>
                    </div>
                    <div style="display: flex; justify-content: space-between; font-weight: 700; font-size: 20px; color: #111827; border-top: 1px solid #e5e7eb; pt-12; padding-top: 12px;">
                        <span>Total Price:</span> <span id="cd_res_total">$0.00</span>
                    </div>
                    <button id="cd_btn_confirm" style="width: 100%; background: #2563eb; color: #ffffff; padding: 12px; border: none; border-radius: 8px; cursor: pointer; font-weight: 600; margin-top: 16px;">Schedule Ride</button>
                </div>
                
                <p id="cd_msg" style="margin-top: 12px; font-size: 13px; text-align: center; color: #dc2626; display: none;"></p>
            </div>
        </div>
    `;

    const pickupInput = document.getElementById('cd_pickup');
    const dropoffInput = document.getElementById('cd_dropoff');
    const quoteBtn = document.getElementById('cd_btn_quote');
    const msg = document.getElementById('cd_msg');
    const resultDiv = document.getElementById('cd_quote_result');

    // 5. Interaction Logic: Get Quote
    quoteBtn.addEventListener('click', async () => {
        const pickup = pickupInput.value;
        const dropoff = dropoffInput.value;

        if (!pickup || !dropoff) {
            showMessage("Please enter both pickup and dropoff addresses.");
            return;
        }

        quoteBtn.innerText = "Calculating...";
        quoteBtn.disabled = true;

        try {
            const response = await fetch(`${BACKEND_URL}/api/calculate-quote`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: locationId,
                    serviceId: 1, // Defaulting to first service for now
                    pickup: pickup,
                    dropoff: dropoff
                })
            });

            const data = await response.json();

            if (data.error) {
                // This captures our "Kill Switch" or "Missing API Key" errors from the backend
                showMessage(data.error);
                resultDiv.style.display = "none";
            } else {
                msg.style.display = "none";
                document.getElementById('cd_res_miles').innerText = data.miles;
                document.getElementById('cd_res_subtotal').innerText = `$${data.subtotal}`;
                document.getElementById('cd_res_tax').innerText = `$${data.tax}`;
                document.getElementById('cd_res_total').innerText = `$${data.total}`;
                resultDiv.style.display = "block";
            }
        } catch (err) {
            showMessage("Unable to connect to booking server. Please call us.");
        } finally {
            quoteBtn.innerText = "Get Instant Quote";
            quoteBtn.disabled = false;
        }
    });

    function showMessage(text) {
        msg.innerText = text;
        msg.style.display = "block";
    }

})();