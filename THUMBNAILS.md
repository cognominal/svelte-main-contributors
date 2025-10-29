# Thumbnail generation

## Overview

The application generates PNG thumbnails from SVG contribution charts
for display in the UI thumbnail strip. Thumbnails are created
client-side using browser Canvas API and stored as data URLs.

## Implementation

### Primary file

**File:** [src/routes/+page.svelte][page-impl]

The thumbnail generation is implemented in the `captureThumbnail()`
function (lines 824-912).

### Technology stack

- **SVG** - Source format for charts
- **Canvas 2D Context** - Rasterization engine
- **XMLSerializer** - Converts DOM SVG to string
- **Blob API** - Creates object URLs for image loading
- **Data URLs** - Storage format (base64-encoded PNG)

## Generation process

The thumbnail generation process involves 8 steps:

### Step 1: Extract SVG from DOM

```typescript
const svg = host.querySelector("svg");
const bbox = svg.getBoundingClientRect();
const viewBox = svg.viewBox?.baseVal;
```

Queries the chart card container for the SVG element and retrieves its
dimensions from either the viewBox attribute or bounding box.

**Fallback dimensions:** 800×400 pixels if no valid dimensions found.

### Step 2: Calculate target dimensions

```typescript
const scale = Math.min(1, 240 / sourceWidth);
const targetWidth = Math.max(1, Math.round(sourceWidth * scale));
const targetHeight = Math.max(1, Math.round(sourceHeight * scale));
```

Scales the thumbnail to fit within 240px width while maintaining aspect
ratio. The thumbnail is never upscaled (scale ≤ 1).

### Step 3: Clone SVG and embed styles

```typescript
const clone = svg.cloneNode(true) as SVGElement;
clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
clone.setAttribute("viewBox", `0 0 ${sourceWidth} ${sourceHeight}`);

// Add white background
const background = document.createElementNS(
  "http://www.w3.org/2000/svg",
  "rect"
);
background.setAttribute("x", "0");
background.setAttribute("y", "0");
background.setAttribute("width", `${sourceWidth}`);
background.setAttribute("height", `${sourceHeight}`);
background.setAttribute("fill", "#ffffff");
clone.insertBefore(background, clone.firstChild);

// Embed CSS styles directly in the SVG
const style = document.createElementNS(
  "http://www.w3.org/2000/svg",
  "style"
);
style.textContent = `
  .chart-bg { fill: rgba(0, 0, 0, 0.03); }
  .axis line { stroke: #444; stroke-width: 1; }
  .axis text { fill: #333; font-family: system-ui, sans-serif;
               font-size: 12px; }
  .axis .grid { stroke: rgba(0, 0, 0, 0.06); }
  .series path { fill: none; stroke-width: 2; }
  .series circle { stroke: #fff; stroke-width: 1; }
  .axis-label { fill: #444; font-family: system-ui, sans-serif;
                font-size: 12px; font-weight: 500;
                letter-spacing: 0.04em; text-transform: uppercase; }
  .legend text { fill: #333; font-family: system-ui, sans-serif;
                 font-size: 13px; }
  .legend-item rect { cursor: pointer; }
`;
clone.insertBefore(style, background.nextSibling);
```

**Key features:**
- Deep clones the SVG to avoid modifying the original
- Sets proper xmlns attribute for standalone SVG
- Adds viewBox if missing
- **Injects white background rectangle as first child**
- **Embeds CSS rules in a `<style>` element** (critical for
  serialization)

**Why embed styles?**
When using `XMLSerializer`, CSS class names are preserved but external
CSS rules are not included in the serialized output. Without embedded
styles, elements with classes like `class="chart-bg"` would render with
browser defaults (often black fills). Embedding a `<style>` element
ensures all visual properties survive serialization.

**Why white background?**
The app supports dark mode, but thumbnails always use white backgrounds
for consistency and better visibility in the UI thumbnail strip.

### Step 4: Serialize SVG to blob

```typescript
const serializer = new XMLSerializer();
const source = serializer.serializeToString(clone);
const svgBlob = new Blob([source], {
  type: "image/svg+xml;charset=utf-8"
});
const url = URL.createObjectURL(svgBlob);
```

Converts the SVG DOM element to a string and creates a blob URL for
image loading.

### Step 5: Load SVG as image

```typescript
const image = new Image();
image.decoding = "async";
image.crossOrigin = "anonymous";
image.src = url;
await loadPromise;
```

Creates an Image element and waits for it to load asynchronously.
Uses `crossOrigin="anonymous"` to avoid CORS issues.

### Step 6: Render to canvas

```typescript
const canvas = document.createElement("canvas");
canvas.width = targetWidth;
canvas.height = targetHeight;
const context = canvas.getContext("2d");

context.fillStyle = backgroundColor;
context.fillRect(0, 0, targetWidth, targetHeight);
context.scale(scale, scale);
context.drawImage(image, 0, 0, sourceWidth, sourceHeight);
```

**Rendering steps:**
1. Create canvas with target dimensions
2. Fill canvas with white background
3. Scale context by calculated scale factor
4. Draw image at source dimensions (scaling happens via context)

### Step 7: Export as PNG data URL

```typescript
const dataUrl = canvas.toDataURL("image/png");
thumbnailUrls[index] = dataUrl;
thumbnailStatus[index] = "ready";
```

Converts canvas to base64-encoded PNG data URL and stores in reactive
state.

### Step 8: Cleanup

```typescript
finally {
  URL.revokeObjectURL(url);
}
```

Revokes the object URL to free memory.

## State management

### Reactive state

```typescript
let thumbnailUrls = $state<Array<string | null>>([]);
let thumbnailStatus = $state<Array<
  "idle" | "pending" | "ready" | "error"
>>([]);
```

**Thumbnail URLs:** Array of PNG data URLs (one per chart)

**Thumbnail status:** Tracks generation state per thumbnail:
- `"idle"` - Not yet generated
- `"pending"` - Generation in progress
- `"ready"` - Successfully generated
- `"error"` - Generation failed

### Automatic generation

Thumbnails are generated automatically via Svelte `$effect` (lines
914-928):

```typescript
$effect(() => {
  filteredSummaries;
  chartCardElements;
  (async () => {
    await tick();
    for (let index = 0; index < filteredSummaries.length; index += 1) {
      if (
        thumbnailStatus[index] === "idle" &&
        chartCardElements[index]
      ) {
        thumbnailStatus[index] = "pending";
        await captureThumbnail(index);
      }
    }
  })();
});
```

**Trigger conditions:**
- When `filteredSummaries` changes (new charts loaded)
- When `chartCardElements` changes (DOM updated)
- Only generates thumbnails with status "idle"
- Processes one thumbnail at a time sequentially

## UI display

**Location:** Thumbnail strip at bottom of page (lines 1739-1767)

**Dimensions:**
- Container: 9.5rem × 6rem (152px × 96px)
- Image: `object-fit: contain` (maintains aspect ratio)

**Features:**
- Shows "Pending..." for pending thumbnails
- Shows "Error" for failed thumbnails
- Active state: blue border for selected chart
- Hover effects: subtle brightness change
- Smooth transitions

## Server-side SVG generation

**File:** [src/lib/server/svgChart.ts][svgchart-impl]

The server generates base SVG charts with white backgrounds:

```xml
<rect width="100%" height="100%" fill="#fff" />
```

**Key differences from thumbnails:**
- Server generates full-size SVG (960×540px default)
- No canvas conversion (pure SVG output)
- No thumbnails generated server-side

## Performance characteristics

| Aspect | Measurement |
|--------|-------------|
| **Generation time** | ~50-200ms per thumbnail |
| **Canvas dimensions** | Typically 240px wide × proportional |
|                       | height |
| **PNG file size** | ~5-15KB per data URL (base64) |
| **Memory overhead** | ~10-30KB per thumbnail in memory |
| **Concurrency** | Sequential (one at a time) |

## Error handling

```typescript
try {
  // ... generation code
} catch (error) {
  thumbnailStatus[index] = "error";
  console.error("Failed to capture thumbnail", error);
}
```

**Common failure scenarios:**
- SVG element not found in DOM
- Invalid dimensions (zero/negative/non-finite)
- Image load failure
- Canvas context unavailable

## Debugging

### Check thumbnail status

Open browser console and inspect state:

```javascript
// In Svelte DevTools or console
thumbnailStatus; // ["ready", "ready", "error", ...]
thumbnailUrls; // ["data:image/png;base64,...", ...]
```

### Verify SVG structure

```javascript
const svg = document.querySelector("svg");
console.log(svg.viewBox.baseVal); // { x, y, width, height }
console.log(svg.getBoundingClientRect()); // DOMRect
```

### Download thumbnail for inspection

```javascript
const dataUrl = thumbnailUrls[0];
const link = document.createElement("a");
link.href = dataUrl;
link.download = "thumbnail.png";
link.click();
```

## Maintenance

### Clearing thumbnails

Thumbnails are regenerated automatically when:
- New repository data is loaded
- Chart elements are re-rendered
- Status is reset to "idle"

### Forcing regeneration

```typescript
// Reset all statuses to idle to trigger regeneration
thumbnailStatus = thumbnailStatus.map(() => "idle");
```

## Historical context

### Black/dark background issues (fixed)

**Issue 1: Dark backgrounds from theme (initial fix)**

**Problem:** Thumbnails inherited dark backgrounds from app theme in
dark mode.

**Root cause:** The `resolveBackgroundColor()` function walked up the
DOM tree and found dark backgrounds from parent elements when dark mode
was active (see [src/app.postcss][app-css] lines 42-74).

**Solution:** Force white background for all thumbnails regardless of
theme (line 880 in +page.svelte).

**Issue 2: Black backgrounds from CSS serialization (final fix)**

**Problem:** Thumbnails still had completely black chart areas even
after forcing white backgrounds.

**Root cause:** The ContributionChart component uses CSS classes (like
`class="chart-bg"`) to style SVG elements. When `XMLSerializer`
serializes the SVG, it preserves class names but not the actual CSS
rules. Elements rendered with browser defaults (black fills, no
strokes).

**Solution:** Embed a `<style>` element directly in the cloned SVG with
all necessary CSS rules before serialization (lines 869-882 in
+page.svelte). This ensures the styles travel with the SVG.

**Initial failed approach:** Tried to inline computed styles using
`getComputedStyle()`, but this copied default/fallback values and
created more problems.

**Key lesson:** When serializing SVG for rendering outside the original
DOM context, embed a `<style>` element with all necessary CSS rules.
This is cleaner and more reliable than inlining computed styles.

[page-impl]: src/routes/+page.svelte#L824-L912
[svgchart-impl]: src/lib/server/svgChart.ts#L151
[app-css]: src/app.postcss#L42-L74
