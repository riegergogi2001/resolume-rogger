// IntentExecutor: the single place where high-level intents become ROGGER
// sends. Targets are resolved from the semantic show model (never raw
// assumptions), and every resolved layer is checked against the protected
// registry — a protected target aborts the action, it is never substituted.
export class IntentExecutor {
  constructor({ send, getShowModel, getConfig }) {
    this.send = send;                 // rogger.send — the existing controller
    this.getShowModel = getShowModel;
    this.getConfig = getConfig;
    this.lastClipByRole = new Map();  // role → last clip key fired (rotation)
    this.heroCursor = 0;
  }

  // → {executed, detail, targets:[address]} — detail is human-readable.
  execute(intent) {
    const model = this.getShowModel();
    if (!model) return { executed: false, detail: 'no show model yet', targets: [] };
    switch (intent.type) {
      case 'HoldCurrentVisual':
        return { executed: true, detail: 'holding — no output', targets: [] };
      case 'TriggerFlash':
        return this.fireRoleClip(model, 'flash', 600);
      case 'TriggerStrobe':
        return this.fireRoleClip(model, 'strobe', 1500);
      case 'TriggerImpactFX':
        return this.fireRoleClip(model, 'impact', 800);
      case 'TriggerCameraFX':
        return this.fireRoleClip(model, 'camerafx', 2000);
      case 'IncreaseEnergy': {
        const a = this.getConfig().colorMorph?.bypassAddress;
        if (!a) return { executed: false, detail: 'no energy target configured', targets: [] };
        this.send(a, [0]);
        return { executed: true, detail: 'ColorMorph engaged for extra motion', targets: [a] };
      }
      case 'ReduceDensity': {
        const a = this.getConfig().colorMorph?.bypassAddress;
        if (!a) return { executed: false, detail: 'no density target configured', targets: [] };
        this.send(a, [1]);
        return { executed: true, detail: 'ColorMorph released to calm the frame', targets: [a] };
      }
      case 'SwitchDeck':
        return this.advanceHero(model, true);
      case 'PrepareNextClip':
      case 'PrepareTransition':
        return this.advanceHero(model, false);
      default:
        return { executed: false, detail: `unknown intent ${intent.type}`, targets: [] };
    }
  }

  guarded(model, layerIndex) {
    const layer = model.layers?.find(l => l.index === layerIndex);
    return !layer || layer.protected;
  }

  fireRoleClip(model, role, pulseMs) {
    const pool = model.clipsByRole?.[role] ?? [];
    if (!pool.length) return { executed: false, detail: `no ${role} clip in this composition`, targets: [] };
    // rotate within the pool so back-to-back fires vary the look
    const last = this.lastClipByRole.get(role);
    const pick = pool[(pool.findIndex(c => `${c.layerIndex}:${c.clipIndex}` === last) + 1) % pool.length];
    if (this.guarded(model, pick.layerIndex)) {
      return { executed: false, detail: `${role} target sits on a protected layer — refused`, targets: [] };
    }
    this.lastClipByRole.set(role, `${pick.layerIndex}:${pick.clipIndex}`);
    const addr = `/composition/layers/${pick.layerIndex}/clips/${pick.clipIndex}/connect`;
    this.send(addr, [1]);
    if (pulseMs > 0) setTimeout(() => this.send(addr, [0]), pulseMs);
    return { executed: true, detail: `${role}: ${pick.name}`, targets: [addr] };
  }

  // connect=true switches the live hero visual; false only pre-selects it.
  advanceHero(model, connect) {
    const heroes = (model.layers ?? []).filter(l => l.role === 'hero' && !l.protected && l.clips.length);
    if (!heroes.length) return { executed: false, detail: 'no hero layer available', targets: [] };
    const layer = heroes[this.heroCursor % heroes.length];
    const clip = layer.clips[(this.heroCursor * 7 + 1) % layer.clips.length]; // varied walk
    this.heroCursor += 1;
    if (this.guarded(model, layer.index)) {
      return { executed: false, detail: 'hero target protected — refused', targets: [] };
    }
    const verb = connect ? 'connect' : 'select';
    const addr = `/composition/layers/${layer.index}/clips/${clip.index}/${verb}`;
    this.send(addr, [1]);
    return {
      executed: true,
      detail: `${connect ? 'switched to' : 'prepared'} ${layer.name} · ${clip.name || 'clip ' + clip.index}`,
      targets: [addr],
    };
  }
}
