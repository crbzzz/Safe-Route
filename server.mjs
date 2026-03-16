import http from 'node:http';
import fsSync, { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const ENV_PATH = path.join(__dirname, '.env');
function loadDotEnv(filePath) {
  const env = {};
  try {
    const raw = fsSync.readFileSync(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  } catch {
    return env;
  }
  return env;
}
const dotenvValues = loadDotEnv(ENV_PATH);
const env = { ...dotenvValues, ...process.env };
const PORT = Number(env.PORT || 3000);
const MAPBOX_ACCESS_TOKEN = env.MAPBOX_ACCESS_TOKEN || '';
const MISTRAL_API_KEY = env.MISTRAL_API_KEY || '';
const MISTRAL_MODEL = env.MISTRAL_MODEL || 'mistral-medium-latest';
const DATASF_APP_TOKEN = env.DATASF_APP_TOKEN || '';
const CACHE_TTL_MS = Number(env.CACHE_TTL_MS || 5 * 60 * 1000);
const SERVER_TIMEOUT_MS = Number(env.SERVER_TIMEOUT_MS || 20_000);
const SF_CENTER = { lat: 37.7749, lng: -122.4194 };
const SF_BOUNDS = {
  south: 37.63983,
  west: -123.173825,
  north: 37.929824,
  east: -122.28178,
};
const cache = new Map();
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function createTimeoutSignal(ms) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(new Error(`Timed out after ${ms}ms`)), ms);
  return { signal: controller.signal, clear: () => clearTimeout(id) };
}
async function fetchJson(url, options = {}) {
  const timeout = createTimeoutSignal(options.timeout || SERVER_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      signal: timeout.signal,
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`HTTP ${response.status} from ${url}: ${body.slice(0, 400)}`);
    }
    return await response.json();
  } finally {
    timeout.clear();
  }
}
async function withCache(key, ttlMs, loader) {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.value;
  }
  const value = await loader();
  cache.set(key, { value, expiresAt: now + ttlMs });
  return value;
}
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}
function sendText(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}
function sendError(res, status, error, extra = {}) {
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, { error: message, ...extra });
}

function escapeHtmlAttribute(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function getRequestOrigin(req) {
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwardedProto || 'http';
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
  return `${protocol}://${host}`;
}

function injectHtmlMetadata(html, req, pathname) {
  const origin = getRequestOrigin(req);
  const pageUrl = new URL(pathname === '/' ? '/' : pathname, origin).toString();
  const shareImageUrl = new URL('/logo.png', origin).toString();

  return html
    .replaceAll('__APP_URL__', escapeHtmlAttribute(pageUrl))
    .replaceAll('__SHARE_IMAGE_URL__', escapeHtmlAttribute(shareImageUrl));
}

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('Invalid JSON body');
  }
}
function assertSfPoint(point, name) {
  const inSf =
    point &&
    Number.isFinite(point.lng) &&
    Number.isFinite(point.lat) &&
    point.lng >= -122.55 &&
    point.lng <= -122.35 &&
    point.lat >= 37.68 &&
    point.lat <= 37.84;

  if (!inSf) {
    throw new Error(`${name} is outside San Francisco. Please choose a location in SF.`);
  }
}
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getIncidentWeight(incident) {
  const text = [
    incident.callType,
    incident.call_type,
    incident.originalCrimeTypeName,
    incident.original_crime_type_name,
    incident.primaryType,
    incident.secondaryType,
    incident.description,
    incident.disposition,
    incident.priority,
    incident.event_type,
    incident.incident_category,
    incident.incident_subcategory
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (
    /assault|aggravated|battery|robbery|weapon|shots|shooting|stabbing|armed|carjacking|kidnap|homicide/.test(text)
  ) {
    return 1.0;
  }

  if (
    /burglary|theft|larceny|auto theft|vehicle theft|break[- ]?in|vandalism|trespass/.test(text)
  ) {
    return 0.65;
  }

  if (
    /suspicious|disturbance|noise|fraud|traffic|non-criminal|well being|welfare/.test(text)
  ) {
    return 0.3;
  }

  return 0.45;
}

function hoursAgoFromIncident(incident) {
  const candidates = [
    incident.timestamp,
    incident.received_datetime,
    incident.received_dt,
    incident.callDate,
    incident.report_datetime,
    incident.incident_datetime,
    incident.datetime
  ].filter(Boolean);

  if (typeof incident.ageHours === 'number' && Number.isFinite(incident.ageHours)) {
    return Math.max(0, incident.ageHours);
  }

  if (!candidates.length) return 24;

  const date = new Date(candidates[0]);
  if (Number.isNaN(date.getTime())) return 24;

  return Math.max(0, (Date.now() - date.getTime()) / 3600000);
}

function buildRiskGrid(incidents, options = {}) {
  const minLng = options.minLng ?? -122.55;
  const maxLng = options.maxLng ?? -122.35;
  const minLat = options.minLat ?? 37.68;
  const maxLat = options.maxLat ?? 37.84;
  const cellSize = options.cellSize ?? 0.01; // ~1 km width
  const currentHour = new Date().getHours();
  const nightBoost = currentHour >= 21 || currentHour <= 5 ? 1.15 : 1.0;

  const cols = Math.ceil((maxLng - minLng) / cellSize);
  const rows = Math.ceil((maxLat - minLat) / cellSize);

  const grid = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const west = minLng + col * cellSize;
      const east = west + cellSize;
      const south = minLat + row * cellSize;
      const north = south + cellSize;

      grid.push({
        id: `${row}-${col}`,
        row,
        col,
        west,
        east,
        south,
        north,
        centerLng: (west + east) / 2,
        centerLat: (south + north) / 2,
        score: 0,
        count: 0
      });
    }
  }

  for (const incident of incidents) {
    const lng = Number(incident.lng ?? incident.longitude ?? incident.lon);
    const lat = Number(incident.lat ?? incident.latitude);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
    if (lng < minLng || lng > maxLng || lat < minLat || lat > maxLat) continue;

    const col = Math.floor((lng - minLng) / cellSize);
    const row = Math.floor((lat - minLat) / cellSize);
    const idx = row * cols + col;
    const cell = grid[idx];
    if (!cell) continue;

    const baseWeight = getIncidentWeight(incident);
    const hoursAgo = hoursAgoFromIncident(incident);

    // décroissance temporelle
    const recencyMultiplier =
      hoursAgo <= 2 ? 1.0 :
      hoursAgo <= 6 ? 0.8 :
      hoursAgo <= 12 ? 0.6 :
      hoursAgo <= 24 ? 0.45 :
      0.25;

    cell.score += baseWeight * recencyMultiplier * nightBoost;
    cell.count += 1;
  }

  const activeCells = grid.filter((cell) => cell.score > 0);

  if (!activeCells.length) {
    return {
      bounds: { minLng, maxLng, minLat, maxLat, cellSize },
      cells: [],
    };
  }

  const quantile = (sortedValues, ratio) => {
    if (!sortedValues.length) return 0;
    const position = clamp((sortedValues.length - 1) * ratio, 0, sortedValues.length - 1);
    const lowerIndex = Math.floor(position);
    const upperIndex = Math.ceil(position);
    if (lowerIndex === upperIndex) return sortedValues[lowerIndex];
    const weight = position - lowerIndex;
    return sortedValues[lowerIndex] * (1 - weight) + sortedValues[upperIndex] * weight;
  };

  for (const cell of activeCells) {
    const clusterBoost = 1 + Math.min(cell.count, 24) / 60;
    cell.intensity = Math.log1p(cell.score) * clusterBoost;
  }

  const maxIntensity = activeCells.reduce((acc, cell) => Math.max(acc, cell.intensity), 0) || 1;
  const normalizedValues = activeCells
    .map((cell) => clamp(cell.intensity / maxIntensity, 0, 1))
    .sort((a, b) => a - b);
  const highThreshold = clamp(quantile(normalizedValues, 0.88), 0.42, 0.92);
  const mediumThreshold = clamp(Math.min(quantile(normalizedValues, 0.68), highThreshold - 0.08), 0.16, 0.72);

  for (const cell of activeCells) {
    cell.normalized = clamp(cell.intensity / maxIntensity, 0, 1);
    cell.level =
      cell.normalized >= highThreshold ? 'high' :
      cell.normalized >= mediumThreshold ? 'medium' :
      'low';
    delete cell.intensity;
  }

  return {
    bounds: { minLng, maxLng, minLat, maxLat, cellSize },
    cells: activeCells
  };
}
async function serveStatic(req, res, pathname) {
  const cleaned = pathname === '/' ? '/index.html' : pathname;
  const resolved = path.normalize(cleaned).replace(/^\.\.(?:\/|\\|$)/, '');
  const filePath = path.join(PUBLIC_DIR, resolved);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Forbidden');
    return;
  }
  try {
    const stat = await fs.stat(filePath);
    if (stat.isDirectory()) {
      return serveStatic(req, res, path.join(cleaned, 'index.html'));
    }
    const ext = path.extname(filePath).toLowerCase();
    const isHtml = ext === '.html';
    const content = isHtml
      ? Buffer.from(injectHtmlMetadata(await fs.readFile(filePath, 'utf8'), req, pathname), 'utf8')
      : await fs.readFile(filePath);
    const contentType = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.ico': 'image/x-icon',
    }[ext] || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': content.length,
      'Cache-Control': ['.html', '.css', '.js'].includes(ext) ? 'no-store' : 'public, max-age=3600',
    });
    res.end(content);
  } catch {
    sendError(res, 404, 'Not found');
  }
}
function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}
function normalizeText(value) {
  return value == null ? '' : String(value).trim();
}
function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function parseMaybeJson(value) {
  if (!value || typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}
function pickFirst(record, keys) {
  for (const key of keys) {
    if (record[key] != null && record[key] !== '') return record[key];
  }
  return null;
}
function extractCoords(record) {
  const lat = pickFirst(record, ['latitude', 'lat', 'y', 'y_coord']);
  const lng = pickFirst(record, ['longitude', 'lng', 'lon', 'x', 'x_coord']);
  if (lat != null && lng != null) {
    const latNum = toNumber(lat);
    const lngNum = toNumber(lng);
    if (latNum != null && lngNum != null) return { lat: latNum, lng: lngNum };
  }
  const compoundKeys = ['point', 'location', 'shape', 'intersection_point', 'incident_location'];
  for (const key of compoundKeys) {
    const value = record[key];
    if (!value) continue;
    if (Array.isArray(value?.coordinates) && value.coordinates.length >= 2) {
      return { lng: Number(value.coordinates[0]), lat: Number(value.coordinates[1]) };
    }
    if (Array.isArray(value) && value.length >= 2) {
      return { lng: Number(value[0]), lat: Number(value[1]) };
    }
    if (typeof value === 'object') {
      const c = value.coordinates || value?.geometry?.coordinates;
      if (Array.isArray(c) && c.length >= 2) {
        return { lng: Number(c[0]), lat: Number(c[1]) };
      }
      const objectLat = pickFirst(value, ['latitude', 'lat', 'y']);
      const objectLng = pickFirst(value, ['longitude', 'lng', 'lon', 'x']);
      if (objectLat != null && objectLng != null) {
        const latNum = toNumber(objectLat);
        const lngNum = toNumber(objectLng);
        if (latNum != null && lngNum != null) return { lat: latNum, lng: lngNum };
      }
    }
    const parsed = parseMaybeJson(value);
    if (parsed) {
      const nested = extractCoords({ point: parsed });
      if (nested) return nested;
    }
  }
  return null;
}
function extractTimestamp(record) {
  return (
    parseDate(pickFirst(record, ['received_datetime', 'dispatch_datetime', 'entry_datetime', 'incident_datetime', 'report_datetime', 'occurred_from_datetime', 'call_datetime'])) ||
    null
  );
}
function extractEventType(record) {
  const primary = normalizeText(
    pickFirst(record, [
      'call_type_final_desc',
      'call_type_final',
      'call_type_original_desc',
      'call_type_original',
      'original_crime_type_name',
      'incident_category',
      'incident_type_description',
      'incident_type_primary',
      'type',
      'category',
    ]),
  );
  const secondary = normalizeText(
    pickFirst(record, ['incident_subcategory', 'incident_description', 'call_type', 'description', 'subtype']),
  );
  return { primary, secondary };
}
function extractDescription(record) {
  return normalizeText(
    pickFirst(record, [
      'incident_description',
      'incident_type_description',
      'cad_event_number',
      'call_type_final_desc',
      'call_type_original_desc',
      'disposition',
      'address',
      'intersection_name',
    ]),
  );
}
function extractNeighborhood(record) {
  return normalizeText(
    pickFirst(record, [
      'analysis_neighborhood',
      'analysis_neighborhoods',
      'supervisor_district',
      'police_district',
      'district',
      'neighborhood',
    ]),
  );
}
function extractPriority(record) {
  return normalizeText(pickFirst(record, ['priority_final', 'priority_original', 'priority', 'call_priority']));
}
function normalizeSourceRecord(record, source) {
  const coords = extractCoords(record);
  const timestamp = extractTimestamp(record);
  if (!coords || coords.lat == null || coords.lng == null) return null;
  if (!Number.isFinite(coords.lat) || !Number.isFinite(coords.lng)) return null;
  const eventType = extractEventType(record);
  const description = extractDescription(record);
  const priority = extractPriority(record);
  const neighborhood = extractNeighborhood(record);
  const id = normalizeText(pickFirst(record, ['id', 'cad_number', 'incident_number'])) || `${source}-${coords.lat},${coords.lng}-${timestamp?.toISOString() || 'no-time'}`;
  const ageHours = timestamp ? Math.max(0, (Date.now() - timestamp.getTime()) / 3_600_000) : null;
  return {
    id: `${source}-${id}`,
    source,
    lat: coords.lat,
    lng: coords.lng,
    timestamp: timestamp ? timestamp.toISOString() : null,
    ageHours,
    primaryType: eventType.primary || 'Unknown',
    secondaryType: eventType.secondary,
    description,
    neighborhood,
    priority,
  };
}
function riskWeight(event) {
  const haystack = `${event.primaryType} ${event.secondaryType} ${event.description} ${event.priority}`.toLowerCase();
  let weight = 0.25;
  const rules = [
    [/homicide|murder|shoot|shots fired|gun|firearm|armed|stabbing|stabbed/i, 1.9],
    [/assault|battery|robbery|carjacking|kidnap|weapon|aggravated/i, 1.55],
    [/burglary|break[- ]?in|arson|home invasion|residential/i, 1.25],
    [/theft|larceny|shoplift|stolen vehicle|auto theft|vehicle theft|bipping|vandalism/i, 0.95],
    [/suspicious|disturbance|fight|trespass|harassment|threat|wellness|welfare check/i, 0.75],
    [/traffic|collision|medical|service|alarm|noise|park|encampment|nuisance/i, 0.35],
  ];
  for (const [pattern, value] of rules) {
    if (pattern.test(haystack)) {
      weight = Math.max(weight, value);
    }
  }
  const priorityMap = {
    a: 1.25,
    b: 1.12,
    c: 1.0,
    d: 0.92,
    e: 0.86,
    high: 1.2,
    medium: 1.0,
    low: 0.8,
  };
  const priorityKey = event.priority.trim().toLowerCase();
  if (priorityMap[priorityKey]) {
    weight *= priorityMap[priorityKey];
  }
  return weight;
}
function isViolentEvent(event) {
  return riskWeight(event) >= 1.45;
}
async function fetchDataSfDataset(datasetId, limit = 5000) {
  const url = new URL(`https://data.sfgov.org/resource/${datasetId}.json`);
  url.searchParams.set('$limit', String(limit));
  const headers = {};
  if (DATASF_APP_TOKEN) headers['X-App-Token'] = DATASF_APP_TOKEN;
  return fetchJson(url.toString(), { headers });
}
async function fetchLiveEvents() {
  return withCache('live-events', CACHE_TTL_MS, async () => {
    const [callsRaw, incidentsRaw] = await Promise.all([
      fetchDataSfDataset('gnap-fj3t', 6000).catch((error) => {
        console.error('Failed fetching calls:', error.message);
        return [];
      }),
      fetchDataSfDataset('a892-4g7z', 8000).catch((error) => {
        console.error('Failed fetching incidents:', error.message);
        return [];
      }),
    ]);
    const calls = callsRaw.map((record) => normalizeSourceRecord(record, 'calls')).filter(Boolean);
    const incidents = incidentsRaw.map((record) => normalizeSourceRecord(record, 'incidents')).filter(Boolean);
    return {
      calls,
      incidents,
      refreshedAt: new Date().toISOString(),
    };
  });
}
function getCurrentSfHour() {
  const formatter = new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    hour12: false,
    timeZone: 'America/Los_Angeles',
  });
  return Number(formatter.format(new Date()));
}
function filterEvents(events, { hours = 48, violentOnly = false, source = 'all' } = {}) {
  return events.filter((event) => {
    if (source !== 'all' && event.source !== source) return false;
    if (violentOnly && !isViolentEvent(event)) return false;
    if (event.ageHours != null && event.ageHours > hours) return false;
    return true;
  });
}
function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function projectToMeters(coord, referenceLat) {
  const latRad = (referenceLat * Math.PI) / 180;
  const x = coord.lng * (111320 * Math.cos(latRad));
  const y = coord.lat * 110540;
  return { x, y };
}
function pointToSegmentDistanceMeters(point, start, end) {
  const refLat = (point.lat + start.lat + end.lat) / 3;
  const p = projectToMeters(point, refLat);
  const a = projectToMeters(start, refLat);
  const b = projectToMeters(end, refLat);
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = p.x - a.x;
  const apy = p.y - a.y;
  const ab2 = abx * abx + aby * aby;
  const t = ab2 === 0 ? 0 : clamp((apx * abx + apy * aby) / ab2, 0, 1);
  const closest = { x: a.x + abx * t, y: a.y + aby * t };
  const dx = p.x - closest.x;
  const dy = p.y - closest.y;
  return Math.sqrt(dx * dx + dy * dy);
}
function minDistanceToPolylineMeters(event, coordinates) {
  if (!coordinates || coordinates.length === 0) return Infinity;
  if (coordinates.length === 1) {
    return haversineMeters(event, { lng: coordinates[0][0], lat: coordinates[0][1] });
  }
  let min = Infinity;
  for (let i = 1; i < coordinates.length; i += 1) {
    const start = { lng: coordinates[i - 1][0], lat: coordinates[i - 1][1] };
    const end = { lng: coordinates[i][0], lat: coordinates[i][1] };
    const distance = pointToSegmentDistanceMeters(event, start, end);
    if (distance < min) min = distance;
    if (min < 15) return min;
  }
  return min;
}

function closestSegmentInfo(point, coordinates) {
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;

  let best = null;

  for (let index = 1; index < coordinates.length; index += 1) {
    const start = { lng: coordinates[index - 1][0], lat: coordinates[index - 1][1] };
    const end = { lng: coordinates[index][0], lat: coordinates[index][1] };
    const refLat = (point.lat + start.lat + end.lat) / 3;
    const p = projectToMeters(point, refLat);
    const a = projectToMeters(start, refLat);
    const b = projectToMeters(end, refLat);
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;
    const ab2 = abx * abx + aby * aby;
    const t = ab2 === 0 ? 0 : clamp((apx * abx + apy * aby) / ab2, 0, 1);
    const closestMeters = { x: a.x + abx * t, y: a.y + aby * t };
    const dx = p.x - closestMeters.x;
    const dy = p.y - closestMeters.y;
    const distanceMeters = Math.sqrt(dx * dx + dy * dy);

    if (!best || distanceMeters < best.distanceMeters) {
      best = {
        distanceMeters,
        refLat,
        startMeters: a,
        endMeters: b,
        closestMeters,
      };
    }
  }

  return best;
}

function metersToLngLat(pointMeters, referenceLat) {
  const latRad = (referenceLat * Math.PI) / 180;
  return {
    lng: pointMeters.x / (111320 * Math.cos(latRad)),
    lat: pointMeters.y / 110540,
  };
}

function buildAvoidanceWaypoint(hazard, coordinates, side) {
  const segment = closestSegmentInfo({ lat: hazard.lat, lng: hazard.lng }, coordinates);
  if (!segment) return null;

  const dx = segment.endMeters.x - segment.startMeters.x;
  const dy = segment.endMeters.y - segment.startMeters.y;
  const length = Math.sqrt(dx * dx + dy * dy);
  if (!length) return null;

  const perpendicular = {
    x: (-dy / length) * side,
    y: (dx / length) * side,
  };
  const forward = {
    x: dx / length,
    y: dy / length,
  };

  const lateralOffset = clamp(150 + (hazard.weight || 0) * 110 + Math.max(0, 180 - (hazard.distanceMeters || 180)) * 0.35, 160, 280);
  const forwardOffset = 45;

  const waypointMeters = {
    x: segment.closestMeters.x + perpendicular.x * lateralOffset + forward.x * forwardOffset,
    y: segment.closestMeters.y + perpendicular.y * lateralOffset + forward.y * forwardOffset,
  };

  const waypoint = metersToLngLat(waypointMeters, segment.refLat);
  if (
    !Number.isFinite(waypoint.lat) ||
    !Number.isFinite(waypoint.lng) ||
    waypoint.lng < SF_BOUNDS.west ||
    waypoint.lng > SF_BOUNDS.east ||
    waypoint.lat < SF_BOUNDS.south ||
    waypoint.lat > SF_BOUNDS.north
  ) {
    return null;
  }

  return waypoint;
}

function dedupeRoutes(routes) {
  const seen = new Set();
  const unique = [];

  for (const route of routes) {
    const coords = route.geometry?.coordinates || [];
    const middle = coords[Math.floor(coords.length / 2)] || [];
    const signature = [
      Math.round(Number(route.distance || 0)),
      Math.round(Number(route.duration || 0)),
      middle[0] ? middle[0].toFixed(4) : '0',
      middle[1] ? middle[1].toFixed(4) : '0',
    ].join('|');

    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(route);
  }

  return unique;
}

async function getAvoidanceDirections(origin, destination, referenceRoute) {
  const hazards = (referenceRoute?.risk?.avoidanceHazards || []).slice(0, 2);
  if (!hazards.length) return [];

  const waypointSets = [];
  for (const hazard of hazards) {
    for (const side of [-1, 1]) {
      const waypoint = buildAvoidanceWaypoint(hazard, referenceRoute.geometry?.coordinates || [], side);
      if (waypoint) {
        waypointSets.push([waypoint]);
      }
    }
  }

  const settled = await Promise.allSettled(
    waypointSets.map((waypoints) => getDirections(origin, destination, waypoints)),
  );

  return dedupeRoutes(
    settled
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => result.value),
  );
}

function summarizeReasons(eventsNearRoute) {
  const violent = eventsNearRoute.filter((event) => isViolentEvent(event));
  const byNeighborhood = new Map();
  for (const event of eventsNearRoute) {
    if (!event.neighborhood) continue;
    byNeighborhood.set(event.neighborhood, (byNeighborhood.get(event.neighborhood) || 0) + 1);
  }
  const topNeighborhood = [...byNeighborhood.entries()].sort((a, b) => b[1] - a[1])[0];
  const reasons = [];
  if (violent.length) {
    reasons.push(`${violent.length} high-severity public-safety signals near this route`);
  }
  const fresh = eventsNearRoute.filter((event) => event.ageHours != null && event.ageHours <= 6);
  if (fresh.length) {
    reasons.push(`${fresh.length} very recent events in the last 6 hours`);
  }
  if (topNeighborhood) {
    reasons.push(`activity clusters around ${topNeighborhood[0]}`);
  }
  return reasons.slice(0, 3);
}
function scoreRoute(route, events) {
  const coordinates = route.geometry?.coordinates || [];
  const nearbyEvents = [];
  let rawRisk = 0;
  let proximityBursts = 0;
  let blockingHazardScore = 0;
  let severeCorridorCount = 0;
  let legacyDangerBursts = 0;
  const nowSfHour = getCurrentSfHour();
  const isNight = nowSfHour >= 21 || nowSfHour <= 5;
  for (const event of events) {
    const distance = minDistanceToPolylineMeters({ lat: event.lat, lng: event.lng }, coordinates);
    if (distance > 700) continue;
    const base = riskWeight(event);
    const timeDecay = event.ageHours == null ? 0.8 : Math.exp(-event.ageHours / 14);
    const distanceDecay = Math.exp(-distance / 230);
    const sourceMultiplier = event.source === 'calls' ? 1.12 : 1.0;
    const nightMultiplier = isNight ? 1.1 : 1.0;
    const violent = isViolentEvent(event);
    const legacyDangerDecay = violent
      ? event.ageHours == null
        ? 0.88
        : Math.max(0.42, Math.exp(-event.ageHours / 36))
      : timeDecay;
    const corridorDecay = violent ? Math.exp(-distance / 150) : Math.exp(-distance / 210);
    const corridorContribution = violent
      ? base * legacyDangerDecay * corridorDecay * sourceMultiplier * nightMultiplier
      : 0;
    const contribution = base * timeDecay * distanceDecay * sourceMultiplier * nightMultiplier;

    rawRisk += contribution + corridorContribution * 0.85;
    blockingHazardScore += corridorContribution;

    if (distance < 180 && contribution > 0.5) proximityBursts += 1;
    if (violent && distance < 220 && corridorContribution > 0.32) severeCorridorCount += 1;
    if (violent && distance < 120 && legacyDangerDecay >= 0.42) legacyDangerBursts += 1;

    nearbyEvents.push({
      ...event,
      distanceMeters: Math.round(distance),
      contribution: contribution + corridorContribution * 0.85,
    });
  }
  const distanceKm = Math.max((route.distance || 0) / 1000, 0.25);
  const densityScore = rawRisk / Math.pow(distanceKm, 0.75);
  const preliminaryRisk =
    densityScore * 9 +
    proximityBursts * 2.5 +
    blockingHazardScore * 5.5 +
    severeCorridorCount * 3.5 +
    legacyDangerBursts * 4.5;
  const riskScore = clamp(
    Math.round(Math.pow(Math.max(preliminaryRisk, 0), 0.9) * 0.82),
    0,
    100,
  );
  const sortedEvents = nearbyEvents
    .sort((a, b) => b.contribution - a.contribution)
    .slice(0, 8)
    .map((event) => ({
      id: event.id,
      source: event.source,
      primaryType: event.primaryType,
      secondaryType: event.secondaryType,
      lat: event.lat,
      lng: event.lng,
      weight: Number(riskWeight(event).toFixed(3)),
      contribution: Number(event.contribution.toFixed(3)),
      distanceMeters: event.distanceMeters,
      neighborhood: event.neighborhood,
      ageHours: event.ageHours == null ? null : Number(event.ageHours.toFixed(1)),
    }));

  const avoidanceHazards = sortedEvents
    .filter((event) => event.weight >= 1.25 && event.distanceMeters <= 220)
    .slice(0, 4);

  return {
    rawRisk: Number(rawRisk.toFixed(3)),
    riskScore,
    blockingHazardScore: Number(blockingHazardScore.toFixed(3)),
    severeCorridorCount,
    nearbyEventCount: nearbyEvents.length,
    violentNearbyCount: nearbyEvents.filter((event) => isViolentEvent(event)).length,
    reasons: summarizeReasons(nearbyEvents),
    topEvents: sortedEvents,
    avoidanceHazards,
  };
}
function formatMinutes(seconds) {
  return Math.round(seconds / 60);
}
function chooseRoutePair(scoredRoutes) {
  if (!scoredRoutes.length) {
    throw new Error('No routes returned by the routing provider.');
  }
  const fastest = [...scoredRoutes].sort((a, b) => a.duration - b.duration)[0];
  const maxRisk = Math.max(...scoredRoutes.map((route) => route.risk.riskScore), 1);
  const maxBlockingHazard = Math.max(...scoredRoutes.map((route) => route.risk.blockingHazardScore || 0), 1);
  const minDuration = Math.min(...scoredRoutes.map((route) => route.duration));
  for (const route of scoredRoutes) {
    const normalizedRisk = route.risk.riskScore / maxRisk;
    const normalizedBlockingHazard = (route.risk.blockingHazardScore || 0) / maxBlockingHazard;
    const normalizedDuration = route.duration / minDuration;
    route.compositeScore = normalizedBlockingHazard * 0.5 + normalizedRisk * 0.35 + normalizedDuration * 0.15;
  }

  let safest = [...scoredRoutes].sort((a, b) =>
    a.risk.severeCorridorCount - b.risk.severeCorridorCount ||
    a.risk.blockingHazardScore - b.risk.blockingHazardScore ||
    a.compositeScore - b.compositeScore,
  )[0];

  const meaningfulAlternative = [...scoredRoutes]
    .filter((route) => route !== fastest)
    .filter((route) => route.duration <= fastest.duration * 1.5)
    .filter((route) =>
      route.risk.severeCorridorCount < fastest.risk.severeCorridorCount ||
      route.risk.blockingHazardScore <= fastest.risk.blockingHazardScore - 1.5 ||
      route.risk.riskScore <= fastest.risk.riskScore - 5,
    )
    .sort((a, b) =>
      a.risk.severeCorridorCount - b.risk.severeCorridorCount ||
      a.risk.blockingHazardScore - b.risk.blockingHazardScore ||
      a.compositeScore - b.compositeScore,
    )[0];

  if (meaningfulAlternative) {
    safest = meaningfulAlternative;
  }

  return { fastest, safest };
}
async function geocodeAddress(query) {
  if (!MAPBOX_ACCESS_TOKEN) {
    throw new Error('MAPBOX_ACCESS_TOKEN is missing. Add it to your .env file.');
  }

  const q = /san\s+francisco/i.test(query) ? query : `${query}, San Francisco, CA`;

  // BBox approximative de San Francisco
  const SF_BBOX = '-122.55,37.68,-122.35,37.84';
  // Proximity centrée sur downtown SF
  const SF_PROXIMITY = '-122.4194,37.7749';

  const buildUrl = (types) => {
    const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
    url.searchParams.set('q', q);
    url.searchParams.set('limit', '5');
    url.searchParams.set('access_token', MAPBOX_ACCESS_TOKEN);
    url.searchParams.set('bbox', SF_BBOX);
    url.searchParams.set('proximity', SF_PROXIMITY);
    url.searchParams.set('country', 'US');
    url.searchParams.set('language', 'en');
    if (types) {
      url.searchParams.set('types', types);
    }
    return url;
  };

  let data;
  try {
    data = await fetchJson(buildUrl('poi,address,street,place,neighborhood,locality').toString());
  } catch {
    data = await fetchJson(buildUrl('address,street,place,neighborhood,locality').toString());
  }

  const features = Array.isArray(data.features) ? data.features : [];

  function isInsideSf(lng, lat) {
    return lng >= -122.55 && lng <= -122.35 && lat >= 37.68 && lat <= 37.84;
  }

  return features.map((feature) => {
    const coords = Array.isArray(feature?.geometry?.coordinates)
      ? feature.geometry.coordinates
      : Array.isArray(feature?.center)
        ? feature.center
        : [null, null];

    return {
      label:
        feature.properties?.name ||
        feature.properties?.full_address ||
        feature.place_formatted ||
        feature.place_name ||
        'Unknown address',
      subtitle:
        feature.properties?.full_address ||
        feature.place_formatted ||
        feature.properties?.context?.place?.name ||
        '',
      lng: Number(coords[0]),
      lat: Number(coords[1]),
      relevance: Number(feature?.properties?.match_code?.confidence ?? 0),
    };
  })
  .filter((item) => Number.isFinite(item.lat) && Number.isFinite(item.lng))
  .filter((item) => isInsideSf(item.lng, item.lat));
}
async function getDirections(origin, destination, waypoints = []) {
  if (!MAPBOX_ACCESS_TOKEN) {
    throw new Error('MAPBOX_ACCESS_TOKEN is missing. Add it to your .env file.');
  }

  const allPoints = [origin, ...waypoints, destination];
  const coords = allPoints.map((point) => `${point.lng},${point.lat}`).join(';');
  const url = new URL(`https://api.mapbox.com/directions/v5/mapbox/walking/${coords}`);
  url.searchParams.set('alternatives', 'true');
  url.searchParams.set('geometries', 'geojson');
  url.searchParams.set('overview', 'full');
  url.searchParams.set('steps', 'true');
  url.searchParams.set('language', 'en');
  url.searchParams.set('access_token', MAPBOX_ACCESS_TOKEN);
  const data = await fetchJson(url.toString());
  if (!Array.isArray(data.routes) || !data.routes.length) {
    throw new Error('Directions provider returned no routes.');
  }
  return data.routes;
}
function deterministicBrief(summary) {
  const deltaMinutes = summary.safer.durationMinutes - summary.fastest.durationMinutes;
  const deltaRisk = summary.fastest.riskScore - summary.safer.riskScore;
  const headline = deltaRisk > 0
    ? `Safer route cuts risk by ${deltaRisk} points for ${deltaMinutes >= 0 ? '+' : ''}${deltaMinutes} min.`
    : 'Fastest route is already the best trade-off right now.';
  const tips = [];
  if (summary.safer.reasons?.length) tips.push(`Avoids: ${summary.safer.reasons[0]}`);
  if (summary.fastest.reasons?.length) tips.push(`Fast route risk comes from: ${summary.fastest.reasons[0]}`);
  tips.push('Use this as risk-aware routing, not a guarantee of safety.');
  return {
    headline,
    verdict: deltaRisk > 0 ? 'Take the safer route if you can spare the extra minutes.' : 'The fastest route is acceptable based on current signals.',
    explanation: `Fastest is ${summary.fastest.durationMinutes} min with risk ${summary.fastest.riskScore}/100. Safer is ${summary.safer.durationMinutes} min with risk ${summary.safer.riskScore}/100.`,
    tips: tips.slice(0, 3),
  };
}
function extractMistralText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((chunk) => {
        if (typeof chunk === 'string') return chunk;
        if (chunk?.text) return chunk.text;
        if (chunk?.content) return chunk.content;
        return '';
      })
      .join('')
      .trim();
  }
  return '';
}
async function generateAiBrief(summary) {
  if (!MISTRAL_API_KEY) {
    return { provider: 'fallback', ...deterministicBrief(summary) };
  }
  const prompt = {
    product: 'SafeRoute SF',
    city: 'San Francisco',
    summary,
    instructions: [
      'Return valid JSON with keys: headline, verdict, explanation, tips.',
      'headline and verdict should each be under 18 words.',
      'explanation should be 2 concise sentences.',
      'tips should be an array of exactly 3 short strings.',
      'Do not claim certainty or guaranteed safety.',
      'Frame this as risk-aware guidance based on recent public-safety signals.',
    ],
  };
  const response = await fetchJson('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a concise civic mobility analyst. Explain route tradeoffs clearly and responsibly. Never guarantee safety.',
        },
        {
          role: 'user',
          content: JSON.stringify(prompt),
        },
      ],
    }),
  });
  const rawText = extractMistralText(response);
  if (!rawText) {
    return { provider: 'fallback', ...deterministicBrief(summary) };
  }
  try {
    const parsed = JSON.parse(rawText);
    return {
      provider: 'mistral',
      headline: normalizeText(parsed.headline) || deterministicBrief(summary).headline,
      verdict: normalizeText(parsed.verdict) || deterministicBrief(summary).verdict,
      explanation: normalizeText(parsed.explanation) || deterministicBrief(summary).explanation,
      tips: Array.isArray(parsed.tips) ? parsed.tips.map((item) => normalizeText(item)).filter(Boolean).slice(0, 3) : deterministicBrief(summary).tips,
    };
  } catch {
    return { provider: 'fallback', ...deterministicBrief(summary) };
  }
}
async function askMistral(question, context) {
  if (!MISTRAL_API_KEY) {
    return {
      provider: 'fallback',
      answer:
        'Mistral is not configured yet. Add MISTRAL_API_KEY in .env to enable the live neighborhood and route Q&A panel.',
    };
  }
  const payload = {
    question,
    context,
    instructions: [
      'Answer in 3 short paragraphs max.',
      'Use only the provided context. If evidence is thin, say so.',
      'Never claim a neighborhood is objectively safe or unsafe. Use phrases like risk-aware or higher recent activity.',
    ],
  };
  const response = await fetchJson('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MISTRAL_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MISTRAL_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are the AI copilot for a civic safety map. Be careful, factual, concise, and avoid overstating certainty.',
        },
        {
          role: 'user',
          content: JSON.stringify(payload),
        },
      ],
    }),
  });
  const answer = extractMistralText(response).trim();
  return {
    provider: 'mistral',
    answer: answer || 'No answer returned by Mistral.',
  };
}
function buildComparisonSummary(fastest, safer) {
  return {
    generatedAt: new Date().toISOString(),
    fastest: {
      durationMinutes: formatMinutes(fastest.duration),
      distanceKm: Number((fastest.distance / 1000).toFixed(2)),
      riskScore: fastest.risk.riskScore,
      nearbyEvents: fastest.risk.nearbyEventCount,
      violentNearby: fastest.risk.violentNearbyCount,
      reasons: fastest.risk.reasons,
    },
    safer: {
      durationMinutes: formatMinutes(safer.duration),
      distanceKm: Number((safer.distance / 1000).toFixed(2)),
      riskScore: safer.risk.riskScore,
      nearbyEvents: safer.risk.nearbyEventCount,
      violentNearby: safer.risk.violentNearbyCount,
      reasons: safer.risk.reasons,
    },
  };
}
async function handleRouteCompare(body) {
  const originInput = body?.origin;
  const destinationInput = body?.destination;
  if (!originInput || !destinationInput) {
    throw new Error('origin and destination are required.');
  }
  const origin = {
    lat: Number(originInput?.lat),
    lng: Number(originInput?.lng),
  };
  const destination = {
    lat: Number(destinationInput?.lat),
    lng: Number(destinationInput?.lng),
  };
  if (![origin.lat, origin.lng, destination.lat, destination.lng].every((value) => Number.isFinite(value))) {
    throw new Error('origin/destination coordinates are invalid.');
  }
  assertSfPoint(origin, 'Origin');
  assertSfPoint(destination, 'Destination');
  const [routes, live] = await Promise.all([
    getDirections(origin, destination),
    fetchLiveEvents(),
  ]);
  const liveEvents = filterEvents([...live.calls, ...live.incidents], {
    hours: Number(body?.windowHours || 48),
    violentOnly: Boolean(body?.violentOnly),
    source: 'all',
  });
  let scoredRoutes = routes.map((route, index) => {
    const risk = scoreRoute(route, liveEvents);
    return {
      id: `route-${index + 1}`,
      distance: route.distance,
      duration: route.duration,
      geometry: route.geometry,
      legs: route.legs || [],
      risk,
    };
  });

  let { fastest, safest } = chooseRoutePair(scoredRoutes);

  if (safest.risk.severeCorridorCount >= 2 || safest.risk.blockingHazardScore >= 2) {
    const avoidanceRoutes = await getAvoidanceDirections(origin, destination, safest);
    if (avoidanceRoutes.length) {
      const augmentedRoutes = avoidanceRoutes.map((route, index) => ({
        id: `detour-${index + 1}`,
        distance: route.distance,
        duration: route.duration,
        geometry: route.geometry,
        legs: route.legs || [],
        risk: scoreRoute(route, liveEvents),
      }));

      scoredRoutes = dedupeRoutes([...scoredRoutes, ...augmentedRoutes]);
      ({ fastest, safest } = chooseRoutePair(scoredRoutes));
    }
  }

  const summary = buildComparisonSummary(fastest, safest);
  const ai = await generateAiBrief(summary).catch((error) => ({
    provider: 'fallback',
    ...deterministicBrief(summary),
    warning: error.message,
  }));
  return {
    summary,
    ai,
    routes: {
      fastest,
      safer: safest,
      alternatives: scoredRoutes,
    },
    live: {
      counts: {
        calls: live.calls.length,
        incidents: live.incidents.length,
        filteredContext: liveEvents.length,
      },
      refreshedAt: live.refreshedAt,
    },
    disclaimer:
      'This app provides risk-aware routing based on recent public-safety signals. It does not predict crime and cannot guarantee safety.',
  };
}
function buildAskContext(body) {
  return {
    city: 'San Francisco',
    routeSummary: body?.routeSummary || null,
    mapFocus: body?.mapFocus || null,
    liveContext: body?.liveContext || null,
  };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'saferoute-sf',
        hasMapbox: Boolean(MAPBOX_ACCESS_TOKEN),
        hasMistral: Boolean(MISTRAL_API_KEY),
      });
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, {
        city: 'San Francisco',
        center: SF_CENTER,
        bounds: SF_BOUNDS,
        hasMapbox: Boolean(MAPBOX_ACCESS_TOKEN),
        hasMistral: Boolean(MISTRAL_API_KEY),
        mistralModel: MISTRAL_MODEL,
      });
    }
    if (req.method === 'GET' && pathname === '/api/geocode') {
      const q = normalizeText(url.searchParams.get('q'));
      if (!q) return sendError(res, 400, 'Missing q parameter.');
      const results = await geocodeAddress(q);
      return sendJson(res, 200, { query: q, results });
    }
    if (req.method === 'GET' && pathname === '/api/live') {
      const live = await fetchLiveEvents();
      const hours = clamp(Number(url.searchParams.get('hours') || 48), 1, 336);
      const violentOnly = url.searchParams.get('violentOnly') === 'true';
      const source = url.searchParams.get('source') || 'all';
      const events = filterEvents([...live.calls, ...live.incidents], { hours, violentOnly, source });
      return sendJson(res, 200, {
        refreshedAt: live.refreshedAt,
        filters: { hours, violentOnly, source },
        stats: {
          total: events.length,
          violent: events.filter((event) => isViolentEvent(event)).length,
          calls: events.filter((event) => event.source === 'calls').length,
          incidents: events.filter((event) => event.source === 'incidents').length,
        },
        events: events
          .sort((a, b) => (a.ageHours ?? 999) - (b.ageHours ?? 999))
          .slice(0, 700)
          .map((event) => ({
            ...event,
            severity: riskWeight(event),
          })),
      });
    }
    if (req.method === 'GET' && pathname === '/api/risk-grid') {
      try {
        const live = await fetchLiveEvents();
        const incidents = [...live.calls, ...live.incidents].map((event) => ({
          ...event,
          callType: event.primaryType,
        }));
        const grid = buildRiskGrid(incidents, { cellSize: 0.01 });
        return sendJson(res, 200, grid);
      } catch (error) {
        return sendJson(res, 500, { error: error.message || 'Failed to build risk grid' });
      }
    }
    if (req.method === 'POST' && pathname === '/api/route/compare') {
      const body = await parseBody(req);
      const result = await handleRouteCompare(body);
      return sendJson(res, 200, result);
    }
    if (req.method === 'POST' && pathname === '/api/ai/ask') {
      const body = await parseBody(req);
      const question = normalizeText(body?.question);
      if (!question) return sendError(res, 400, 'question is required.');
      const result = await askMistral(question, buildAskContext(body));
      return sendJson(res, 200, result);
    }
    if (req.method === 'GET') {
      return serveStatic(req, res, pathname);
    }
    sendError(res, 405, 'Method not allowed.');
  } catch (error) {
    console.error(error);
    sendError(res, 500, error);
  }
});
server.listen(PORT, () => {
  console.log(`SafeRoute SF running at http://localhost:${PORT}`);
});
