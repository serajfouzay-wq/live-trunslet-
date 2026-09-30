// Runs on the audio thread: turns the microphone into 16 kHz mono 16-bit PCM
// (what speech recognition wants) in ~100 ms chunks, and reports the loudness.
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.phase = 0;
    this.sum = 0;
    this.count = 0;
    this.out = new Int16Array(1600);
    this.n = 0;
    this.peak = 0;
    this.blocks = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      this.sum += v;
      this.count += 1;
      this.phase += 1;
      if (this.phase >= this.ratio) {
        this.phase -= this.ratio;
        const avg = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        this.out[this.n++] = Math.max(-1, Math.min(1, avg)) * 0x7fff;
        if (this.n === this.out.length) {
          this.port.postMessage({ pcm: this.out.buffer }, [this.out.buffer]);
          this.out = new Int16Array(1600);
          this.n = 0;
        }
      }
    }
    if (++this.blocks % 6 === 0) {
      this.port.postMessage({ level: this.peak });
      this.peak = 0;
    }
    return true;
  }
}
registerProcessor('pcm-worklet', PCMWorklet);
