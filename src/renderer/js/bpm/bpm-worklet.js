// AudioWorkletProcessor that pumps raw mono samples off the audio thread in
// fixed 512-sample chunks, so bpm-analyser.js can feed them to TempoTracker
// without doing any DSP inside the (real-time-critical) render quantum.
const CHUNK = 512;

class RoggerBpmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(CHUNK);
    this._len = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch0 = input && input[0];
    if (ch0 && ch0.length) {
      let offset = 0;
      while (offset < ch0.length) {
        const take = Math.min(CHUNK - this._len, ch0.length - offset);
        this._buf.set(ch0.subarray(offset, offset + take), this._len);
        this._len += take;
        offset += take;
        if (this._len >= CHUNK) {
          const chunk = this._buf;
          this._buf = new Float32Array(CHUNK);
          this._len = 0;
          this.port.postMessage(chunk, [chunk.buffer]);
        }
      }
    }
    return true; // keep the processor alive for the life of the node
  }
}

registerProcessor('rogger-bpm', RoggerBpmProcessor);
