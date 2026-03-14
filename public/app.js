const MAPBOX_STYLE_OWNER = 'crbzzz';
const MAPBOX_STYLE_ID = 'cmmpojlnj00ip01sp48ee8glr';
const MAPBOX_PUBLIC_TOKEN = 'pk.eyJ1IjoiY3Jienp6IiwiYSI6ImNtbXBuZjI5aDBwMm0ycXE2cGFkZHEzcjEifQ.elZd1th-WZW7WHV0xQyx0g';
const REPORT_STORAGE_KEY = 'safe-route-sf-reports';

const state = {
  config: null,
  map: null,
  liveHeatLayer: null,
  liveLayer: null,
  routeLayer: null,
  reportLayer: null,
  userLayer: null,
  liveData: null,
  comparison: null,
  activeRouteKey: 'safer',
  suggestions: {
    origin: [],
    destination: [],
  },
  suggestionTimers: {
    origin: null,
    destination: null,
  },
  selectedPlaces: {
    origin: null,
    destination: null,
  },
  useMyLocation: true,
  currentPosition: null,
  heading: null,
  watchId: null,
  followUser: true,
  activeSheet: null,
  activeSelectMenu: null,
  reports: [],
  chatMessages: [
    {
      role: 'assistant',
      text: 'Ask about the route, nearby incidents, or whether a block looks calm right now.',
    },
  ],
};

const els = {};

document.addEventListener('DOMContentLoaded', async () => {
  bindElements();
  attachEvents();
  await bootstrap();
});

function bindElements() {
  [
    'map',
    'appShell',
    'sheetBackdrop',
    'statusText',
    'settingsButton',
    'settingsSheet',
    'settingsCloseButton',
    'settingsReportButton',
    'settingsChatButton',
    'navCard',
    'routeModeLabel',
    'etaRemaining',
    'distanceRemaining',
    'riskSummary',
    'nextInstruction',
    'saferRouteButton',
    'fastestRouteButton',
    'stopRouteButton',
    'routeForm',
    'useMyLocationButton',
    'originToggleButton',
    'swapButton',
    'originField',
    'originInput',
    'originSuggestions',
    'destinationInput',
    'destinationSuggestions',
    'hoursSelect',
    'hoursSelectButton',
    'hoursSelectLabel',
    'hoursSelectMenu',
    'sourceSelect',
    'sourceSelectButton',
    'sourceSelectLabel',
    'sourceSelectMenu',
    'violentOnlyInput',
    'compareButton',
    'totalEvents',
    'violentEvents',
    'callEvents',
    'incidentEvents',
    'bottomSheet',
    'reportSheet',
    'reportCloseButton',
    'reportTypeSelect',
    'reportNoteInput',
    'reportSubmitButton',
    'reportStatus',
    'chatSheet',
    'chatCloseButton',
    'chatMessages',
    'chatForm',
    'askInput',
    'askButton',
  ].forEach((id) => {
    els[id] = document.getElementById(id);
  });
}

function attachEvents() {
  els.routeForm.addEventListener('submit', onCompareRoute);
  els.useMyLocationButton.addEventListener('click', toggleUseMyLocation);
  els.originToggleButton.addEventListener('click', toggleOriginField);
  els.swapButton.addEventListener('click', swapLocations);
  els.hoursSelect.addEventListener('change', loadLiveLayer);
  els.sourceSelect.addEventListener('change', loadLiveLayer);
  els.hoursSelectButton.addEventListener('click', () => toggleSelectMenu('hours'));
  els.sourceSelectButton.addEventListener('click', () => toggleSelectMenu('source'));
  els.hoursSelectMenu.addEventListener('click', onSelectOptionClick);
  els.sourceSelectMenu.addEventListener('click', onSelectOptionClick);
  els.violentOnlyInput.addEventListener('change', loadLiveLayer);
  els.destinationInput.addEventListener('input', () => queueSuggestions('destination'));
  els.originInput.addEventListener('input', () => queueSuggestions('origin'));
  els.destinationSuggestions.addEventListener('mousedown', onSuggestionPick);
  els.originSuggestions.addEventListener('mousedown', onSuggestionPick);
  els.saferRouteButton.addEventListener('click', () => setActiveRoute('safer'));
  els.fastestRouteButton.addEventListener('click', () => setActiveRoute('fastest'));
  els.stopRouteButton.addEventListener('click', clearNavigation);
  els.settingsButton.addEventListener('click', () => toggleSheet('settings', true));
  els.settingsCloseButton.addEventListener('click', () => toggleSheet('settings', false));
  els.settingsChatButton.addEventListener('click', () => toggleSheet('chat', true));
  els.settingsReportButton.addEventListener('click', () => toggleSheet('report', true));
  els.chatCloseButton.addEventListener('click', () => toggleSheet('chat', false));
  els.chatForm.addEventListener('submit', onAskAi);
  els.reportCloseButton.addEventListener('click', () => toggleSheet('report', false));
  els.reportSubmitButton.addEventListener('click', submitReport);
  els.sheetBackdrop.addEventListener('click', closeActiveSheet);

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      closeSelectMenus();
      closeActiveSheet();
    }
  });

  document.addEventListener('click', (event) => {
    if (!els.destinationSuggestions.contains(event.target) && event.target !== els.destinationInput) {
      renderSuggestions('destination', []);
    }
    if (!els.originSuggestions.contains(event.target) && event.target !== els.originInput) {
      renderSuggestions('origin', []);
    }

    if (!event.target.closest('.custom-select')) {
      closeSelectMenus();
    }
  });
}

async function bootstrap() {
  try {
    state.config = await safeFetch('/api/config');
    initMap();
    loadReportsFromStorage();
    renderReports();
    renderChatMessages();
    syncSelectLabels();
    updateUseMyLocationState();
    await loadLiveLayer();
    startLocationTracking();

    setInterval(() => {
      loadLiveLayer().catch((error) => setStatus(error.message || String(error)));
    }, 60000);
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function initMap() {
  const center = state.config?.center || { lat: 37.7749, lng: -122.4194 };
  state.map = L.map('map', {
    attributionControl: false,
    zoomControl: false,
    zoomSnap: 0.2,
    zoomDelta: 0.25,
    preferCanvas: true,
  }).setView([center.lat, center.lng], 13.4);

  createMapPanes();

  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    maxZoom: 20,
    opacity: 0.88,
  }).addTo(state.map);

  L.tileLayer(
    `https://api.mapbox.com/styles/v1/${MAPBOX_STYLE_OWNER}/${MAPBOX_STYLE_ID}/tiles/512/{z}/{x}/{y}@2x?access_token=${MAPBOX_PUBLIC_TOKEN}`,
    {
      attribution: '&copy; Mapbox &copy; OpenStreetMap contributors',
      tileSize: 512,
      zoomOffset: -1,
      maxZoom: 20,
      opacity: 0.68,
    },
  ).addTo(state.map);

  state.map.on('zoomend', () => {
    if (state.liveData) {
      renderLiveLayer(state.liveData);
    }
  });
  state.map.on('dragstart', () => {
    state.followUser = false;
  });

  state.liveLayer = L.layerGroup().addTo(state.map);
  state.routeLayer = L.layerGroup().addTo(state.map);
  state.reportLayer = L.layerGroup().addTo(state.map);
  state.userLayer = L.layerGroup().addTo(state.map);
  syncShellState();
}

function createMapPanes() {
  const panes = [
    ['incidents-heat-pane', 320],
    ['incidents-pane', 360],
    ['reports-pane', 390],
    ['route-secondary-pane', 410],
    ['route-primary-pane', 420],
    ['user-pane', 430],
  ];

  for (const [name, zIndex] of panes) {
    if (!state.map.getPane(name)) {
      state.map.createPane(name);
    }
    state.map.getPane(name).style.zIndex = String(zIndex);
  }

  state.map.getPane('incidents-heat-pane').style.pointerEvents = 'none';
}

async function loadLiveLayer() {
  const params = new URLSearchParams({
    hours: els.hoursSelect.value,
    source: els.sourceSelect.value,
    violentOnly: String(els.violentOnlyInput.checked),
  });

  const data = await safeFetch(`/api/live?${params.toString()}`);
  state.liveData = data;
  renderLiveLayer(data);
}

function toggleSelectMenu(selectName) {
  state.activeSelectMenu = state.activeSelectMenu === selectName ? null : selectName;
  syncSelectMenus();
}

function closeSelectMenus() {
  if (!state.activeSelectMenu) return;
  state.activeSelectMenu = null;
  syncSelectMenus();
}

function syncSelectMenus() {
  const hoursOpen = state.activeSelectMenu === 'hours';
  const sourceOpen = state.activeSelectMenu === 'source';

  els.hoursSelectMenu.classList.toggle('hidden', !hoursOpen);
  els.sourceSelectMenu.classList.toggle('hidden', !sourceOpen);
  els.hoursSelectButton.classList.toggle('open', hoursOpen);
  els.sourceSelectButton.classList.toggle('open', sourceOpen);
  els.hoursSelectButton.setAttribute('aria-expanded', String(hoursOpen));
  els.sourceSelectButton.setAttribute('aria-expanded', String(sourceOpen));
}

function syncSelectLabels() {
  els.hoursSelectLabel.textContent = els.hoursSelect.options[els.hoursSelect.selectedIndex]?.textContent || '48h';
  els.sourceSelectLabel.textContent = els.sourceSelect.options[els.sourceSelect.selectedIndex]?.textContent || 'All';
  updateSelectOptionState('hours');
  updateSelectOptionState('source');
}

function updateSelectOptionState(selectName) {
  const currentValue = els[`${selectName}Select`].value;
  const menu = els[`${selectName}SelectMenu`];
  for (const option of menu.querySelectorAll('.select-option')) {
    option.classList.toggle('active', option.dataset.value === currentValue);
  }
}

function onSelectOptionClick(event) {
  const option = event.target.closest('.select-option');
  if (!option) return;

  const selectName = option.dataset.select;
  const select = els[`${selectName}Select`];
  if (!select) return;

  select.value = option.dataset.value;
  syncSelectLabels();
  closeSelectMenus();
  loadLiveLayer().catch((error) => setStatus(error.message || String(error)));
}

function renderLiveLayer(data) {
  state.liveLayer.clearLayers();

  if (state.liveHeatLayer) {
    state.map.removeLayer(state.liveHeatLayer);
    state.liveHeatLayer = null;
  }

  els.totalEvents.textContent = String(data.stats.total);
  els.violentEvents.textContent = String(data.stats.violent);
  els.callEvents.textContent = String(data.stats.calls);
  els.incidentEvents.textContent = String(data.stats.incidents);
  setStatus(`Updated ${formatRelativeTime(data.refreshedAt)}`);

  const weightedEvents = data.events.map((event) => ({
    ...event,
    weight: severityToWeight(event.severity),
  }));

  state.liveHeatLayer = L.heatLayer(
    weightedEvents.map((event) => [event.lat, event.lng, event.weight]),
    {
      pane: 'incidents-heat-pane',
      radius: 18,
      blur: 18,
      minOpacity: 0.06,
      max: 1.35,
      gradient: {
        0.18: '#1d4ed8',
        0.35: '#facc15',
        0.58: '#f97316',
        0.78: '#f43f5e',
        1: '#e11d48',
      },
    },
  ).addTo(state.map);

  if (state.map.getZoom() < 14.2) {
    return;
  }

  const visibleEvents = [...weightedEvents]
    .sort((a, b) => (b.weight || 0) - (a.weight || 0))
    .slice(0, 120);

  for (const event of visibleEvents) {
    const glow = L.circleMarker([event.lat, event.lng], {
      pane: 'incidents-pane',
      radius: 5 + event.weight * 6,
      stroke: false,
      fillColor: incidentGlowColor(event.weight),
      fillOpacity: 0.04,
      interactive: false,
    });

    const marker = L.circleMarker([event.lat, event.lng], {
      pane: 'incidents-pane',
      radius: 1.5 + event.weight * 2.4,
      color: 'rgba(255,255,255,0.12)',
      fillColor: incidentCoreColor(event.weight),
      fillOpacity: 0.28,
      opacity: 0.22,
      weight: 1,
    });

    marker.bindPopup(createIncidentPopupHtml(event));
    glow.addTo(state.liveLayer);
    marker.addTo(state.liveLayer);
  }
}

function startLocationTracking() {
  if (!navigator.geolocation) {
    setStatus('Geolocation is not available on this device.');
    return;
  }

  state.watchId = navigator.geolocation.watchPosition(
    (position) => {
      state.currentPosition = {
        lat: position.coords.latitude,
        lng: position.coords.longitude,
        accuracy: position.coords.accuracy,
      };
      updateUserLocationRendering();
      if (state.followUser) {
        if (state.comparison) {
          focusActiveRoute(true);
        } else {
          state.map.setView([state.currentPosition.lat, state.currentPosition.lng], Math.max(state.map.getZoom(), 15), {
            animate: true,
          });
        }
      }
      updateNavigationMetrics();
    },
    (error) => {
      setStatus(error.message || 'Unable to read your position.');
    },
    {
      enableHighAccuracy: true,
      maximumAge: 5000,
      timeout: 15000,
    },
  );
}

function updateUserLocationRendering() {
  if (!state.currentPosition) return;
  state.userLayer.clearLayers();

  const { lat, lng, accuracy } = state.currentPosition;
  L.circle([lat, lng], {
    pane: 'user-pane',
    radius: Math.min(Math.max(accuracy || 0, 14), 70),
    color: 'rgba(56,189,248,0.2)',
    fillColor: 'rgba(56,189,248,0.1)',
    fillOpacity: 0.14,
    weight: 1,
  }).addTo(state.userLayer);

  L.marker([lat, lng], {
    pane: 'user-pane',
    icon: createUserIcon(state.heading),
  }).addTo(state.userLayer);

  if (Number.isFinite(state.heading)) {
    const target = projectHeadingPoint(state.currentPosition, state.heading, 120);
    L.polyline(
      [
        [lat, lng],
        [target.lat, target.lng],
      ],
      {
        pane: 'user-pane',
        color: 'rgba(56,189,248,0.45)',
        weight: 3,
        opacity: 0.8,
      },
    ).addTo(state.userLayer);
  }
}

function createUserIcon(heading) {
  const safeHeading = Number.isFinite(heading) ? heading : 0;
  return L.divIcon({
    className: 'user-marker-shell',
    html: `
      <div class="user-marker">
        <div class="user-marker-core"></div>
        <div class="user-marker-arrow" style="transform: rotate(${safeHeading}deg)"></div>
      </div>
    `,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  });
}

async function requestHeadingAccess() {
  try {
    if (typeof DeviceOrientationEvent === 'undefined') {
      setStatus('Heading is not available on this device.');
      return;
    }

    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const permission = await DeviceOrientationEvent.requestPermission();
      if (permission !== 'granted') {
        setStatus('Heading permission was denied.');
        return;
      }
    }

    window.removeEventListener('deviceorientationabsolute', onDeviceOrientation);
    window.removeEventListener('deviceorientation', onDeviceOrientation);
    window.addEventListener('deviceorientationabsolute', onDeviceOrientation);
    window.addEventListener('deviceorientation', onDeviceOrientation);
    setStatus('Phone heading linked.');
  } catch (error) {
    setStatus(error.message || 'Unable to enable heading.');
  }
}

function onDeviceOrientation(event) {
  const nextHeading = Number.isFinite(event.webkitCompassHeading)
    ? event.webkitCompassHeading
    : Number.isFinite(event.alpha)
      ? (360 - event.alpha + 360) % 360
      : null;

  if (!Number.isFinite(nextHeading)) return;
  state.heading = nextHeading;
  updateUserLocationRendering();
}

function recenterOnUser() {
  state.followUser = true;
  if (!state.currentPosition) {
    setStatus('Waiting for your location.');
    return;
  }
  state.map.setView([state.currentPosition.lat, state.currentPosition.lng], Math.max(state.map.getZoom(), 15), {
    animate: true,
  });
}

function toggleUseMyLocation() {
  state.useMyLocation = !state.useMyLocation;
  updateUseMyLocationState();
}

function updateUseMyLocationState() {
  els.useMyLocationButton.classList.toggle('active', state.useMyLocation);
  if (state.useMyLocation && state.currentPosition) {
    els.originInput.value = 'My location';
    els.originField.classList.add('hidden');
    return;
  }

  if (!state.useMyLocation && els.originInput.value === 'My location') {
    els.originInput.value = '';
  }
}

function toggleOriginField() {
  const nextHidden = !els.originField.classList.contains('hidden');
  els.originField.classList.toggle('hidden', nextHidden);
  if (!nextHidden) {
    state.useMyLocation = false;
    updateUseMyLocationState();
    els.originInput.focus();
  }
}

function swapLocations() {
  if (state.useMyLocation) {
    state.useMyLocation = false;
  }
  const currentOrigin = els.originInput.value;
  els.originInput.value = els.destinationInput.value;
  els.destinationInput.value = currentOrigin;
  const selectedOrigin = state.selectedPlaces.origin;
  state.selectedPlaces.origin = state.selectedPlaces.destination;
  state.selectedPlaces.destination = selectedOrigin;
  els.originField.classList.remove('hidden');
  updateUseMyLocationState();
}

function queueSuggestions(field) {
  const input = els[`${field}Input`];
  const query = input.value.trim();
  state.selectedPlaces[field] = null;
  clearTimeout(state.suggestionTimers[field]);

  if (field === 'origin' && state.useMyLocation && query === 'My location') {
    renderSuggestions(field, []);
    return;
  }

  if (query.length < 2) {
    renderSuggestions(field, []);
    return;
  }

  state.suggestionTimers[field] = setTimeout(async () => {
    try {
      const data = await safeFetch(`/api/geocode?q=${encodeURIComponent(query)}`);
      const results = Array.isArray(data.results) ? data.results : [];
      state.suggestions[field] = results;
      renderSuggestions(field, results);
    } catch (error) {
      renderSuggestions(field, []);
      setStatus(error.message || String(error));
    }
  }, 180);
}

function renderSuggestions(field, results) {
  const container = els[`${field}Suggestions`];
  container.innerHTML = '';
  container.classList.toggle('hidden', results.length === 0);

  for (const [index, place] of results.entries()) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'suggestion-item';
    button.dataset.field = field;
    button.dataset.index = String(index);
    button.innerHTML = place.subtitle
      ? `<strong>${escapeHtml(place.label)}</strong><span>${escapeHtml(place.subtitle)}</span>`
      : `<strong>${escapeHtml(place.label)}</strong>`;
    container.appendChild(button);
  }
}

function onSuggestionPick(event) {
  const button = event.target.closest('.suggestion-item');
  if (!button) return;
  event.preventDefault();

  const field = button.dataset.field;
  const index = Number(button.dataset.index);
  const place = state.suggestions[field]?.[index];
  if (!place) return;

  state.selectedPlaces[field] = place;
  els[`${field}Input`].value = place.label;
  renderSuggestions(field, []);
}

async function onCompareRoute(event) {
  event.preventDefault();

  try {
    setBusy(els.compareButton, true, 'Building route...');

    const destination = await resolvePlace('destination');
    if (!destination) {
      throw new Error('Choose a destination in San Francisco.');
    }

    let origin = null;
    if (state.useMyLocation) {
      if (!state.currentPosition) {
        throw new Error('Waiting for your location.');
      }
      origin = {
        lat: state.currentPosition.lat,
        lng: state.currentPosition.lng,
        label: 'My location',
      };
    } else {
      origin = await resolvePlace('origin');
      if (!origin) {
        throw new Error('Choose an origin in San Francisco.');
      }
    }

    const comparison = await safeFetch('/api/route/compare', {
      method: 'POST',
      body: JSON.stringify({
        origin,
        destination,
        windowHours: Number(els.hoursSelect.value),
        violentOnly: els.violentOnlyInput.checked,
      }),
    });

    state.selectedPlaces.origin = origin;
    state.selectedPlaces.destination = destination;
    state.comparison = enrichComparison(comparison);
    state.activeRouteKey = 'safer';
    state.followUser = true;
    renderNavigation();
    updateNavigationMetrics();
    toggleSheet('chat', false);
    toggleSheet('report', false);
  } catch (error) {
    setStatus(error.message || String(error));
  } finally {
    setBusy(els.compareButton, false, 'Start safer route');
  }
}

async function resolvePlace(field) {
  if (state.selectedPlaces[field]) {
    return state.selectedPlaces[field];
  }
  const query = els[`${field}Input`].value.trim();
  if (!query) return null;
  const data = await safeFetch(`/api/geocode?q=${encodeURIComponent(query)}`);
  return Array.isArray(data.results) ? data.results[0] || null : null;
}

function enrichComparison(comparison) {
  return {
    ...comparison,
    routes: {
      ...comparison.routes,
      fastest: enrichRoute(comparison.routes.fastest),
      safer: enrichRoute(comparison.routes.safer),
    },
  };
}

function enrichRoute(route) {
  const coordinates = route.geometry?.coordinates || [];
  const cumulativeDistances = [0];
  let runningDistance = 0;
  for (let index = 1; index < coordinates.length; index += 1) {
    runningDistance += haversineMeters(
      { lat: coordinates[index - 1][1], lng: coordinates[index - 1][0] },
      { lat: coordinates[index][1], lng: coordinates[index][0] },
    );
    cumulativeDistances.push(runningDistance);
  }

  const steps = [];
  let cumulativeStepDistance = 0;
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      cumulativeStepDistance += Number(step.distance || 0);
      steps.push({
        cumulativeDistance: cumulativeStepDistance,
        instruction: step.maneuver?.instruction || step.name || 'Continue',
      });
    }
  }

  return {
    ...route,
    coordinates,
    latLngs: coordinates.map((coord) => [coord[1], coord[0]]),
    cumulativeDistances,
    computedDistance: runningDistance,
    steps,
  };
}

function renderNavigation() {
  if (!state.comparison) return;

  state.routeLayer.clearLayers();
  els.navCard.classList.remove('hidden');
  syncShellState();
  els.saferRouteButton.classList.toggle('active', state.activeRouteKey === 'safer');
  els.fastestRouteButton.classList.toggle('active', state.activeRouteKey === 'fastest');

  const fasterRoute = state.comparison.routes.fastest;
  const saferRoute = state.comparison.routes.safer;

  if (state.activeRouteKey === 'safer') {
    drawSecondaryRoute(fasterRoute.latLngs, 'rgba(148,163,184,0.52)');
    drawPrimaryRoute(saferRoute.latLngs, '#38bdf8');
  } else {
    drawSecondaryRoute(saferRoute.latLngs, 'rgba(56,189,248,0.4)');
    drawPrimaryRoute(fasterRoute.latLngs, '#f8fafc');
  }

  renderRoutePins();
  focusActiveRoute(false);
}

function drawSecondaryRoute(latLngs, color) {
  L.polyline(latLngs, {
    pane: 'route-secondary-pane',
    color,
    weight: 4,
    opacity: 0.7,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(state.routeLayer);
}

function drawPrimaryRoute(latLngs, color) {
  L.polyline(latLngs, {
    pane: 'route-primary-pane',
    color: 'rgba(56,189,248,0.2)',
    weight: 16,
    opacity: 0.9,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(state.routeLayer);

  L.polyline(latLngs, {
    pane: 'route-primary-pane',
    color,
    weight: 7,
    opacity: 0.95,
    lineJoin: 'round',
    lineCap: 'round',
  }).addTo(state.routeLayer);

  L.polyline(latLngs, {
    pane: 'route-primary-pane',
    color: 'rgba(255,255,255,0.32)',
    weight: 2,
    opacity: 0.8,
    lineJoin: 'round',
    lineCap: 'round',
    dashArray: '4 6',
  }).addTo(state.routeLayer);
}

function renderRoutePins() {
  const origin = state.selectedPlaces.origin;
  const destination = state.selectedPlaces.destination;
  if (!destination) return;

  if (!state.useMyLocation && origin) {
    L.marker([origin.lat, origin.lng], {
      pane: 'user-pane',
      icon: createPinIcon('start'),
    }).addTo(state.routeLayer);
  }

  L.marker([destination.lat, destination.lng], {
    pane: 'user-pane',
    icon: createPinIcon('end'),
  }).addTo(state.routeLayer);
}

function createPinIcon(type) {
  return L.divIcon({
    className: 'pin-shell',
    html: `<div class="marker marker-${type}"><div class="marker-inner"></div></div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
}

function setActiveRoute(routeKey) {
  if (!state.comparison) return;
  state.activeRouteKey = routeKey;
  renderNavigation();
  updateNavigationMetrics();
}

function updateNavigationMetrics() {
  if (!state.comparison) return;

  const route = state.comparison.routes[state.activeRouteKey];
  const progress = computeRouteProgress(route, state.currentPosition);

  els.routeModeLabel.textContent = state.activeRouteKey === 'safer' ? 'Safer route' : 'Fastest route';
  els.etaRemaining.textContent = `${formatMinutes(progress.remainingSeconds)} min left`;
  els.distanceRemaining.textContent = `${formatDistance(progress.remainingDistanceMeters)} left`;
  els.riskSummary.textContent = `Risk ${route.risk.riskScore}/100`;
  els.nextInstruction.textContent = progress.nextInstruction;

  if (!state.activeSheet) {
    focusActiveRoute(Boolean(state.currentPosition && state.followUser));
  }
}

function focusActiveRoute(preferFollowUser) {
  if (!state.comparison || !state.map) return;

  const route = state.comparison.routes[state.activeRouteKey];
  if (!route?.latLngs?.length) return;

  const bounds = L.latLngBounds(route.latLngs);
  if (state.currentPosition) {
    bounds.extend([state.currentPosition.lat, state.currentPosition.lng]);
  }

  const topPadding = state.activeSheet ? 88 : 190;
  const bottomPadding = state.activeSheet ? 28 : 36;

  state.map.fitBounds(bounds.pad(0.14), {
    animate: true,
    paddingTopLeft: [18, topPadding],
    paddingBottomRight: [18, bottomPadding],
    maxZoom: preferFollowUser ? 16.2 : 17,
  });
}

function computeRouteProgress(route, position) {
  const totalDistance = route.distance || route.computedDistance || 1;
  const totalDuration = Number(route.duration || 0);
  if (!position || !route.coordinates.length) {
    return {
      remainingDistanceMeters: totalDistance,
      remainingSeconds: totalDuration,
      nextInstruction: route.steps[0]?.instruction || 'Head to destination',
    };
  }

  let bestIndex = 0;
  let minDistance = Infinity;
  for (let index = 0; index < route.coordinates.length; index += 1) {
    const coord = route.coordinates[index];
    const distance = haversineMeters(position, { lat: coord[1], lng: coord[0] });
    if (distance < minDistance) {
      minDistance = distance;
      bestIndex = index;
    }
  }

  const travelledMeters = route.cumulativeDistances[bestIndex] || 0;
  const remainingDistanceMeters = Math.max(totalDistance - travelledMeters, 0);
  const remainingSeconds = totalDuration * (remainingDistanceMeters / totalDistance);
  const nextInstruction = route.steps.find((step) => step.cumulativeDistance > travelledMeters + 25)?.instruction || 'Arrive at destination';

  return {
    remainingDistanceMeters,
    remainingSeconds,
    nextInstruction,
  };
}

function clearNavigation() {
  state.comparison = null;
  state.routeLayer.clearLayers();
  els.navCard.classList.add('hidden');
  els.nextInstruction.textContent = 'Choose a destination to start.';
  syncShellState();
}

function toggleSheet(type, open) {
  state.activeSheet = open ? type : state.activeSheet === type ? null : state.activeSheet;
  syncShellState();

  if (!state.activeSheet && state.comparison) {
    focusActiveRoute(Boolean(state.currentPosition && state.followUser));
  }
}

function closeActiveSheet() {
  if (!state.activeSheet) return;
  state.activeSheet = null;
  syncShellState();

  if (state.comparison) {
    focusActiveRoute(Boolean(state.currentPosition && state.followUser));
  }
}

function syncShellState() {
  const hasRoute = Boolean(state.comparison);
  const activeSheet = state.activeSheet;

  els.appShell.classList.toggle('nav-active', hasRoute);
  els.appShell.classList.toggle('sheet-open', Boolean(activeSheet));
  els.appShell.classList.toggle('settings-open', activeSheet === 'settings');
  els.appShell.classList.toggle('chat-open', activeSheet === 'chat');
  els.appShell.classList.toggle('report-open', activeSheet === 'report');

  els.settingsSheet.classList.toggle('hidden', activeSheet !== 'settings');
  els.chatSheet.classList.toggle('hidden', activeSheet !== 'chat');
  els.reportSheet.classList.toggle('hidden', activeSheet !== 'report');
  els.sheetBackdrop.classList.toggle('hidden', !activeSheet);
  els.bottomSheet.classList.toggle('hidden', hasRoute);
}

async function onAskAi(event) {
  event.preventDefault();
  const question = els.askInput.value.trim();
  if (!question) return;

  appendChatMessage('user', question);
  els.askInput.value = '';

  try {
    setBusy(els.askButton, true, 'Thinking...');
    const result = await safeFetch('/api/ai/ask', {
      method: 'POST',
      body: JSON.stringify({
        question,
        routeSummary: state.comparison?.summary || null,
        liveContext: state.liveData?.stats || null,
        mapFocus: {
          currentPosition: state.currentPosition,
          destination: state.selectedPlaces.destination || null,
          activeRoute: state.activeRouteKey,
        },
      }),
    });
    appendChatMessage('assistant', result.answer || 'No answer returned.');
  } catch (error) {
    appendChatMessage('assistant', error.message || String(error));
  } finally {
    setBusy(els.askButton, false, 'Ask');
  }
}

function appendChatMessage(role, text) {
  state.chatMessages.push({ role, text });
  renderChatMessages();
  toggleSheet('chat', true);
}

function renderChatMessages() {
  els.chatMessages.innerHTML = '';
  for (const message of state.chatMessages) {
    const bubble = document.createElement('article');
    bubble.className = `chat-bubble ${message.role}`;
    bubble.innerHTML = formatChatMessage(message.text, message.role);
    els.chatMessages.appendChild(bubble);
  }
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function formatChatMessage(text, role) {
  const safeText = escapeHtml(text || '');

  if (role !== 'assistant') {
    return safeText.replace(/\n/g, '<br />');
  }

  const blocks = safeText.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  if (!blocks.length) {
    return '<p></p>';
  }

  return blocks
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim()).filter(Boolean);
      if (!lines.length) return '';

      const isBulletList = lines.every((line) => /^[-*]\s+/.test(line));
      const isOrderedList = lines.every((line) => /^\d+\.\s+/.test(line));

      if (isBulletList) {
        return `<ul>${lines.map((line) => `<li>${applyInlineFormatting(line.replace(/^[-*]\s+/, ''))}</li>`).join('')}</ul>`;
      }

      if (isOrderedList) {
        return `<ol>${lines.map((line) => `<li>${applyInlineFormatting(line.replace(/^\d+\.\s+/, ''))}</li>`).join('')}</ol>`;
      }

      return `<p>${applyInlineFormatting(lines.join('<br />'))}</p>`;
    })
    .join('');
}

function applyInlineFormatting(text) {
  return text
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/__(.+?)__/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/_(.+?)_/g, '<em>$1</em>');
}

function submitReport() {
  if (!state.currentPosition) {
    els.reportStatus.textContent = 'Waiting for your location.';
    return;
  }

  const report = {
    id: `report-${Date.now()}`,
    type: els.reportTypeSelect.value,
    note: els.reportNoteInput.value.trim(),
    lat: state.currentPosition.lat,
    lng: state.currentPosition.lng,
    createdAt: new Date().toISOString(),
  };

  state.reports.unshift(report);
  state.reports = state.reports.slice(0, 100);
  localStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(state.reports));
  renderReports();
  els.reportNoteInput.value = '';
  els.reportStatus.textContent = 'Report added on this device.';
  toggleSheet('report', false);
}

function loadReportsFromStorage() {
  try {
    state.reports = JSON.parse(localStorage.getItem(REPORT_STORAGE_KEY) || '[]');
  } catch {
    state.reports = [];
  }
}

function renderReports() {
  if (!state.reportLayer) return;
  state.reportLayer.clearLayers();

  for (const report of state.reports) {
    const marker = L.circleMarker([report.lat, report.lng], {
      pane: 'reports-pane',
      radius: 7,
      color: '#f43f5e',
      fillColor: '#fb7185',
      fillOpacity: 0.55,
      opacity: 0.9,
      weight: 2,
    });

    marker.bindPopup(`
      <div class="incident-popup">
        <strong>${escapeHtml(report.type)}</strong><br />
        ${report.note ? `${escapeHtml(report.note)}<br />` : ''}
        ${new Date(report.createdAt).toLocaleString()}
      </div>
    `);

    marker.addTo(state.reportLayer);
  }
}

function severityToWeight(severity) {
  return clamp((Number(severity || 0) - 0.25) / 1.75, 0, 1);
}

function incidentGlowColor(weight) {
  if (weight >= 0.8) return '#ef4444';
  if (weight >= 0.45) return '#fb923c';
  return '#facc15';
}

function incidentCoreColor(weight) {
  if (weight >= 0.8) return '#f43f5e';
  if (weight >= 0.45) return '#f97316';
  return '#fde047';
}

function createIncidentPopupHtml(event) {
  return `
    <div class="incident-popup">
      <strong>${escapeHtml(event.primaryType)}</strong><br />
      ${event.secondaryType ? `${escapeHtml(event.secondaryType)}<br />` : ''}
      ${event.neighborhood ? `${escapeHtml(event.neighborhood)}<br />` : ''}
      ${event.timestamp ? `${new Date(event.timestamp).toLocaleString()}<br />` : ''}
      Weight ${event.weight.toFixed(2)}
    </div>
  `;
}

function setStatus(message) {
  els.statusText.textContent = message;
}

function setBusy(button, busy, busyText) {
  if (!button.dataset.defaultText) {
    button.dataset.defaultText = button.textContent;
  }
  button.disabled = busy;
  button.textContent = busy ? busyText : button.dataset.defaultText;
}

async function safeFetch(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed with status ${response.status}`);
  }
  return data;
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

function projectHeadingPoint(point, headingDegrees, distanceMeters) {
  const earthRadius = 6378137;
  const bearing = (headingDegrees * Math.PI) / 180;
  const lat1 = (point.lat * Math.PI) / 180;
  const lng1 = (point.lng * Math.PI) / 180;
  const angularDistance = distanceMeters / earthRadius;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
    Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing),
  );
  const lng2 = lng1 + Math.atan2(
    Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
    Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2),
  );

  return {
    lat: (lat2 * 180) / Math.PI,
    lng: (lng2 * 180) / Math.PI,
  };
}

function formatMinutes(seconds) {
  return Math.max(1, Math.round((seconds || 0) / 60));
}

function formatDistance(distanceMeters) {
  if (distanceMeters >= 1000) {
    return `${(distanceMeters / 1000).toFixed(1)} km`;
  }
  return `${Math.round(distanceMeters)} m`;
}

function formatRelativeTime(isoString) {
  if (!isoString) return 'now';
  const seconds = Math.round((Date.now() - new Date(isoString).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return `${hours}h ago`;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}