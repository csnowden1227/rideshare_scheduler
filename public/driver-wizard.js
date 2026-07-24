(function () {
  const scriptTag = document.currentScript;
  const src = new URL(scriptTag.src, window.location.href);
  const loc = src.searchParams.get("loc") || src.searchParams.get("location_id") || src.searchParams.get("locationId") || "";
  const mode = src.searchParams.get("mode") || "live";
  const hourlyOnly = src.searchParams.get("hourly_only") || "true";
  const widgetScript = document.createElement("script");
  const base = scriptTag.src.replace(/\/driver-wizard(?:\.js)?(?:\?.*)?$/i, "");
  widgetScript.src = `${base}/widget.js?loc=${encodeURIComponent(loc)}&mode=${encodeURIComponent(mode)}&hourly_only=${encodeURIComponent(hourlyOnly)}`;
  widgetScript.async = true;
  document.head.appendChild(widgetScript);
})();
