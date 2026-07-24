// Curated Resolume 7 OSC addresses. {L}=layer, {C}=clip, {N}=column, {FX}=effect.
export const LIBRARY = [
  { group: 'Composition', label: 'Column connect', address: '/composition/columns/{N}/connect', values: [1] },
  { group: 'Composition', label: 'Disconnect all', address: '/composition/disconnectall', values: [1] },
  { group: 'Composition', label: 'Master level', address: '/composition/master', float: true },
  { group: 'Composition', label: 'Speed', address: '/composition/speed', float: true },
  { group: 'Composition', label: 'Crossfader phase', address: '/composition/crossfader/phase', float: true },
  { group: 'Tempo', label: 'Tempo tap', address: '/composition/tempocontroller/tempotap', values: [1] },
  { group: 'Tempo', label: 'Resync', address: '/composition/tempocontroller/resync', values: [1] },
  { group: 'Layer', label: 'Clip connect', address: '/composition/layers/{L}/clips/{C}/connect', values: [1] },
  { group: 'Layer', label: 'Layer opacity', address: '/composition/layers/{L}/video/opacity', float: true },
  { group: 'Layer', label: 'Layer bypass', address: '/composition/layers/{L}/bypassed', values: [1] },
  { group: 'Layer', label: 'Layer solo', address: '/composition/layers/{L}/solo', values: [1] },
  { group: 'Layer', label: 'Layer clear', address: '/composition/layers/{L}/clear', values: [1] },
  { group: 'Selected clip', label: 'Effect opacity', address: '/composition/selectedclip/video/effects/{FX}/opacity', float: true },
];

export function placeholders(address) {
  return [...address.matchAll(/\{(\w+)\}/g)].map(m => m[1]);
}

export function expand(address, subs) {
  return address.replace(/\{(\w+)\}/g, (_, k) => String(subs[k] ?? 1));
}
