// Native sACN buttons (CO2 jets, spark machines). The editor keeps the sACN
// fields in btn.sacn; applySacn() derives everything the normal button
// runtime uses from them, so press / release / toggle work like any button:
//   Value = press level, Default value = level when not pressed (release and
//   toggle-off), sent at startup and restored by the main process on quit.
const FX_KINDS = ['fxButtons', 'fxButtons2', 'fxButtons3', 'utilButtons'];
const dmx = v => Math.max(0, Math.min(255, Math.round(Number(v)) || 0));

export function sacnAddress(s) {
  const q = new URLSearchParams({ default: String(dmx(s.defaultValue)) });
  const prio = Math.max(0, Math.min(200, Math.round(Number(s.priority ?? 100)) || 0));
  if (prio !== 100) q.set('prio', String(prio));
  if (s.host) q.set('host', s.host.trim());
  if (s.iface) q.set('iface', s.iface.trim());
  return `sacn://${Math.max(1, Math.min(63999, Math.trunc(Number(s.universe)) || 1))}/${Math.max(1, Math.min(512, Math.trunc(Number(s.channel)) || 1))}?${q}`;
}

export function applySacn(btn) {
  if (btn.output !== 'sacn') return btn;
  const s = btn.sacn;
  s.defaultValue = dmx(s.defaultValue);
  btn.type = 'int';
  btn.value = dmx(btn.value);
  btn.address = sacnAddress(s);
  btn.releaseValue = s.defaultValue;
  btn.offValue = s.defaultValue;
  btn.releaseAddress = '';
  btn.extraAddress = '';
  btn.extraAddresses = [];
  btn.macro = [];
  btn.repeat = { ...btn.repeat, enabled: false };
  btn.ramp = { ...btn.ramp, enabled: false, followTrigger: false };
  if (btn.mode === 'tap') btn.mode = 'hold'; // tap never sends the default back: a CO2 jet would stay open
  return btn;
}

export function sendDefault(btn, rogger) {
  if (btn?.output === 'sacn') rogger.sendTyped(btn.address, [{ type: 'i', value: dmx(btn.sacn.defaultValue) }]);
}

export function sendAllDefaults(cfg, rogger) {
  for (const k of FX_KINDS) for (const b of cfg[k] ?? []) sendDefault(b, rogger);
}
