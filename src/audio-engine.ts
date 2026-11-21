/**
 * 程序化音频资产：加载阶段用 OfflineAudioContext 合成音效与配乐，编码成内存 WAV 后
 * 注册进 IWSDK 的 AssetManager，运行时全部由 AudioSystem / AudioSource 播放。
 */

import { AssetManager } from '@iwsdk/core';
import {
  MUSIC_ASSETS,
  renderMusicAsset,
  type MusicAssetDef,
} from './audio-music.js';

export type SfxCue =
  | 'cannon-defender'
  | 'cannon-pirate'
  | 'stone-throw'
  | 'bomb-drop'
  | 'impact-wood'
  | 'impact-metal'
  | 'explosion-ship'
  | 'explosion-cannon'
  | 'splash'
  | 'laser-charge'
  | 'laser-fire'
  | 'lightning'
  | 'sweep-form'
  | 'sweep-fire'
  | 'chief-rise'
  | 'boss-horn'
  | 'wave-horn'
  | 'ui-click'
  | 'ui-open'
  | 'ui-close'
  | 'build'
  | 'build-fail'
  | 'defender-lost'
  | 'ambience-sea';

export interface SfxDef {
  key: string;
  /** 0 表示不是一次性音效（海浪环境交给音乐通道）。 */
  pool: number;
  positional: boolean;
  volume: number;
  minGap: number;
  refDistance: number;
  rolloffFactor: number;
  maxDistance: number;
  duration: number;
  render: (ctx: BaseAudioContext, out: AudioNode) => void;
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const length = Math.max(1, Math.ceil(ctx.sampleRate * seconds));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

interface NoiseShape {
  type?: BiquadFilterType;
  from: number;
  to?: number;
  q?: number;
  peak: number;
  attack?: number;
}

function noiseVoice(
  ctx: BaseAudioContext,
  out: AudioNode,
  time: number,
  duration: number,
  shape: NoiseShape,
): void {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, duration + 0.05);
  const filter = ctx.createBiquadFilter();
  filter.type = shape.type ?? 'lowpass';
  filter.frequency.setValueAtTime(Math.max(20, shape.from), time);
  if (shape.to !== undefined && shape.to !== shape.from) {
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, shape.to), time + duration);
  }
  filter.Q.value = shape.q ?? 0.7;
  const gain = ctx.createGain();
  const attack = shape.attack ?? 0.004;
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, shape.peak), time + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  source.start(time);
  source.stop(time + duration + 0.03);
}

function tone(
  ctx: BaseAudioContext,
  out: AudioNode,
  type: OscillatorType,
  from: number,
  to: number,
  time: number,
  duration: number,
  peak: number,
  attack = 0.005,
  cutoff = 0,
  q = 0.7,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(Math.max(1, from), time);
  if (to !== from) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), time + duration);
  }
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), time + attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  let tail: AudioNode = osc;
  if (cutoff > 0) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    filter.Q.value = q;
    osc.connect(filter);
    tail = filter;
  }
  tail.connect(gain);
  gain.connect(out);
  osc.start(time);
  osc.stop(time + duration + 0.03);
}

function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const size = 1024;
  const curve = new Float32Array(new ArrayBuffer(size * Float32Array.BYTES_PER_ELEMENT));
  for (let i = 0; i < size; i++) {
    const x = (i / (size - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * amount);
  }
  return curve;
}

function laserBeam(
  ctx: BaseAudioContext,
  out: AudioNode,
  time: number,
  duration: number,
  peak: number,
): void {
  const shaper = ctx.createWaveShaper();
  shaper.curve = distortionCurve(2.4);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(3200, time);
  filter.frequency.exponentialRampToValueAtTime(700, time + duration);
  filter.Q.value = 1.1;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, time);
  gain.gain.exponentialRampToValueAtTime(peak, time + 0.03);
  gain.gain.setValueAtTime(peak, time + duration * 0.55);
  gain.gain.exponentialRampToValueAtTime(0.0001, time + duration);
  for (const frequency of [55, 82.5, 110, 164.8]) {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = frequency;
    osc.connect(shaper);
    osc.start(time);
    osc.stop(time + duration + 0.03);
  }
  shaper.connect(filter);
  filter.connect(gain);
  gain.connect(out);
}

export const SFX: Record<SfxCue, SfxDef> = {
  'cannon-defender': {
    key: 'sfx/cannon-defender.wav',
    pool: 6,
    positional: true,
    volume: 0.55,
    minGap: 0.045,
    refDistance: 10,
    rolloffFactor: 1.2,
    maxDistance: 180,
    duration: 0.85,
    render: (ctx, out) => {
      tone(ctx, out, 'sine', 120, 42, 0, 0.55, 0.9, 0.004);
      noiseVoice(ctx, out, 0, 0.42, { from: 2200, to: 260, peak: 0.5 });
      noiseVoice(ctx, out, 0, 0.14, { type: 'highpass', from: 3000, peak: 0.28 });
      tone(ctx, out, 'triangle', 190, 70, 0, 0.22, 0.2);
    },
  },
  'cannon-pirate': {
    key: 'sfx/cannon-pirate.wav',
    pool: 6,
    positional: true,
    volume: 0.4,
    minGap: 0.05,
    refDistance: 12,
    rolloffFactor: 1.1,
    maxDistance: 200,
    duration: 0.7,
    render: (ctx, out) => {
      tone(ctx, out, 'sine', 96, 36, 0, 0.48, 0.75, 0.005);
      noiseVoice(ctx, out, 0, 0.32, { from: 1500, to: 220, peak: 0.38 });
      noiseVoice(ctx, out, 0, 0.1, { type: 'highpass', from: 2400, peak: 0.2 });
    },
  },
  'stone-throw': {
    key: 'sfx/stone-throw.wav',
    pool: 3,
    positional: true,
    volume: 0.38,
    minGap: 0.07,
    refDistance: 8,
    rolloffFactor: 1.3,
    maxDistance: 120,
    duration: 0.55,
    render: (ctx, out) => {
      noiseVoice(ctx, out, 0, 0.32, {
        type: 'bandpass',
        from: 420,
        to: 1500,
        q: 1.1,
        peak: 0.35,
        attack: 0.08,
      });
      tone(ctx, out, 'sine', 150, 60, 0.05, 0.3, 0.3);
    },
  },
  'bomb-drop': {
    key: 'sfx/bomb-drop.wav',
    pool: 3,
    positional: true,
    volume: 0.4,
    minGap: 0.08,
    refDistance: 10,
    rolloffFactor: 1.2,
    maxDistance: 140,
    duration: 0.8,
    render: (ctx, out) => {
      noiseVoice(ctx, out, 0, 0.5, {
        type: 'bandpass',
        from: 700,
        to: 240,
        q: 1.0,
        peak: 0.3,
        attack: 0.05,
      });
      tone(ctx, out, 'sine', 320, 110, 0, 0.7, 0.22);
    },
  },
  'impact-wood': {
    key: 'sfx/impact-wood.wav',
    pool: 6,
    positional: true,
    volume: 0.45,
    minGap: 0.03,
    refDistance: 7,
    rolloffFactor: 1.4,
    maxDistance: 120,
    duration: 0.42,
    render: (ctx, out) => {
      noiseVoice(ctx, out, 0, 0.2, {
        type: 'bandpass',
        from: 520,
        to: 260,
        q: 1.4,
        peak: 0.5,
      });
      tone(ctx, out, 'triangle', 240, 120, 0, 0.18, 0.32);
      noiseVoice(ctx, out, 0, 0.06, { type: 'highpass', from: 1800, peak: 0.22 });
    },
  },
  'impact-metal': {
    key: 'sfx/impact-metal.wav',
    pool: 4,
    positional: true,
    volume: 0.38,
    minGap: 0.03,
    refDistance: 7,
    rolloffFactor: 1.4,
    maxDistance: 120,
    duration: 0.4,
    render: (ctx, out) => {
      tone(ctx, out, 'sine', 930, 860, 0, 0.28, 0.22);
      tone(ctx, out, 'sine', 1380, 1290, 0, 0.22, 0.14);
      noiseVoice(ctx, out, 0, 0.08, { type: 'highpass', from: 2600, peak: 0.24 });
    },
  },
  'explosion-ship': {
    key: 'sfx/explosion-ship.wav',
    pool: 4,
    positional: true,
    volume: 0.9,
    minGap: 0.08,
    refDistance: 18,
    rolloffFactor: 1.0,
    maxDistance: 280,
    duration: 1.5,
    render: (ctx, out) => {
      tone(ctx, out, 'sine', 95, 28, 0, 1.2, 0.95, 0.006);
      noiseVoice(ctx, out, 0, 1.3, { from: 1700, to: 110, peak: 0.75 });
      noiseVoice(ctx, out, 0, 0.5, { type: 'bandpass', from: 340, to: 120, q: 0.9, peak: 0.4 });
      noiseVoice(ctx, out, 0, 0.08, { type: 'highpass', from: 1400, peak: 0.45 });
    },
  },
  'explosion-cannon': {
    key: 'sfx/explosion-cannon.wav',
    pool: 5,
    positional: true,
    volume: 0.65,
    minGap: 0.06,
    refDistance: 12,
    rolloffFactor: 1.2,
    maxDistance: 200,
    duration: 0.9,
    render: (ctx, out) => {
      tone(ctx, out, 'sine', 110, 34, 0, 0.7, 0.8, 0.005);
      noiseVoice(ctx, out, 0, 0.75, { from: 1800, to: 160, peak: 0.6 });
      noiseVoice(ctx, out, 0, 0.06, { type: 'highpass', from: 1600, peak: 0.35 });
    },
  },
  splash: {
    key: 'sfx/splash.wav',
    pool: 4,
    positional: true,
    volume: 0.32,
    minGap: 0.04,
    refDistance: 6,
    rolloffFactor: 1.5,
    maxDistance: 100,
    duration: 0.7,
    render: (ctx, out) => {
      noiseVoice(ctx, out, 0, 0.55, {
        type: 'bandpass',
        from: 900,
        to: 2500,
        q: 0.8,
        peak: 0.32,
        attack: 0.012,
      });
      noiseVoice(ctx, out, 0.12, 0.4, {
        type: 'bandpass',
        from: 2200,
        to: 600,
        q: 0.9,
        peak: 0.2,
      });
      tone(ctx, out, 'sine', 760, 320, 0.05, 0.16, 0.1);
    },
  },
  'laser-charge': {
    key: 'sfx/laser-charge.wav',
    pool: 2,
    positional: true,
    volume: 0.9,
    minGap: 0.4,
    refDistance: 8,
    rolloffFactor: 0.6,
    maxDistance: 200,
    duration: 2.1,
    render: (ctx, out) => {
      // 低频能量堆叠：负责体量，不承担可辨识度。
      tone(ctx, out, 'sawtooth', 80, 300, 0, 1.95, 0.3, 0.5, 1200);
      // 中高频升调啸叫：压在战斗低频之上，保证聚能能听见。
      tone(ctx, out, 'sine', 320, 1180, 0, 1.9, 0.24, 1.5);
      tone(ctx, out, 'triangle', 150, 620, 0.1, 1.8, 0.16, 1.4);
      // 静电共鸣逐渐收紧。
      noiseVoice(ctx, out, 0, 1.9, {
        type: 'bandpass',
        from: 900,
        to: 4200,
        q: 3.2,
        peak: 0.22,
        attack: 1.4,
      });
      // 临射前的上膛尖啸。
      tone(ctx, out, 'sine', 900, 1600, 1.55, 0.5, 0.18, 0.02);
    },
  },
  'laser-fire': {
    key: 'sfx/laser-fire.wav',
    pool: 2,
    positional: true,
    volume: 0.7,
    minGap: 0.25,
    refDistance: 22,
    rolloffFactor: 0.8,
    maxDistance: 400,
    duration: 0.9,
    render: (ctx, out) => {
      laserBeam(ctx, out, 0, 0.72, 0.6);
      // 锐利起手：短促的高频爆音先到，低频随后托住。
      noiseVoice(ctx, out, 0, 0.06, { type: 'highpass', from: 4200, peak: 0.5 });
      tone(ctx, out, 'sawtooth', 2600, 820, 0, 0.1, 0.3, 0.002, 6500);
      // 高频擦音贯穿，替换掉原先厚重的低频轰鸣。
      noiseVoice(ctx, out, 0.02, 0.68, {
        type: 'bandpass',
        from: 5400,
        to: 1800,
        q: 1.6,
        peak: 0.22,
      });
      tone(ctx, out, 'sine', 70, 34, 0, 0.55, 0.45, 0.004);
    },
  },
  lightning: {
    key: 'sfx/lightning.wav',
    pool: 3,
    positional: true,
    volume: 0.9,
    minGap: 0.12,
    refDistance: 20,
    rolloffFactor: 0.9,
    maxDistance: 340,
    duration: 1.1,
    render: (ctx, out) => {
      noiseVoice(ctx, out, 0, 0.07, { type: 'highpass', from: 2200, peak: 0.85 });
      tone(ctx, out, 'sawtooth', 1600, 90, 0, 0.35, 0.4, 0.002, 3000);
      noiseVoice(ctx, out, 0.02, 0.95, { from: 260, to: 90, peak: 0.5 });
      tone(ctx, out, 'sine', 60, 34, 0.02, 0.8, 0.55, 0.005);
    },
  },
  'sweep-form': {
    key: 'sfx/sweep-form.wav',
    pool: 2,
    positional: true,
    volume: 0.55,
    minGap: 0.2,
    refDistance: 18,
    rolloffFactor: 0.9,
    maxDistance: 320,
    duration: 0.6,
    render: (ctx, out) => {
      tone(ctx, out, 'sawtooth', 90, 190, 0, 0.4, 0.28, 0.02, 1200);
      noiseVoice(ctx, out, 0, 0.5, { type: 'bandpass', from: 300, to: 1500, q: 1.2, peak: 0.25 });
    },
  },
  'sweep-fire': {
    key: 'sfx/sweep-fire.wav',
    pool: 2,
    positional: true,
    volume: 0.85,
    minGap: 0.2,
    refDistance: 20,
    rolloffFactor: 0.9,
    maxDistance: 360,
    duration: 1.15,
    render: (ctx, out) => {
      laserBeam(ctx, out, 0, 1.0, 0.6);
      noiseVoice(ctx, out, 0, 1.0, { type: 'bandpass', from: 2800, to: 700, q: 1.0, peak: 0.3 });
      tone(ctx, out, 'sine', 66, 30, 0, 0.95, 0.7, 0.004);
    },
  },
  'chief-rise': {
    key: 'sfx/chief-rise.wav',
    pool: 1,
    positional: false,
    volume: 0.85,
    minGap: 0.4,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 1.6,
    render: (ctx, out) => {
      tone(ctx, out, 'sine', 42, 30, 0, 1.35, 0.8, 0.05);
      noiseVoice(ctx, out, 0, 1.4, { from: 180, to: 90, peak: 0.45, attack: 0.2 });
      tone(ctx, out, 'sawtooth', 55, 110, 0.1, 1.0, 0.16, 0.2, 700);
      noiseVoice(ctx, out, 0.9, 0.45, { type: 'highpass', from: 1500, peak: 0.18 });
    },
  },
  'boss-horn': {
    key: 'sfx/boss-horn.wav',
    pool: 2,
    positional: false,
    volume: 0.9,
    minGap: 0.6,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 2.4,
    render: (ctx, out) => {
      for (const frequency of [73.4, 92.5, 110, 146.8]) {
        tone(ctx, out, 'sawtooth', frequency, frequency * 0.99, 0, 2.1, 0.16, 0.16, 1000);
      }
      tone(ctx, out, 'sine', 36.7, 36.7, 0, 2.2, 0.55, 0.12);
      noiseVoice(ctx, out, 0, 0.5, { type: 'highpass', from: 900, peak: 0.2 });
    },
  },
  'wave-horn': {
    key: 'sfx/wave-horn.wav',
    pool: 2,
    positional: false,
    volume: 0.55,
    minGap: 0.4,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 1.35,
    render: (ctx, out) => {
      tone(ctx, out, 'sawtooth', 146.8, 146.8, 0, 0.5, 0.22, 0.04, 1200);
      tone(ctx, out, 'sawtooth', 220, 220, 0.36, 0.85, 0.2, 0.04, 1400);
      tone(ctx, out, 'sine', 73.4, 73.4, 0, 1.1, 0.2, 0.05);
    },
  },
  'ui-click': {
    key: 'sfx/ui-click.wav',
    pool: 3,
    positional: false,
    volume: 0.32,
    minGap: 0.04,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 0.12,
    render: (ctx, out) => {
      tone(ctx, out, 'square', 880, 880, 0, 0.07, 0.18, 0.002, 5000);
      tone(ctx, out, 'square', 1320, 1320, 0.02, 0.05, 0.08, 0.002, 6000);
    },
  },
  'ui-open': {
    key: 'sfx/ui-open.wav',
    pool: 2,
    positional: false,
    volume: 0.36,
    minGap: 0.1,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 0.3,
    render: (ctx, out) => {
      tone(ctx, out, 'square', 520, 520, 0, 0.1, 0.16, 0.003, 4200);
      tone(ctx, out, 'square', 780, 780, 0.09, 0.14, 0.14, 0.003, 4600);
    },
  },
  'ui-close': {
    key: 'sfx/ui-close.wav',
    pool: 2,
    positional: false,
    volume: 0.34,
    minGap: 0.1,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 0.28,
    render: (ctx, out) => {
      tone(ctx, out, 'square', 780, 780, 0, 0.09, 0.14, 0.003, 4600);
      tone(ctx, out, 'square', 520, 520, 0.08, 0.13, 0.13, 0.003, 4200);
    },
  },
  build: {
    key: 'sfx/build.wav',
    pool: 2,
    positional: false,
    volume: 0.45,
    minGap: 0.15,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 0.45,
    render: (ctx, out) => {
      tone(ctx, out, 'sine', 660, 660, 0, 0.09, 0.24, 0.004);
      tone(ctx, out, 'sine', 880, 880, 0.08, 0.09, 0.22, 0.004);
      tone(ctx, out, 'sine', 1320, 1320, 0.16, 0.16, 0.2, 0.004);
    },
  },
  'build-fail': {
    key: 'sfx/build-fail.wav',
    pool: 2,
    positional: false,
    volume: 0.42,
    minGap: 0.2,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 0.34,
    render: (ctx, out) => {
      tone(ctx, out, 'square', 150, 120, 0, 0.14, 0.2, 0.004, 900);
      tone(ctx, out, 'square', 112, 96, 0.12, 0.16, 0.18, 0.004, 800);
    },
  },
  'defender-lost': {
    key: 'sfx/defender-lost.wav',
    pool: 2,
    positional: true,
    volume: 0.75,
    minGap: 0.4,
    refDistance: 12,
    rolloffFactor: 1.1,
    maxDistance: 200,
    duration: 1.3,
    render: (ctx, out) => {
      tone(ctx, out, 'sawtooth', 330, 160, 0, 0.95, 0.26, 0.05, 1000);
      tone(ctx, out, 'sine', 80, 45, 0, 0.9, 0.5, 0.01);
      noiseVoice(ctx, out, 0.1, 0.7, { from: 500, to: 120, peak: 0.25 });
    },
  },
  'ambience-sea': {
    key: 'sfx/ambience-sea.wav',
    pool: 0,
    positional: false,
    volume: 0.55,
    minGap: 0,
    refDistance: 1,
    rolloffFactor: 1,
    maxDistance: 100,
    duration: 6,
    render: (ctx, out) => {
      const length = Math.max(1, Math.ceil(ctx.sampleRate * 6));
      const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      let low = 0;
      for (let i = 0; i < length; i++) {
        const white = Math.random() * 2 - 1;
        low = 0.995 * low + 0.005 * white;
        const swell =
          0.55 +
          0.3 * Math.sin((i / length) * Math.PI * 4) +
          0.15 * Math.sin((i / length) * Math.PI * 10);
        data[i] = (white * 0.12 + low * 0.9) * swell;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 650;
      source.connect(filter);
      filter.connect(out);
      source.start(0);
    },
  },
};

function encodeWav(buffer: AudioBuffer): Blob {
  const samples = buffer.length;
  const dataSize = samples * 2;
  const bytes = new ArrayBuffer(44 + dataSize);
  const view = new DataView(bytes);
  const writeString = (offset: number, value: string): void => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const data = buffer.getChannelData(0);
  let offset = 44;
  for (let i = 0; i < samples; i++) {
    const sample = Math.max(-1, Math.min(1, data[i]));
    view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
    offset += 2;
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

async function registerBuffer(key: string, buffer: AudioBuffer): Promise<void> {
  const url = URL.createObjectURL(encodeWav(buffer));
  await AssetManager.loadAudio(url, key);
  URL.revokeObjectURL(url);
}

/** 首屏就要用的音效：海浪与界面反馈，和标题曲一起先合成。 */
export const INTRO_SFX_CUES: SfxCue[] = [
  'ambience-sea',
  'ui-click',
  'ui-open',
  'ui-close',
];

const ALL_SFX_CUES = (Object.keys(SFX) as SfxCue[]).filter(
  (cue) => SFX[cue].pool > 0 || cue === 'ambience-sea',
);

async function generateCues(cues: SfxCue[]): Promise<void> {
  const sampleRate = 44100;
  for (const cue of cues) {
    const def = SFX[cue];
    const ctx = new OfflineAudioContext(
      1,
      Math.max(1, Math.ceil(def.duration * sampleRate)),
      sampleRate,
    );
    const out = ctx.createGain();
    out.gain.value = 1;
    out.connect(ctx.destination);
    def.render(ctx, out);
    await registerBuffer(def.key, await ctx.startRendering());
  }
}

async function generateMusic(defs: MusicAssetDef[]): Promise<void> {
  for (const def of defs) {
    await registerBuffer(def.key, await renderMusicAsset(def, 22050));
  }
}

let introPromise: Promise<void> | null = null;
let restPromise: Promise<void> | null = null;

/**
 * 首屏批次：标题曲、海浪与界面反馈。合成量小，welcome 面板出现后很快就能起播。
 */
export function registerIntroAudioAssets(): Promise<void> {
  if (!introPromise) {
    introPromise = (async () => {
      await generateCues(INTRO_SFX_CUES);
      await generateMusic(MUSIC_ASSETS.filter((def) => def.section === 'title'));
    })();
  }
  return introPromise;
}

/** 其余批次：全部战斗音效、Boss/胜负段落，在首屏批次之后后台继续合成。 */
export function registerRemainingAudioAssets(): Promise<void> {
  if (!restPromise) {
    restPromise = (async () => {
      await generateCues(ALL_SFX_CUES.filter((cue) => !INTRO_SFX_CUES.includes(cue)));
      await generateMusic(MUSIC_ASSETS.filter((def) => def.section !== 'title'));
    })();
  }
  return restPromise;
}
