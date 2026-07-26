// Semantic model of a Resolume composition: classify layers/clips by PURPOSE
// (hero, strobe, impact, ...) instead of OSC address, so the AI director can
// reason about "the strobe clips" without knowing rig-specific paths. Also
// carries a hard protected-layer registry — timecode/sync/audio/routing
// layers the director must never touch, regardless of what it infers.
// Pure, zero deps: only reads the comp argument, never mutates it.

// Case-insensitive regex sources. A layer name matching any of these makes
// the whole layer (and every clip on it) off-limits to automated control.
export const PROTECTED_PATTERNS = ['^TC', 'TC/PB', 'TIMER', 'LFV', 'SYNC', '^AB\\b', 'AUDIO', 'INPUT', 'ROUTE'];

export const ROLES = ['hero', 'background', 'camerafx', 'strobe', 'impact', 'flash', 'particles', 'text', 'logo', 'transition', 'atmosphere', 'unknown'];

// Resolume names arrive as {value} or plain strings, and are frequently
// missing entirely. Always route through this before matching.
function normalize(name) {
  const raw = name?.value ?? name ?? '';
  return typeof raw === 'string' ? raw : '';
}

function matchesAny(text, patternSources) {
  return patternSources.some((src) => {
    try {
      return new RegExp(src, 'i').test(text);
    } catch {
      return false; // a bad extraProtected pattern never crashes classification
    }
  });
}

export function classifyLayer(name, extraProtected = []) {
  const n = normalize(name);
  const isProtected = matchesAny(n, PROTECTED_PATTERNS) || matchesAny(n, extraProtected);

  let role = 'unknown';
  if (/VIDEO|VJ|LOOP|CONTENT/i.test(n)) role = 'hero';
  else if (/BANNER|TEXT|NAME|TITLE/i.test(n)) role = 'text';
  else if (/LOGO/i.test(n)) role = 'logo';
  else if (/FX/i.test(n)) role = 'camerafx';
  else if (/BG|BACK|ATMO|AMBIENT/i.test(n)) role = 'atmosphere';
  else if (/PART/i.test(n)) role = 'particles';

  return { role, protected: isProtected };
}

export function classifyClip(name) {
  const n = normalize(name);
  if (!n) return 'unknown';

  if (/STROBE/i.test(n)) return 'strobe';
  if (/FLASH/i.test(n)) return 'flash';
  if (/BOOM|IMPACT|HIT|BLOW|SUCK/i.test(n)) return 'impact';
  if (/INVERT|PIXEL|GLITCH|SHAKE|RGB|ZOOM|FE STR|FEEDBACK/i.test(n)) return 'camerafx';
  if (/LOGO/i.test(n)) return 'logo';
  if (/OFF|BLANK|BLACK/i.test(n)) return 'transition';
  if (/PART/i.test(n)) return 'particles';
  // visual-pack-looking content: numbered takes or DXV/XYZ-style export tokens
  if (/\d$/.test(n) || /DXV|XYZ/i.test(n)) return 'hero';

  return 'unknown';
}

export function buildShowModel(comp, extraProtected = []) {
  const rawLayers = Array.isArray(comp?.layers) ? comp.layers : [];

  const layers = [];
  const protectedLayers = [];
  const clipsByRole = {};
  let clipCount = 0;
  let classifiedCount = 0;

  rawLayers.forEach((rawLayer, li) => {
    const layerIndex = li + 1;
    const name = normalize(rawLayer?.name);
    const { role, protected: isProtected } = classifyLayer(name, extraProtected);
    if (isProtected) protectedLayers.push(name);

    const rawClips = Array.isArray(rawLayer?.clips) ? rawLayer.clips : [];
    const clips = rawClips.map((rawClip, ci) => {
      const clipIndex = ci + 1;
      // clip entries are {name: {value}|string}, but tolerate a bare string too
      const clipNameSrc = rawClip && typeof rawClip === 'object' ? rawClip.name : rawClip;
      const clipName = normalize(clipNameSrc);
      const clipRole = classifyClip(clipName);

      clipCount += 1;
      if (clipRole !== 'unknown') classifiedCount += 1;

      if (!isProtected) {
        (clipsByRole[clipRole] ??= []).push({ layerIndex, clipIndex, name: clipName });
      }

      return { index: clipIndex, name: clipName, role: clipRole };
    });

    layers.push({ index: layerIndex, name, role, protected: isProtected, clips });
  });

  // A role "exists" either via an actual (unprotected) clip, or via a whole
  // unprotected layer dedicated to it (e.g. an empty hero layer mid-build).
  const unprotectedLayerRoles = new Set(layers.filter((l) => !l.protected).map((l) => l.role));

  function hasRole(role) {
    return Boolean(clipsByRole[role]?.length) || unprotectedLayerRoles.has(role);
  }

  return {
    layers,
    protectedLayers,
    clipsByRole,
    hasRole,
    stats: {
      layers: layers.length,
      protectedCount: protectedLayers.length,
      clips: clipCount,
      classified: classifiedCount,
    },
  };
}
