export async function generateThumbnail(host: HTMLElement | null): Promise<string | null> {
  if (!host) {
    return null;
  }
  const svg = host.querySelector("svg");
  if (!(svg instanceof SVGElement)) {
    return null;
  }

  const bbox = svg.getBoundingClientRect();
  const viewBox = svg.viewBox?.baseVal;
  const sourceWidth =
    (viewBox && viewBox.width > 0 ? viewBox.width : bbox.width) || svg.clientWidth || 800;
  const sourceHeight =
    (viewBox && viewBox.height > 0 ? viewBox.height : bbox.height) || svg.clientHeight || 400;

  if (!Number.isFinite(sourceWidth) || !Number.isFinite(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0) {
    return null;
  }

  const scale = Math.min(1, 240 / sourceWidth);
  const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
  const targetHeight = Math.max(1, Math.round(sourceHeight * scale));

  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  if (!clone.getAttribute("viewBox")) {
    clone.setAttribute("viewBox", `0 0 ${sourceWidth} ${sourceHeight}`);
  }
  clone.setAttribute("width", `${sourceWidth}`);
  clone.setAttribute("height", `${sourceHeight}`);

  // Add white background
  const background = document.createElementNS("http://www.w3.org/2000/svg", "rect");
  background.setAttribute("x", "0");
  background.setAttribute("y", "0");
  background.setAttribute("width", `${sourceWidth}`);
  background.setAttribute("height", `${sourceHeight}`);
  background.setAttribute("fill", "#ffffff");
  clone.insertBefore(background, clone.firstChild);

  // Embed CSS styles directly in the SVG so they survive serialization
  const style = document.createElementNS("http://www.w3.org/2000/svg", "style");
  style.textContent = `
    .chart-bg { fill: rgba(0, 0, 0, 0.03); }
    .axis line { stroke: #444; stroke-width: 1; }
    .axis text { fill: #333; font-family: system-ui, sans-serif; font-size: 12px; }
    .axis .grid { stroke: rgba(0, 0, 0, 0.06); }
    .series path { fill: none; stroke-width: 2; }
    .series circle { stroke: #fff; stroke-width: 1; }
    .axis-label { fill: #444; font-family: system-ui, sans-serif; font-size: 12px; font-weight: 500; letter-spacing: 0.04em; text-transform: uppercase; }
    .legend text { fill: #333; font-family: system-ui, sans-serif; font-size: 13px; }
    .legend-item rect { cursor: pointer; }
  `;
  clone.insertBefore(style, background.nextSibling);

  const serializer = new XMLSerializer();
  const source = serializer.serializeToString(clone);
  const svgBlob = new Blob([source], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  try {
    const image = new Image();
    image.decoding = "async";
    image.crossOrigin = "anonymous";
    const loadPromise = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = (event) => reject(new Error("Unable to render SVG thumbnail."));
    });
    image.src = url;
    await loadPromise;

    const canvas = document.createElement("canvas");
    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas context unavailable.");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, targetWidth, targetHeight);
    context.scale(scale, scale);
    context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
    return canvas.toDataURL("image/png");
  } catch (error) {
    console.error("Failed to capture thumbnail", error);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
