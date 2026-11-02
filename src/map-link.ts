// map-link.ts
// Reading a map location out of what a user pastes: plain coordinates, or a link from Google
// Maps, OpenStreetMap, Yandex Maps, 2GIS, Apple Maps, Bing Maps or a geo: URI. Used by the map
// tab of the insert window (src/insert-modal.ts). No Obsidian imports.

export interface MapPoint {
    lat: number;
    long: number;
    zoom?: number;
}

// Telegram's map zoom range (InputRichBlockMap).
export const MAP_ZOOM_MIN = 0;
export const MAP_ZOOM_MAX = 24;

const NUM = String.raw`[-+]?\d{1,3}(?:\.\d+)?`;

function point(lat: number, long: number, zoom?: number): MapPoint | null {
    if (!Number.isFinite(lat) || !Number.isFinite(long)) return null;
    if (Math.abs(lat) > 90 || Math.abs(long) > 180) return null;
    const result: MapPoint = { lat, long };
    if (zoom !== undefined && Number.isFinite(zoom)) {
        result.zoom = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, Math.round(zoom)));
    }
    return result;
}

// "lat,long" (or "long,lat" when `longFirst`), as map services put it in a query value.
function pair(value: string | null | undefined, longFirst = false, zoom?: number): MapPoint | null {
    const m = new RegExp(String.raw`^\s*(${NUM})\s*[,~]\s*(${NUM})`).exec(value ?? "");
    if (!m) return null;
    const [a, b] = [parseFloat(m[1]), parseFloat(m[2])];
    return longFirst ? point(b, a, zoom) : point(a, b, zoom);
}

function num(value: string | null | undefined): number | undefined {
    if (value === null || value === undefined || value.trim() === "") return undefined;
    const n = parseFloat(value);
    return Number.isFinite(n) ? n : undefined;
}

// Two numbers as written by hand or copied from a map: "41.9028, 12.4964", "41.9028 12.4964",
// "41.9028° N, 12.4964° E" (S and W make a coordinate negative).
function parseCoordinates(input: string): MapPoint | null {
    const part = String.raw`(${NUM})\s*°?\s*([NSEW])?`;
    const m = new RegExp(String.raw`^\s*${part}\s*[,;\s]\s*${part}\s*$`, "i").exec(input);
    if (!m) return null;
    const signed = (value: string, hemisphere?: string) =>
        /^[SW]$/i.test(hemisphere ?? "") ? -Math.abs(parseFloat(value)) : parseFloat(value);
    let lat = signed(m[1], m[2]);
    let long = signed(m[3], m[4]);
    // "12.49° E, 41.90° N": the hemisphere letters say which is which.
    if (/^[EW]$/i.test(m[2] ?? "") && /^[NS]$/i.test(m[4] ?? "")) [lat, long] = [long, lat];
    return point(lat, long);
}

// Links that only redirect to the real address, which can't be read without opening them.
export function isShortMapLink(input: string): boolean {
    return /^\s*(?:https?:\/\/)?(?:maps\.app\.goo\.gl|goo\.gl\/maps|g\.co\/kgs|go\.2gis\.com|yandex\.[a-z]+\/maps\/-\/)/i.test(input);
}

function parseUrl(input: string): MapPoint | null {
    let url: URL;
    try { url = new URL(input.trim()); } catch { return null; }

    if (url.protocol === "geo:") {
        // geo:41.9,12.5?z=15 — the query may also hold a "q=lat,long(label)".
        const [coords, query = ""] = url.href.slice(4).split("?");
        const params = new URLSearchParams(query);
        return pair(coords, false, num(params.get("z"))) ?? pair(params.get("q"), false, num(params.get("z")));
    }

    const host = url.hostname.toLowerCase();
    const params = url.searchParams;
    const path = decodeURIComponent(url.pathname);

    // Yandex Maps: "long,lat" — the pin (pt, whatshere) first, then the view's centre (ll).
    if (/(^|\.)yandex\.[a-z.]+$|(^|\.)ya\.ru$/.test(host)) {
        const zoom = num(params.get("z"));
        return pair(params.get("pt"), true, zoom)
            ?? pair(params.get("whatshere[point]"), true, num(params.get("whatshere[zoom]")) ?? zoom)
            ?? pair(params.get("ll"), true, zoom);
    }

    // 2GIS: m=long,lat/zoom, or a /geo/…/long,lat path.
    if (/(^|\.)2gis\.[a-z]+$/.test(host)) {
        const m = /^\s*([^/]+)(?:\/([\d.]+))?/.exec(params.get("m") ?? "");
        const fromPath = /\/geo\/(?:[^/]+\/)?(-?\d+(?:\.\d+)?,-?\d+(?:\.\d+)?)/.exec(path)?.[1];
        return (m ? pair(m[1], true, num(m[2])) : null) ?? pair(fromPath, true);
    }

    // OpenStreetMap: the marker (mlat/mlon), then the view in #map=zoom/lat/long.
    if (/(^|\.)openstreetmap\.org$|(^|\.)osm\.org$/.test(host)) {
        const view = /map=([\d.]+)\/(-?[\d.]+)\/(-?[\d.]+)/.exec(url.hash);
        const zoom = num(view?.[1]) ?? num(params.get("zoom"));
        const marker = point(parseFloat(params.get("mlat") ?? ""), parseFloat(params.get("mlon") ?? ""), zoom);
        if (marker) return marker;
        if (view) return point(parseFloat(view[2]), parseFloat(view[3]), zoom);
        return point(parseFloat(params.get("lat") ?? ""), parseFloat(params.get("lon") ?? ""), zoom);
    }

    // Bing Maps: cp=lat~long, lvl=zoom.
    if (/(^|\.)bing\.com$/.test(host)) {
        return pair(params.get("cp"), false, num(params.get("lvl")));
    }

    // Google Maps, Apple Maps and anything else that puts "lat,long" in the address. Google's
    // place pin (!3d…!4d…) is more exact than the view centre (@lat,long,zoomz) it comes with.
    const view = new RegExp(String.raw`@(${NUM}),(${NUM})(?:,([\d.]+)z)?`).exec(path);
    const zoom = num(view?.[3]) ?? num(params.get("z")) ?? num(params.get("zoom"));
    const pin = new RegExp(String.raw`!3d(${NUM})!4d(${NUM})`).exec(url.href);
    if (pin) return point(parseFloat(pin[1]), parseFloat(pin[2]), zoom);
    for (const key of ["q", "query", "ll", "sll", "coordinate", "center", "destination", "daddr"]) {
        const found = pair(params.get(key), false, zoom);
        if (found) return found;
    }
    if (view) return point(parseFloat(view[1]), parseFloat(view[2]), zoom);
    return null;
}

// The location in a pasted link or pair of coordinates, or null when none can be read.
export function parseMapInput(input: string): MapPoint | null {
    return parseCoordinates(input) ?? parseUrl(input);
}

function formatCoordinate(value: number): string {
    return String(Number(value.toFixed(6)));
}

// The `<tg-map>` block for a location, wrapped in a <figure> when it has a caption.
export function mapToHtml(map: MapPoint, caption = ""): string {
    const zoom = map.zoom ?? 15;
    const tag = `<tg-map lat="${formatCoordinate(map.lat)}" long="${formatCoordinate(map.long)}" zoom="${zoom}"/>`;
    const text = caption.trim();
    return text ? `<figure>${tag}<figcaption>${text}</figcaption></figure>` : tag;
}

// The same place on openstreetmap.org, to check the location before inserting it.
export function mapCheckUrl(map: MapPoint): string {
    const [lat, long] = [formatCoordinate(map.lat), formatCoordinate(map.long)];
    return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${long}#map=${map.zoom ?? 15}/${lat}/${long}`;
}
