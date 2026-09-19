/**
 * Runs on the audio thread: takes the microphone at the device rate, averages it down
 * to the line's 8 kHz, and posts one 20 ms frame (160 samples) at a time with its level.
 * Shipped as source text so no extra build entry is needed.
 */
export const CAPTURE_WORKLET = /* js */ `
class Capture8k extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 8000;
    this.acc = 0;
    this.sum = 0;
    this.n = 0;
    this.frame = new Float32Array(160);
    this.i = 0;
    this.energy = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let k = 0; k < channel.length; k++) {
      const v = channel[k];
      this.sum += v;
      this.n++;
      this.acc += 1;
      if (this.acc >= this.ratio) {
        this.acc -= this.ratio;
        const s = this.sum / this.n;
        this.sum = 0;
        this.n = 0;
        this.frame[this.i++] = s;
        this.energy += s * s;
        if (this.i === 160) {
          this.port.postMessage({ frame: this.frame.slice(0), level: Math.sqrt(this.energy / 160) });
          this.i = 0;
          this.energy = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('capture-8k', Capture8k);
`;
