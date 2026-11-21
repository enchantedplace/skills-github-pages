// Map helpers built on Leaflet (vendored, global `L`). Offline tiles live in the
// Cache API under TILE_CACHE; the service worker serves them cache-first.

import { urgencyInfo, chiefProblem } from './model.js';

export const TILE_CACHE = 'wfr-tiles-v1';
export const MAX_DOWNLOAD_TILES = 4000;

export const TILE_SOURCES = {
  osm: {
    name: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors',
    maxZoom: 17,
  },
  topo: {
    name: 'OpenTopoMap (contours)',
    url: 'https://a.tile.opentopomap.org/{z}/{x}/{y}.png',
    attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)',
    maxZoom: 16,
  },
};

export function tileSource(settings) {
  if (settings.tileSource === 'custom' && settings.customTileUrl) {
    return { name: 'Custom', url: settings.customTileUrl, attribution: 'Custom tiles', maxZoom: 18 };
  }
  return TILE_SOURCES[settings.tileSource] || TILE_SOURCES.osm;
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Always-available coordinate grid, drawn locally. Visible under (or instead of) tiles.
function gridLayer() {
  const Grid = L.GridLayer.extend({
    createTile(coords) {
      const tile = document.createElement('canvas');
      const size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      const ctx = tile.getContext('2d');
      const dark = document.documentElement.dataset.dark === '1';
      ctx.fillStyle = dark ? '#111' : '#f4f4f4';
      ctx.fillRect(0, 0, size.x, size.y);
      ctx.strokeStyle = dark ? '#555' : '#bbb';
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, 0.5, size.x - 1, size.y - 1);
      const nw = this._map.unproject(coords.scaleBy(size), coords.z);
      ctx.fillStyle = dark ? '#aaa' : '#555';
      ctx.font = '12px sans-serif';
      ctx.fillText(`${nw.lat.toFixed(3)}, ${nw.lng.toFixed(3)}`, 6, 16);
      return tile;
    },
  });
  return new Grid({ zIndex: 0 });
}

export function createMap(el, { settings, center, zoom = 13 }) {
  const src = tileSource(settings);
  const map = L.map(el, {
    zoomControl: true,
    attributionControl: true,
    tap: true,
    inertia: !settings.battery,
    zoomAnimation: !settings.battery,
    fadeAnimation: !settings.battery,
  });
  gridLayer().addTo(map);
  L.tileLayer(src.url, {
    maxZoom: src.maxZoom,
    attribution: src.attribution,
    // transparent 1px gif so missing (uncached, offline) tiles show the grid underneath
    errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    crossOrigin: true,
  }).addTo(map);
  L.control.scale({ metric: true, imperial: true }).addTo(map);
  map.setView(center || [46.85, -121.76], zoom);
  return map;
}

export function patientIcon(p, { selected = false } = {}) {
  const u = urgencyInfo(p.evac?.urgency);
  const short = p.label.replace(/^P-\d{4}-/, 'P');
  return L.divIcon({
    className: '',
    html: `<div class="pin u-${u.v || 'none'}${selected ? ' sel' : ''}"><span>${esc(short)}</span><b>${esc(u.short)}</b></div><div class="pin-stem"></div>`,
    iconSize: [74, 58],
    iconAnchor: [37, 58],
    popupAnchor: [0, -54],
  });
}

export function popupHtml(p) {
  const u = urgencyInfo(p.evac?.urgency);
  return `<div class="popup"><strong>${esc(p.label)}</strong> — ${esc(u.label)}<br>${esc(chiefProblem(p) || 'No problem recorded')}<br>
    <a class="btn small" href="#/p/${encodeURIComponent(p.id)}/abcde">Open</a></div>`;
}

export function locateMarker(lat, lon, acc) {
  const g = L.layerGroup();
  if (acc) L.circle([lat, lon], { radius: acc, weight: 2, color: '#000', dashArray: '6 6', fill: false, className: 'acc-circle' }).addTo(g);
  L.circleMarker([lat, lon], { radius: 9, weight: 4, color: '#fff', fillColor: '#000', fillOpacity: 1 }).addTo(g);
  return g;
}

// ---- offline tiles ----
const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

export function tileList(bounds, zMin, zMax, url) {
  const list = [];
  for (let z = zMin; z <= zMax; z++) {
    const x0 = lon2x(bounds.west, z), x1 = lon2x(bounds.east, z);
    const y0 = lat2y(bounds.north, z), y1 = lat2y(bounds.south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) list.push(url.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
  }
  return list;
}

export function countTiles(bounds, zMin, zMax) {
  let n = 0;
  for (let z = zMin; z <= zMax; z++) {
    n += (lon2x(bounds.east, z) - lon2x(bounds.west, z) + 1) * (lat2y(bounds.south, z) - lat2y(bounds.north, z) + 1);
  }
  return n;
}

export async function downloadTiles(urls, { onProgress, signal, concurrency = 4 } = {}) {
  const cache = await caches.open(TILE_CACHE);
  let done = 0, failed = 0, skipped = 0, idx = 0;
  async function worker() {
    while (idx < urls.length) {
      if (signal && signal.aborted) return;
      const url = urls[idx++];
      try {
        if (await cache.match(url)) { skipped++; }
        else {
          let res;
          try { res = await fetch(url, { mode: 'cors', signal }); } catch { res = await fetch(url, { mode: 'no-cors', signal }); }
          if (res.ok || res.type === 'opaque') await cache.put(url, res);
          else failed++;
        }
      } catch { failed++; }
      done++;
      onProgress && onProgress({ done, total: urls.length, failed, skipped });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { done, failed, skipped };
}

export async function cachedTileCount() {
  try { return (await (await caches.open(TILE_CACHE)).keys()).length; } catch { return 0; }
}
export async function clearTiles() { try { await caches.delete(TILE_CACHE); } catch { /* ignore */ } }
