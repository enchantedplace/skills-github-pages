// WGS84 <-> UTM conversion and coordinate formatting. Pure functions, no DOM.

const a = 6378137;
const f = 1 / 298.257223563;
const k0 = 0.9996;
const e2 = f * (2 - f);
const ep2 = e2 / (1 - e2);
const BANDS = 'CDEFGHJKLMNPQRSTUVWXX';
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function utmZone(lat, lon) {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  // Norway exception
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  // Svalbard exceptions
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return zone;
}

export function utmBand(lat) {
  if (lat < -80 || lat > 84) return null;
  return BANDS[Math.floor((lat + 80) / 8)];
}

export function toUTM(lat, lon, forceZone) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -80 || lat > 84) return null; // UTM undefined at poles (UPS)
  const zone = forceZone || utmZone(lat, lon);
  const lon0 = rad((zone - 1) * 6 - 180 + 3);
  const phi = rad(lat);
  const lam = rad(lon);
  const sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = a / Math.sqrt(1 - e2 * sin * sin);
  const T = tan * tan;
  const C = ep2 * cos * cos;
  const A = cos * (lam - lon0);
  const e4 = e2 * e2, e6 = e4 * e2;
  const M = a * ((1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * e2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
  const easting = k0 * N * (A + ((1 - T + C) * A ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) + 500000;
  let northing = k0 * (M + N * tan * ((A * A) / 2
    + ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
  if (lat < 0) northing += 10000000;
  return { zone, band: utmBand(lat), hemisphere: lat < 0 ? 'S' : 'N', easting, northing };
}

// hemisphere may be 'N'/'S' or a latitude band letter (C..X).
export function fromUTM(zone, hemisphere, easting, northing) {
  zone = Number(zone);
  easting = Number(easting);
  northing = Number(northing);
  if (!(zone >= 1 && zone <= 60) || !Number.isFinite(easting) || !Number.isFinite(northing)) return null;
  let h = String(hemisphere || 'N').toUpperCase();
  let south;
  if (h === 'S' || h === 'N') south = h === 'S';
  else if (BANDS.includes(h)) south = h < 'N';
  else return null;
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const x = easting - 500000;
  const y = south ? northing - 10000000 : northing;
  const e4 = e2 * e2, e6 = e4 * e2;
  const M = y / k0;
  const mu = M / (a * (1 - e2 / 4 - (3 * e4) / 64 - (5 * e6) / 256));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu)
    + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1), cos = Math.cos(phi1), tan = Math.tan(phi1);
  const N1 = a / Math.sqrt(1 - e2 * sin * sin);
  const T1 = tan * tan;
  const C1 = ep2 * cos * cos;
  const R1 = (a * (1 - e2)) / (1 - e2 * sin * sin) ** 1.5;
  const D = x / (N1 * k0);
  const lat = phi1 - ((N1 * tan) / R1) * ((D * D) / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lon0 = (zone - 1) * 6 - 180 + 3;
  const lon = lon0 + deg((D - ((1 + 2 * T1 + C1) * D ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / cos);
  return { lat: deg(lat), lon };
}

export function formatUTM(lat, lon) {
  const u = toUTM(lat, lon);
  if (!u) return 'UTM n/a';
  const e = String(Math.round(u.easting)).padStart(6, '0');
  const n = String(Math.round(u.northing)).padStart(7, '0');
  return `${u.zone}${u.band} ${e}E ${n}N`;
}

export function formatLatLon(lat, lon, digits = 5) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  return `${Math.abs(lat).toFixed(digits)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(digits)}°${lon >= 0 ? 'E' : 'W'}`;
}

export function formatDMS(lat, lon) {
  const one = (v, pos, neg) => {
    const s = v >= 0 ? pos : neg;
    v = Math.abs(v);
    let d = Math.floor(v);
    let m = Math.floor((v - d) * 60);
    let sec = ((v - d) * 60 - m) * 60;
    if (sec >= 59.95) { sec = 0; m += 1; }
    if (m >= 60) { m = 0; d += 1; }
    return `${d}°${String(m).padStart(2, '0')}'${sec.toFixed(1).padStart(4, '0')}"${s}`;
  };
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return '—';
  return `${one(lat, 'N', 'S')} ${one(lon, 'E', 'W')}`;
}

// Parse a free-form lat/lon string: "45.123, -121.5" or "45.123N 121.5W"
export function parseLatLon(str) {
  if (!str) return null;
  const s = String(str).trim().toUpperCase().replace(/°/g, ' ');
  const re = /(-?\d+(?:\.\d+)?)\s*([NS])?[\s,;]+(-?\d+(?:\.\d+)?)\s*([EW])?/;
  const m = s.match(re);
  if (!m) return null;
  let lat = parseFloat(m[1]);
  let lon = parseFloat(m[3]);
  if (m[2] === 'S') lat = -Math.abs(lat);
  if (m[4] === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

// Parse "11T 512345 5234567" / "11 T 512345E 5234567N"
export function parseUTM(str) {
  if (!str) return null;
  const s = String(str).trim().toUpperCase();
  const m = s.match(/^(\d{1,2})\s*([C-HJ-NP-X])\s+(\d+(?:\.\d+)?)\s*E?\s+(\d+(?:\.\d+)?)\s*N?$/);
  if (!m) return null;
  return fromUTM(+m[1], m[2], +m[3], +m[4]);
}

export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
