// send-to-ghl.js
import dotenv from "dotenv";
dotenv.config();

const GHL_TRIGGER_URL =
  process.env.GHL_TRIGGER_URL ||
  "https://services.leadconnectorhq.com/hooks/VXE0UY17p7wnxdZ3sOLc/webhook-trigger/Je8HE3oHLu0Moe22PIGt";

async function main() {
  const payload = {
    // flat contact fields (GHL maps these easily)
    first_name: "Christina",
    last_name: "Snowden",
    email: "test@example.com",
    phone: "+15551234567",

    // flat booking fields
    booking_date: "2026-02-10",
    service_id: 1,
    pickup: "LAX",
    dropoff: "Downtown LA",

    // metadata
    source: "rideshare-scheduler-test",
    sent_at: new Date().toISOString(),
  };

  console.log("Sending to:", GHL_TRIGGER_URL);
  console.log("Payload:", payload);

  const resp = await fetch(GHL_TRIGGER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const text = await resp.text();
  console.log("GHL status:", resp.status);
  console.log("GHL response:", text);
}

main().catch((err) => {
  console.error("❌ send-to-ghl failed:", err);
  process.exit(1);
});

