import "dotenv/config";

const locationId = process.argv[2] || process.env.WIDGET_LOCATION_ID || "ouXMpSTMKm4kREXw3kzP";
const baseUrl = process.env.BACKEND_URL || process.env.PUBLIC_BASE_URL || "https://rideshare-scheduler-axx6.onrender.com";
const url = `${baseUrl.replace(/\/$/, "")}/api/get-profile-widget-script/${encodeURIComponent(locationId)}?callback=healthCheck`;

try {
  const response = await fetch(url, { cache: "no-store" });
  const text = await response.text();
  if (!response.ok) {
    console.log(`FAIL: widget script returned ${response.status}`);
    process.exitCode = 1;
    process.exit();
  }

  const match = text.match(/^healthCheck\((.*)\);?$/s);
  if (!match) {
    console.log("FAIL: widget script response is not valid callback JSON");
    process.exitCode = 1;
    process.exit();
  }

  const payload = JSON.parse(match[1]);
  const rows = Array.isArray(payload?.security_services) ? payload.security_services : [];
  if (!rows.length) {
    console.log(`FAIL: no security services returned for ${locationId}`);
    process.exitCode = 1;
    process.exit();
  }

  console.log(`OK: ${rows.length} security services returned for ${locationId}`);
  for (const row of rows) {
    const name = String(row.service_name || row.security_service_name || "Security Service").trim();
    const bundle = Boolean(row.bundle_with_vehicle);
    console.log(`- ${name} [bundle_with_vehicle=${bundle}]`);
  }
} catch (err) {
  console.log(`FAIL: ${err?.message || String(err)}`);
  process.exitCode = 1;
}
