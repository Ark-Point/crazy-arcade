(function (root, factory) {
  root.AudioFx = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  let ctx = null;
  let unlocked = false;
  const lastPlayed = new Map();

  function context() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    return ctx;
  }

  function unlock() {
    try {
      const c = context();
      if (c.state === 'suspended') c.resume();
      const gain = c.createGain();
      gain.gain.value = 0.0001;
      gain.connect(c.destination);
      const osc = c.createOscillator();
      osc.frequency.value = 220;
      osc.connect(gain);
      osc.start();
      osc.stop(c.currentTime + 0.01);
      unlocked = true;
    } catch {
      unlocked = false;
    }
  }

  function tone(freq, duration, type, volume, slide) {
    if (!unlocked) return;
    const c = context();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = type || 'sine';
    osc.frequency.setValueAtTime(freq, c.currentTime);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), c.currentTime + duration);
    gain.gain.setValueAtTime(0, c.currentTime);
    gain.gain.linearRampToValueAtTime(volume, c.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start();
    osc.stop(c.currentTime + duration + 0.02);
  }

  function noise(duration, volume) {
    if (!unlocked) return;
    const c = context();
    const buffer = c.createBuffer(1, c.sampleRate * duration, c.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = c.createBufferSource();
    const filter = c.createBiquadFilter();
    const gain = c.createGain();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    gain.gain.setValueAtTime(volume, c.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + duration);
    src.buffer = buffer;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(c.destination);
    src.start();
    src.stop(c.currentTime + duration);
  }

  function play(name) {
    const now = performance.now();
    const cooldown = name === 'stream' ? 80 : name === 'pickup' ? 70 : 20;
    if ((lastPlayed.get(name) || 0) + cooldown > now) return;
    lastPlayed.set(name, now);
    if (name === 'start') tone(330, 0.09, 'triangle', 0.045, 120);
    else if (name === 'go') tone(520, 0.16, 'square', 0.04, 280);
    else if (name === 'place') tone(180, 0.08, 'sine', 0.04, -70);
    else if (name === 'stream') {
      tone(120, 0.16, 'sawtooth', 0.025, -50);
      noise(0.14, 0.028);
    } else if (name === 'pickup') tone(660, 0.08, 'triangle', 0.04, 180);
    else if (name === 'trap') tone(260, 0.18, 'square', 0.035, -120);
    else if (name === 'rescue') tone(620, 0.16, 'triangle', 0.04, 220);
    else if (name === 'shield') tone(420, 0.16, 'sine', 0.04, 260);
    else if (name === 'boss') tone(90, 0.25, 'sawtooth', 0.04, -25);
    else if (name === 'win') {
      tone(523, 0.12, 'triangle', 0.04, 0);
      setTimeout(() => tone(659, 0.12, 'triangle', 0.04, 0), 100);
      setTimeout(() => tone(784, 0.18, 'triangle', 0.04, 0), 200);
    } else if (name === 'lose') tone(220, 0.32, 'sine', 0.04, -120);
  }

  return { play, unlock };
});
