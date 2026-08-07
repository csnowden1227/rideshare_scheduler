(function () {
  const script = document.currentScript;
  const params = new URL(script?.src || location.href).searchParams;
  const locationId = String(params.get("loc") || "").trim();
  const target = document.getElementById("rental-booking-widget");
  if (!target || !locationId) return;
  const frame = document.createElement("iframe");
  frame.src = `${new URL(script.src).origin}/rental-widget.html?loc=${encodeURIComponent(locationId)}&embed=1`;
  frame.title = "Rental booking";
  frame.loading = "lazy";
  frame.allow = "payment";
  frame.style.cssText = "display:block;width:100%;height:980px;border:0;background:transparent;overflow:hidden";
  target.replaceChildren(frame);
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || event.data?.type !== "rental-widget-height") return;
    frame.style.height = `${Math.max(680, Math.min(2200, Number(event.data.height) || 980))}px`;
  });
})();
