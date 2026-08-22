// Web Audio wiring for the mic/line-in BPM analyser: device enumeration,
// an AudioWorklet frame pump (ScriptProcessorNode fallback when a worklet
// module can't be loaded), a TempoTracker fed at the live sample rate, and a
// ~12 Hz onUpdate callback the BPM page redraws from.
//
// A TempoTracker exists from the moment this factory is called (default
// 44.1 kHz) — not only once the mic is actually running — so the page (and
// tests) can push synthetic frames straight into `window.__bpmTracker`
// without needing a live microphone. `start()` replaces it with one tuned to
// the real AudioContext sample rate.
import { TempoTracker } from './bpm-core.js';

const UPDATE_MS = 1000 / 12; // ~12 Hz

export function createBpmAnalyser({ onUpdate } = {}) {
  let ctx = null;
  let stream = null;
  let source = null;
  let node = null;
  let silentSink = null;
  let tracker = new TempoTracker({ sampleRate: 44100 });
  let running = false;
  let deviceLabel = '';
  let permissionGranted = false;
  let beatFlag = false;

  window.__bpmTracker = tracker;

  function emitState() {
    const est = tracker.estimate();
    const env = tracker.getOnsetEnvelope();
    const state = {
      running,
      bpm: est.bpm,
      rawBpm: est.rawBpm,
      confidence: est.confidence,
      level: tracker.getLevel(),
      onset: env.length ? env[env.length - 1] : 0,
      beat: beatFlag,
      deviceLabel,
    };
    beatFlag = false;
    window.__bpmState = state;
    if (onUpdate) onUpdate(state);
  }

  // The refresh loop runs for the life of this analyser instance regardless
  // of whether the mic is capturing, so the page always has something to
  // draw (and tests can inject frames without ever calling start()). The
  // first tick is deferred so `onUpdate` never fires before the caller's
  // `const analyser = createBpmAnalyser(...)` has finished assigning (an
  // onUpdate that reads the returned object synchronously would otherwise
  // hit its temporal dead zone).
  setInterval(emitState, UPDATE_MS);
  setTimeout(emitState, 0);

  function handleChunk(chunk) {
    const hops = tracker.pushFrame(chunk);
    for (let i = 0; i < hops.length; i++) {
      if (tracker.tick()) beatFlag = true;
    }
  }

  async function listDevices() {
    if (!permissionGranted && navigator.mediaDevices?.getUserMedia) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach(t => t.stop());
        permissionGranted = true;
      } catch {
        // proceed without labels — better than blocking the device list
      }
    }
    if (!navigator.mediaDevices?.enumerateDevices) return [];
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter(d => d.kind === 'audioinput');
  }

  async function start(deviceId) {
    if (running) return;
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Microphone API unavailable in this browser');
    }
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: deviceId ? { exact: deviceId } : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
    });
    permissionGranted = true;

    const track = stream.getAudioTracks()[0];
    deviceLabel = track ? track.label : '';

    ctx = new (window.AudioContext || window.webkitAudioContext)();
    source = ctx.createMediaStreamSource(stream);
    tracker = new TempoTracker({ sampleRate: ctx.sampleRate });
    window.__bpmTracker = tracker;

    try {
      await ctx.audioWorklet.addModule(new URL('./bpm-worklet.js', import.meta.url));
      node = new AudioWorkletNode(ctx, 'rogger-bpm');
      node.port.onmessage = e => handleChunk(new Float32Array(e.data));
      source.connect(node);
      // Some engines only pump a worklet node's process() while it reaches
      // an active destination — route through a silent gain so it keeps
      // running without putting the mic signal on the speakers.
      silentSink = ctx.createGain();
      silentSink.gain.value = 0;
      node.connect(silentSink);
      silentSink.connect(ctx.destination);
    } catch {
      node = ctx.createScriptProcessor(1024, 1, 1);
      node.onaudioprocess = e => handleChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(ctx.destination);
    }

    running = true;
    emitState();
  }

  function stop() {
    running = false;
    try { node && node.disconnect(); } catch { /* already gone */ }
    try { silentSink && silentSink.disconnect(); } catch { /* already gone */ }
    try { source && source.disconnect(); } catch { /* already gone */ }
    try { ctx && ctx.close(); } catch { /* already gone */ }
    try { stream && stream.getTracks().forEach(t => t.stop()); } catch { /* already gone */ }
    ctx = null; source = null; node = null; silentSink = null; stream = null;
    deviceLabel = '';
    emitState();
  }

  return {
    listDevices,
    start,
    stop,
    lock: bool => tracker.lock(bool),
    scale: factor => tracker.scale(factor),
    isRunning: () => running,
    get tracker() { return tracker; },
  };
}
