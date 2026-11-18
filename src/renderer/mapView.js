'use strict';
/* global L */
// Leaflet map that draws tarkov.dev's map art with the same game-coordinate projection
// tarkov.dev uses (projection logic adapted from the-hideout/tarkov-dev, MIT licensed).

const SVG_NS = 'http://www.w3.org/2000/svg';

function applyRotation(latLng, rotation) {
  if (!latLng.lng && !latLng.lat) return L.latLng(0, 0);
  if (!rotation) return latLng;
  const a = (rotation * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const { lng: x, lat: y } = latLng;
  return L.latLng(x * sin + y * cos, x * cos - y * sin);
}

function getCRS(display) {
  let scaleX = 1;
  let scaleY = 1;
  let marginX = 0;
  let marginY = 0;
  if (display.transform) {
    scaleX = display.transform[0];
    scaleY = display.transform[2] * -1;
    marginX = display.transform[1];
    marginY = display.transform[3];
  }
  return L.extend({}, L.CRS.Simple, {
    transformation: new L.Transformation(scaleX, marginX, scaleY, marginY),
    projection: L.extend({}, L.Projection.LonLat, {
      project: (latLng) => L.Projection.LonLat.project(applyRotation(latLng, display.coordinateRotation)),
      unproject: (point) => applyRotation(L.Projection.LonLat.unproject(point), display.coordinateRotation * -1),
    }),
  });
}

const pos = (p) => [p.z, p.x];
const getBounds = (b) => (b ? L.latLngBounds([b[0][1], b[0][0]], [b[1][1], b[1][0]]) : undefined);

function scaledBounds(bounds, factor) {
  const cx = (bounds[0][0] + bounds[1][0]) / 2;
  const cy = (bounds[0][1] + bounds[1][1]) / 2;
  const w = (bounds[1][0] - bounds[0][0]) * factor;
  const h = (bounds[1][1] - bounds[0][1]) * factor;
  return [
    [cy - h / 2, cx - w / 2],
    [cy + h / 2, cx + w / 2],
  ];
}

function inExtentBounds(position, b) {
  const [x1, z1] = b[0];
  const [x2, z2] = b[1];
  return position.x >= Math.min(x1, x2) && position.x <= Math.max(x1, x2) && position.z >= Math.min(z1, z2) && position.z <= Math.max(z1, z2);
}

function onLayer(item, layer) {
  if (!layer.extents) return false;
  const top = item.top ?? item.position.y;
  const bottom = item.bottom ?? item.position.y;
  for (const ext of layer.extents) {
    if (top >= ext.height[0] && bottom < ext.height[1]) {
      if (!ext.bounds) return true;
      if (ext.bounds.some((b) => inExtentBounds(item.position, b))) return true;
    }
  }
  return false;
}

/** Strip anything executable from third-party SVG before it touches the page. */
function sanitizeSvg(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const root = doc.documentElement;
  if (!root || root.nodeName !== 'svg') throw new Error('Map SVG did not parse');
  for (const el of root.querySelectorAll('script, foreignObject, iframe, object, embed')) el.remove();
  for (const el of [root, ...root.querySelectorAll('*')]) {
    for (const attr of [...el.attributes]) {
      const v = attr.value.trim().toLowerCase();
      if (attr.name.toLowerCase().startsWith('on') || v.startsWith('javascript:')) el.removeAttribute(attr.name);
    }
  }
  return document.importNode(root, true);
}

class MapView {
  constructor(el, handlers) {
    this.el = el;
    this.handlers = handlers; // { popup(content, ctx) }
    this.map = null;
    this.display = null;
    this.apiMap = null;
    this.svgRoot = null;
    this.floor = null; // selected layer name or null for ground
    this.floorLayer = null;
    this.markerLayer = null;
    this.extractLayer = null;
    this.positionLayer = null;
    this.markerIndex = new Map(); // taskId -> [marker]
    this.loadToken = 0;
  }

  get floors() {
    return (this.display?.layers || []).map((l) => l.name);
  }

  async show(apiMap, display) {
    const token = ++this.loadToken;
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
    this.apiMap = apiMap;
    this.display = display;
    this.floor = null;
    this.floorLayer = null;
    this.svgRoot = null;
    this.lootSig = null;
    if (!display) return;

    const maxZoom = Math.max(7, display.maxZoom || 5);
    const map = L.map(this.el, {
      crs: getCRS(display),
      attributionControl: false,
      zoomControl: true,
      minZoom: display.minZoom ?? 1,
      maxZoom,
      zoomSnap: 0.25,
      zoomDelta: 0.5,
      wheelPxPerZoomLevel: 90,
      renderer: L.svg({ padding: 0.5 }),
    });
    this.map = map;
    const bounds = getBounds(display.bounds);
    map.setMaxBounds(scaledBounds(display.bounds, 1.5));
    map.fitBounds(bounds);
    // map labels grow as you zoom in, like on tarkov.dev
    const fitZoom = map.getZoom();
    const scaleLabels = () => {
      const px = Math.max(7, Math.min(40, 11 * Math.pow(2, (map.getZoom() - fitZoom) * 0.8)));
      this.el.style.setProperty('--label-px', `${px.toFixed(1)}px`);
    };
    map.on('zoom', scaleLabels);
    scaleLabels();
    // map art sits below quest outlines/markers no matter when it finishes loading
    map.createPane('art').style.zIndex = 250;
    map.createPane('floorArt').style.zIndex = 260;
    map.createPane('labels').style.zIndex = 450;
    this.markerLayer = L.layerGroup().addTo(map);
    this.extractLayer = L.layerGroup().addTo(map);
    this.spawnLayer = L.layerGroup().addTo(map);
    this.lockLayer = L.layerGroup().addTo(map);
    // loot spots can number in the thousands: draw them on a canvas, not as DOM elements
    this.lootRenderer = L.canvas({ padding: 0.5 });
    this.lootLayer = L.layerGroup().addTo(map);
    this.lootMarkers = [];
    this.routeLayer = L.layerGroup().addTo(map);
    this.positionLayer = L.layerGroup().addTo(map);

    if (display.svgPath) {
      try {
        const svgText = await window.tqm.getSvg(display.svgPath);
        if (token !== this.loadToken || this.map !== map) return;
        const inner = sanitizeSvg(svgText);
        const outer = document.createElementNS(SVG_NS, 'svg');
        outer.setAttribute('viewBox', inner.getAttribute('viewBox'));
        outer.appendChild(inner);
        for (const g of inner.children) {
          if (g.nodeName !== 'g' || !g.id) continue;
          if (g.id === display.svgLayer || g.dataset?.keepWithGroup === display.svgLayer) g.classList.add('base-layer');
          else g.classList.add('svg-floor', 'hidden-layer');
        }
        this.svgRoot = inner;
        L.svgOverlay(outer, display.svgBounds ? getBounds(display.svgBounds) : bounds, { className: 'map-art', pane: 'art' }).addTo(map);
      } catch (err) {
        this.handlers.error?.(`Map image failed to load: ${err.message || err}`);
      }
    } else if (display.tilePath) {
      L.tileLayer(display.tilePath, {
        tileSize: display.tileSize || 256,
        bounds,
        maxNativeZoom: display.maxZoom,
        maxZoom,
        className: 'map-art',
      }).addTo(map);
    }

    for (const label of display.labels || []) {
      const size = label.size || 100;
      L.marker(pos({ x: label.position[0], z: label.position[1] }), {
        interactive: false,
        keyboard: false,
        pane: 'labels',
        icon: L.divIcon({
          className: 'map-label',
          html: `<div style="font-size:calc(var(--label-px, 11px) * ${size / 100});transform:translate(-50%,-50%) rotate(${label.rotation || 0}deg)">${escapeHtml(label.text)}</div>`,
          iconSize: [0, 0],
        }),
      }).addTo(map);
    }

  }

  floorFor(item) {
    for (const layer of this.display?.layers || []) if (onLayer(item, layer)) return layer.name;
    return null;
  }

  async setFloor(name) {
    if (!this.map) return;
    this.floor = name || null;
    if (this.floorLayer) {
      this.floorLayer.remove();
      this.floorLayer = null;
    }
    const layer = (this.display.layers || []).find((l) => l.name === this.floor);
    if (this.svgRoot) {
      for (const g of this.svgRoot.children) {
        if (!g.classList.contains('svg-floor')) continue;
        g.classList.toggle('hidden-layer', !(layer && layer.svgLayer === g.id));
      }
      for (const g of this.svgRoot.querySelectorAll(':scope > .base-layer')) g.classList.toggle('dimmed', !!layer);
    }
    if (layer?.tilePath) {
      this.floorLayer = L.tileLayer(layer.tilePath, {
        tileSize: this.display.tileSize || 256,
        bounds: getBounds(this.display.bounds),
        maxNativeZoom: this.display.maxZoom,
        maxZoom: this.map.getMaxZoom(),
        className: 'floor-tiles',
        pane: 'floorArt',
      }).addTo(this.map);
    } else if (layer?.svgPath) {
      try {
        const inner = sanitizeSvg(await window.tqm.getSvg(layer.svgPath));
        const outer = document.createElementNS(SVG_NS, 'svg');
        outer.setAttribute('viewBox', inner.getAttribute('viewBox'));
        outer.appendChild(inner);
        this.floorLayer = L.svgOverlay(outer, getBounds(this.display.svgBounds || this.display.bounds), { className: 'floor-svg', pane: 'floorArt' }).addTo(this.map);
      } catch {
        /* ignore */
      }
    }
    this.el.classList.toggle('floor-selected', !!layer);
    this.refreshFloorDimming();
  }

  refreshFloorDimming() {
    for (const m of [...(this.extractMarkers || []), ...(this.lockMarkers || [])]) m.getElement()?.classList.toggle('off-floor', (m.options.floor || null) !== this.floor);
    for (const m of this.lootMarkers || []) {
      const off = (m.options.floor || null) !== this.floor;
      m.setStyle({ opacity: off ? 0.3 : 1, fillOpacity: off ? 0.25 : 0.9 });
    }
    for (const markers of this.markerIndex.values()) {
      for (const m of markers) {
        const off = (m.options.floor || null) !== this.floor;
        m.getElement()?.classList.toggle('off-floor', off);
        if (m.options.outlineLayer) m.options.outlineLayer.setStyle({ opacity: off ? 0.25 : 0.9 });
      }
    }
  }

  /**
   * @param {Array} entries [{ task, state, objective, kind: 'zone'|'item', item: {position, outline, top, bottom}, questItem }]
   */
  setQuestMarkers(entries) {
    if (!this.map) return;
    this.markerLayer.clearLayers();
    this.markerIndex.clear();
    for (const e of entries) {
      const floor = this.floorFor(e.item);
      let outlineLayer = null;
      if (e.kind === 'zone' && e.item.outline?.length) {
        outlineLayer = L.polygon(
          e.item.outline.map((v) => [v.z, v.x]),
          { className: `zone-outline status-${e.state.status}`, weight: 1.5, fillOpacity: 0.12, interactive: false }
        ).addTo(this.markerLayer);
      }
      const icon = L.divIcon({
        className: `quest-marker kind-${e.kind} status-${e.state.status}`,
        html: e.kind === 'item' ? '<span class="pin"><span class="dot"></span></span>' : '<span class="pin"></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11],
        popupAnchor: [0, -10],
      });
      const marker = L.marker(pos(e.item.position), { icon, riseOnHover: true, floor, outlineLayer, taskId: e.task.id });
      marker.bindTooltip(`${escapeHtml(e.task.name)}<br><span class="tt-sub">${escapeHtml(e.questItem?.name || e.objective.description)}</span>`, {
        direction: 'top',
        offset: [0, -10],
        className: 'quest-tooltip',
      });
      marker.bindPopup(() => this.handlers.popup({ ...e, floor }), { maxWidth: 340, minWidth: 260, className: 'quest-popup' });
      marker.addTo(this.markerLayer);
      if (!this.markerIndex.has(e.task.id)) this.markerIndex.set(e.task.id, []);
      this.markerIndex.get(e.task.id).push(marker);
    }
    this.refreshFloorDimming();
  }

  /**
   * Extracts, labelled PMC / SCAV / SHARED. factions: which to show.
   * Hover shows requirements and the extract area; click opens handlers.extractPopup(ex).
   */
  setExtracts(extracts, show, factions = ['pmc', 'scav', 'shared']) {
    if (!this.map) return;
    this.extractLayer.clearLayers();
    this.extractMarkers = [];
    if (!show) return;
    const TAG = { pmc: 'PMC', scav: 'SCAV', shared: 'PMC+SCAV' };
    const KIND_ICON = window.EXTRACT_KINDS || {};
    for (const ex of extracts) {
      if (!ex.position) continue;
      const faction = ex.faction || 'shared';
      if (!factions.includes(faction)) continue;
      const area = ex.outline?.length
        ? L.polygon(
            ex.outline.map((v) => [v.z, v.x]),
            { className: `extract-area faction-${faction}`, weight: 1.5, fillOpacity: 0.18, interactive: false }
          )
        : null;
      const needs = [];
      if (ex.switches?.length) needs.push(`needs ${ex.switches.map((s) => s.name).join(', ')}`);
      if (ex.payment) needs.push('costs money');
      const m = L.marker(pos(ex.position), {
        icon: L.divIcon({
          className: `extract-marker faction-${faction}`,
          html: `<span class="ex-dot"></span><span class="ex-name">${(ex.kinds || []).map((k) => `<span class="ex-kind" title="${escapeHtml(KIND_ICON[k]?.label || k)}">${KIND_ICON[k]?.icon || ''}</span>`).join('')}${escapeHtml(ex.name)}<span class="ex-tag">${TAG[faction]}</span>${needs.length ? '<span class="ex-req">!</span>' : ''}</span>`,
          iconSize: [12, 12],
          iconAnchor: [6, 6],
        }),
        keyboard: false,
        riseOnHover: true,
        floor: this.floorFor(ex),
      });
      this.extractMarkers.push(m);
      m.bindTooltip(
        `<b>${escapeHtml(ex.name)}</b><br><span class="tt-sub">${(ex.kinds || []).map((k) => `${KIND_ICON[k]?.icon || ''} ${escapeHtml(KIND_ICON[k]?.label || k)} · `).join('')}${TAG[faction]} extract${needs.length ? ` · ${escapeHtml(needs.join(' · '))}` : ''} · click for details</span>`,
        { direction: 'top', offset: [0, -6], className: 'quest-tooltip' }
      );
      if (area) {
        m.on('mouseover', () => area.addTo(this.extractLayer));
        m.on('mouseout', () => area.remove());
      }
      m.bindPopup(() => this.handlers.extractPopup(ex), { maxWidth: 320, minWidth: 240, className: 'quest-popup' });
      m.addTo(this.extractLayer);
    }
    this.refreshFloorDimming();
  }

  /**
   * Locked doors / trunks. entries: [{ lock, key, questNames: [] }]
   * Hover shows the key; click opens handlers.lockPopup(entry).
   */
  setLocks(entries, show) {
    if (!this.map) return;
    this.lockLayer.clearLayers();
    this.lockMarkers = [];
    if (!show) return;
    for (const e of entries) {
      const floor = this.floorFor(e.lock);
      const quest = e.questNames.length ? ' quest-key' : '';
      const m = L.marker(pos(e.lock.position), {
        icon: L.divIcon({
          className: `lock-marker lock-${e.lock.type}${quest}`,
          html: '<span>🔑</span>',
          iconSize: [20, 20],
          iconAnchor: [10, 10],
          popupAnchor: [0, -10],
        }),
        riseOnHover: true,
        floor,
      });
      const tip = `<b>${escapeHtml(e.key?.name || 'Unknown key')}</b><br><span class="tt-sub">${e.lock.type === 'trunk' ? 'Car trunk' : 'Locked door'}${e.lock.needsPower ? ' · needs power' : ''}${floor ? ` · ${escapeHtml(floor)}` : ''}${e.questNames.length ? ' · needed for a quest' : ''}</span>`;
      m.bindTooltip(tip, { direction: 'top', offset: [0, -10], className: 'quest-tooltip' });
      m.bindPopup(() => this.handlers.lockPopup({ ...e, floor }), { maxWidth: 320, minWidth: 240, className: 'quest-popup' });
      m.addTo(this.lockLayer);
      this.lockMarkers.push(m);
    }
    this.refreshFloorDimming();
  }

  /**
   * Loot containers and loose-loot spots, coloured by category.
   * points: [{ c: category, n: label, p: {x,y,z}, x?: possible items }]
   */
  setLoot(points) {
    if (!this.map) return;
    this.lootLayer.clearLayers();
    this.lootMarkers = [];
    for (const l of points || []) {
      const cat = window.Loot?.CAT_BY_ID[l.c];
      const floor = this.floorFor({ position: l.p });
      const loose = !l.w;
      const m = L.circleMarker(pos(l.p), {
        renderer: this.lootRenderer,
        radius: loose ? 3.5 : 5,
        weight: loose ? 1 : 1.5,
        color: '#111',
        fillColor: cat?.color || '#999',
        fillOpacity: 0.9,
        floor,
      });
      const tip = `${cat ? cat.icon + ' ' : ''}<b>${escapeHtml(l.n)}</b>${l.x ? `<br><span class="tt-sub">Can spawn: ${escapeHtml(l.x)}</span>` : ''}${floor ? `<br><span class="tt-sub">${escapeHtml(floor)}</span>` : ''}`;
      m.bindTooltip(tip, { direction: 'top', offset: [0, -4], className: 'quest-tooltip' });
      m.addTo(this.lootLayer);
      this.lootMarkers.push(m);
    }
    this.refreshFloorDimming();
  }

  /** Spawn points (PMC or Scav). Clicking one calls handlers.spawnClick(spawn). */
  setSpawns(spawns, show, kind = 'pmc') {
    if (!this.map) return;
    this.spawnLayer.clearLayers();
    if (!show) return;
    for (const sp of spawns) {
      L.marker(pos(sp.position), {
        icon: L.divIcon({ className: `spawn-marker spawn-${kind}`, html: '<span></span>', iconSize: [12, 12], iconAnchor: [6, 6] }),
        keyboard: false,
      })
        .bindTooltip(`${kind === 'scav' ? 'Scav' : 'PMC'} spawn: click to start your route here`, { direction: 'top', offset: [0, -6] })
        .on('click', () => this.handlers.spawnClick?.(sp))
        .addTo(this.spawnLayer);
    }
  }

  /** Planned route: start → numbered stops → extract. */
  setRoute(route) {
    if (!this.map) return;
    this.routeLayer.clearLayers();
    if (!route || (!route.stops.length && !route.start && !route.candidates?.length)) return;
    const pts = [];
    if (route.start) pts.push(pos(route.start));
    for (const s of route.stops) pts.push(pos(s.point.position));
    if (route.end) pts.push(pos(route.end));
    if (pts.length > 1) {
      L.polyline(pts, { className: 'route-line-shadow', weight: 7, interactive: false }).addTo(this.routeLayer);
      L.polyline(pts, { className: 'route-line', weight: 3, dashArray: '8 7', interactive: false }).addTo(this.routeLayer);
    }
    const badge = (p, text, cls, extra) => {
      const m = L.marker(pos(p), {
        zIndexOffset: cls === 'cand' ? 1400 : 1500,
        interactive: !!extra,
        icon: L.divIcon({ className: `route-badge ${cls}`, html: `<span>${text}</span>`, iconSize: [20, 20], iconAnchor: [10, 26] }),
      }).addTo(this.routeLayer);
      if (extra?.tip) m.bindTooltip(extra.tip, { direction: 'top', offset: [0, -26], className: 'quest-tooltip' });
      if (extra?.click) m.on('click', extra.click);
      return m;
    };
    // Scav runs: other loot hotspots you could add (click toggles them in or out of the route)
    for (const c of route.candidates || []) badge(c.position, '+', 'cand', { tip: c.tip, click: () => this.handlers.hotspotClick?.(c.id) });
    if (route.start) badge(route.start, 'S', 'start');
    route.stops.forEach((s, i) =>
      badge(s.point.position, i + 1, 'stop', s.tip ? { tip: s.tip, click: s.id ? () => this.handlers.hotspotClick?.(s.id) : null } : null)
    );
    if (route.end) badge(route.end, 'E', 'end');
  }

  fitRoute(route) {
    if (!this.map || !route) return;
    const pts = [...(route.start ? [pos(route.start)] : []), ...route.stops.map((s) => pos(s.point.position)), ...(route.end ? [pos(route.end)] : [])];
    if (pts.length) this.map.flyToBounds(L.latLngBounds(pts).pad(0.25), { duration: 0.6, maxZoom: (this.display.maxZoom || 5) + 0.5 });
  }

  flyTo(p) {
    if (this.map && p) this.map.flyTo(pos(p), Math.max(this.map.getZoom(), (this.display.maxZoom || 5) - 0.5), { duration: 0.5 });
  }

  setPosition(p) {
    if (!this.map) return;
    this.positionLayer.clearLayers();
    if (!p) return;
    let add = this.display.coordinateRotation || 0;
    if (add === 90 || add === 270) add += 180;
    const rotation = (p.yaw ?? 0) + add;
    L.marker(pos(p), {
      zIndexOffset: 2000,
      interactive: false,
      icon: L.divIcon({
        className: 'player-marker',
        html: p.yaw == null ? '<div class="arrow no-dir"></div>' : `<div class="arrow" style="transform: rotate(${rotation}deg)"></div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      }),
    }).addTo(this.positionLayer);
  }

  focusTask(taskId) {
    const markers = this.markerIndex.get(taskId);
    if (!markers?.length || !this.map) return false;
    const b = L.latLngBounds(markers.map((m) => m.getLatLng()));
    this.map.flyToBounds(b.pad(0.6), { maxZoom: Math.min(this.map.getMaxZoom(), (this.display.maxZoom || 5) + 0.5), duration: 0.6 });
    if (markers[0].options.floor !== this.floor) this.handlers.floorChange?.(markers[0].options.floor);
    setTimeout(() => markers[0].openPopup(), 650);
    return true;
  }

  focusPosition(p) {
    if (this.map && p) this.map.flyTo(pos(p), Math.max(this.map.getZoom(), (this.display.maxZoom || 5) - 1), { duration: 0.5 });
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.MapView = MapView;
window.escapeHtml = escapeHtml;
