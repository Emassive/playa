'use client'

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { MIDI_FILES } from '@/lib/midiFiles'

const formatName = (s: string) =>
  s.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase())

// ─── Types ────────────────────────────────────────────────────────────────────

interface MidiNote {
  time: number
  note: number
  velocity: number
  duration: number
}

interface MidiData {
  notes: MidiNote[]
  duration: number
  bpm: number
}

// ─── MIDI Parser (inline, no deps, handles format 0 & 1) ─────────────────────

function parseMidi(buffer: ArrayBuffer): MidiData {
  const data = new Uint8Array(buffer)
  let pos = 0

  const readByte = () => data[pos++]

  const readU32 = () => {
    const b = [data[pos++], data[pos++], data[pos++], data[pos++]]
    return (b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]
  }

  const readU16 = () => {
    const b = [data[pos++], data[pos++]]
    return (b[0] << 8) | b[1]
  }

  const readVLQ = () => {
    let val = 0, b: number
    do { b = readByte(); val = (val << 7) | (b & 0x7f) } while (b & 0x80)
    return val
  }

  // Header
  const headerTag = String.fromCharCode(data[0], data[1], data[2], data[3])
  if (headerTag !== 'MThd') throw new Error('Not a MIDI file')
  pos = 4
  readU32() // chunk length
  readU16() // format (0 or 1, both work)
  const numTracks = readU16()
  const tpb = readU16()
  if (tpb & 0x8000) throw new Error('SMPTE timing not supported')

  const tempoMap: { tick: number; tempo: number }[] = []
  const rawNotes: { tick: number; endTick: number; note: number; velocity: number }[] = []

  for (let t = 0; t < numTracks; t++) {
    if (pos + 8 > data.length) break
    const tag = String.fromCharCode(data[pos], data[pos + 1], data[pos + 2], data[pos + 3])
    pos += 4
    const trackLen = readU32()
    const trackEnd = pos + trackLen
    if (tag !== 'MTrk') { pos = trackEnd; continue }

    let tick = 0
    let lastStatus = 0
    const pending = new Map<number, { tick: number; velocity: number }[]>()

    while (pos < trackEnd) {
      tick += readVLQ()
      let status = data[pos]

      if (status & 0x80) { pos++; lastStatus = status }
      else { status = lastStatus }

      const type = status >> 4
      const isNoteOn = type === 0x9
      const isNoteOff = type === 0x8

      if (isNoteOn || isNoteOff) {
        const note = readByte()
        const vel = readByte()
        if (isNoteOn && vel > 0) {
          if (!pending.has(note)) pending.set(note, [])
          pending.get(note)!.push({ tick, velocity: vel })
        } else {
          const arr = pending.get(note)
          if (arr?.length) {
            const on = arr.shift()!
            rawNotes.push({ tick: on.tick, endTick: tick, note, velocity: on.velocity })
            if (!arr.length) pending.delete(note)
          }
        }
      } else if (type === 0xa || type === 0xb || type === 0xe) {
        pos += 2
      } else if (type === 0xc || type === 0xd) {
        pos += 1
      } else if (status === 0xff) {
        const metaType = readByte()
        const metaLen = readVLQ()
        if (metaType === 0x51 && metaLen === 3) {
          const tempo = (readByte() << 16) | (readByte() << 8) | readByte()
          tempoMap.push({ tick, tempo })
        } else {
          pos += metaLen
        }
      } else if (status === 0xf0 || status === 0xf7) {
        pos += readVLQ()
      } else {
        pos = trackEnd
      }
    }

    // Close any unclosed notes at end of track
    for (const [note, arr] of pending) {
      for (const on of arr) {
        rawNotes.push({ tick: on.tick, endTick: tick, note, velocity: on.velocity })
      }
    }

    pos = trackEnd
  }

  tempoMap.sort((a, b) => a.tick - b.tick)

  const ticksToSec = (targetTick: number): number => {
    let sec = 0, lastTick = 0, curTempo = 500000
    for (const tc of tempoMap) {
      if (tc.tick >= targetTick) break
      sec += ((tc.tick - lastTick) / tpb) * (curTempo / 1e6)
      lastTick = tc.tick
      curTempo = tc.tempo
    }
    return sec + ((targetTick - lastTick) / tpb) * (curTempo / 1e6)
  }

  const notes: MidiNote[] = rawNotes.map(rn => ({
    time: ticksToSec(rn.tick),
    note: rn.note,
    velocity: rn.velocity,
    duration: Math.max(0.05, ticksToSec(rn.endTick) - ticksToSec(rn.tick)),
  }))

  notes.sort((a, b) => a.time - b.time)

  const duration = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0)
  const bpm = tempoMap.length > 0 ? 60e6 / tempoMap[0].tempo : 120

  return { notes, duration, bpm }
}

const midiToFreq = (note: number) => 440 * Math.pow(2, (note - 69) / 12)
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`

// ─── Sound presets ────────────────────────────────────────────────────────────

type SoundType = 'piano' | 'organ' | 'pad' | 'synth'

const PRESETS: Record<SoundType, {
  osc1: OscillatorType; osc2: OscillatorType
  detune: number          // cents, osc2 offset
  osc2Ratio: number       // freq multiplier for osc2 (1 = same, 2 = octave up)
  osc2Gain: number        // 0-1 relative to osc1
  attack: number; decay: number; sustain: number; release: number
  filterBase: number; filterPeak: number; filterQ: number
}> = {
  piano:  { osc1:'sawtooth', osc2:'triangle',  detune:6,  osc2Ratio:1,   osc2Gain:0.6,
             attack:0.005, decay:0.14, sustain:0.4, release:0.45,
             filterBase:700, filterPeak:4500, filterQ:1.4 },
  organ:  { osc1:'sine',     osc2:'sine',       detune:0,  osc2Ratio:2,   osc2Gain:0.45,
             attack:0.008, decay:0,    sustain:1.0, release:0.03,
             filterBase:2800, filterPeak:0, filterQ:0.3 },
  pad:    { osc1:'triangle', osc2:'triangle',   detune:11, osc2Ratio:1,   osc2Gain:0.8,
             attack:0.38,  decay:0.5,  sustain:0.65, release:1.3,
             filterBase:300, filterPeak:2200, filterQ:2.8 },
  synth:  { osc1:'sawtooth', osc2:'square',     detune:7,  osc2Ratio:1,   osc2Gain:0.5,
             attack:0.008, decay:0.09, sustain:0.52, release:0.22,
             filterBase:180, filterPeak:6500, filterQ:4.5 },
}

// Generate a synthetic hall reverb impulse response
function buildReverbIR(actx: AudioContext, duration = 2.8, decay = 1.8): AudioBuffer {
  const len = Math.ceil(actx.sampleRate * duration)
  const ir = actx.createBuffer(2, len, actx.sampleRate)
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c)
    for (let i = 0; i < len; i++) {
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay)
    }
  }
  return ir
}

// ─── Component ────────────────────────────────────────────────────────────────

export function MobileSynth() {
  const [ready, setReady] = useState(false)
  const [midiFile, setMidiFile] = useState<string | null>(null)
  const [midiData, setMidiData] = useState<MidiData | null>(null)
  const [playing, setPlaying] = useState(false)
  const [fireOn, setFireOn] = useState(false)
  const [rainOn, setRainOn] = useState(false)
  const [pos, setPos] = useState(0)
  const [midiVol, setMidiVol] = useState(0.7)
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [soundType, setSoundType] = useState<SoundType>('piano')
  const soundTypeRef = useRef<SoundType>('piano')
  const reverbAmtRef = useRef(0.35)
  const delayAmtRef = useRef(0.22)
  const fireIntRef = useRef(0.6)
  const rainIntRef = useRef(0.6)
  const [, forceRender] = useState(0)

  // Effects refs
  const preFxRef = useRef<GainNode | null>(null)
  const reverbGainRef = useRef<GainNode | null>(null)
  const delayWetRef = useRef<GainNode | null>(null)
  const delayFbRef = useRef<GainNode | null>(null)

  const filtered = useMemo(() =>
    MIDI_FILES.filter(f => f.toLowerCase().includes(search.toLowerCase())),
    [search]
  )

  const ctx = useRef<AudioContext | null>(null)
  const master = useRef<GainNode | null>(null)
  const noiseBuffer = useRef<AudioBuffer | null>(null)
  const midiGain = useRef<GainNode | null>(null)

  // MIDI scheduler refs
  const midiStart = useRef(0)
  const noteIdx = useRef(0)
  const schedulerTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const posTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const activeOscs = useRef<Set<OscillatorNode>>(new Set())

  // Fire refs
  const fireSrc = useRef<AudioBufferSourceNode | null>(null)
  const fireGain = useRef<GainNode | null>(null)
  const fireTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Rain refs
  const rainSrc1 = useRef<AudioBufferSourceNode | null>(null)
  const rainSrc2 = useRef<AudioBufferSourceNode | null>(null)
  const rainGain1 = useRef<GainNode | null>(null)
  const rainGain2 = useRef<GainNode | null>(null)

  // Resume AudioContext when page becomes visible again (iOS requirement)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && ctx.current?.state === 'suspended') {
        ctx.current.resume()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      schedulerTimer.current && clearTimeout(schedulerTimer.current)
      posTimer.current && clearInterval(posTimer.current)
      fireTimer.current && clearTimeout(fireTimer.current)
      activeOscs.current.forEach(o => { try { o.stop(0) } catch { /* */ } })
      try { fireSrc.current?.stop() } catch { /* */ }
      try { rainSrc1.current?.stop() } catch { /* */ }
      try { rainSrc2.current?.stop() } catch { /* */ }
      ctx.current?.close()
    }
  }, [])

  // ── Audio init (must happen inside a user gesture on iOS) ──────────────────
  const startAudio = useCallback(async () => {
    const AC = (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)
    const actx = new AC()
    if (actx.state === 'suspended') await actx.resume()

    // Master chain: gain → compressor → destination
    const comp = actx.createDynamicsCompressor()
    comp.threshold.value = -18
    comp.knee.value = 8
    comp.ratio.value = 4
    comp.attack.value = 0.005
    comp.release.value = 0.1
    comp.connect(actx.destination)

    const mg = actx.createGain()
    mg.gain.value = 0.85
    mg.connect(comp)

    // MIDI volume gain
    const mGain = actx.createGain()
    mGain.gain.value = midiVol
    mGain.connect(mg)

    // ── Effects chain: voices → preFx → dry + reverb + delay → mGain ──
    const preFx = actx.createGain()
    preFx.gain.value = 1

    // Reverb
    const reverb = actx.createConvolver()
    reverb.buffer = buildReverbIR(actx)
    const reverbGain = actx.createGain()
    reverbGain.gain.value = reverbAmtRef.current
    preFx.connect(reverb)
    reverb.connect(reverbGain)
    reverbGain.connect(mGain)

    // Delay with feedback
    const delay = actx.createDelay(1.0)
    delay.delayTime.value = 0.28
    const delayFb = actx.createGain()
    delayFb.gain.value = 0.32
    const delayWet = actx.createGain()
    delayWet.gain.value = delayAmtRef.current
    preFx.connect(delay)
    delay.connect(delayFb)
    delayFb.connect(delay)   // feedback loop
    delay.connect(delayWet)
    delayWet.connect(mGain)

    // Dry signal
    preFx.connect(mGain)

    // White noise buffer (3 sec, for fire/rain)
    const bufLen = actx.sampleRate * 3
    const nb = actx.createBuffer(1, bufLen, actx.sampleRate)
    const nd = nb.getChannelData(0)
    for (let i = 0; i < bufLen; i++) nd[i] = Math.random() * 2 - 1

    ctx.current = actx
    master.current = mg
    midiGain.current = mGain
    preFxRef.current = preFx
    reverbGainRef.current = reverbGain
    delayWetRef.current = delayWet
    delayFbRef.current = delayFb
    noiseBuffer.current = nb
    setReady(true)
  }, [midiVol])

  // ── MIDI note playback ─────────────────────────────────────────────────────
  const playNote = useCallback((note: MidiNote, startAt: number) => {
    const actx = ctx.current
    const dest = preFxRef.current
    if (!actx || !dest) return

    const p = PRESETS[soundTypeRef.current]
    const freq = midiToFreq(note.note)
    const vel = note.velocity / 127
    const rel = startAt + note.duration
    const end = rel + p.release + 0.05

    // Oscillator 1 (primary)
    const osc1 = actx.createOscillator()
    osc1.type = p.osc1
    osc1.frequency.value = freq

    // Oscillator 2 (secondary — detuned or harmonic)
    const osc2 = actx.createOscillator()
    osc2.type = p.osc2
    osc2.frequency.value = freq * p.osc2Ratio
    osc2.detune.value = p.detune

    const osc2Gain = actx.createGain()
    osc2Gain.gain.value = p.osc2Gain

    // Lowpass filter with envelope
    const filt = actx.createBiquadFilter()
    filt.type = 'lowpass'
    filt.Q.value = p.filterQ
    const fBase = p.filterBase
    const fPeak = fBase + p.filterPeak * vel
    filt.frequency.setValueAtTime(fBase, startAt)
    filt.frequency.linearRampToValueAtTime(fPeak, startAt + p.attack + p.decay * 0.5)
    filt.frequency.exponentialRampToValueAtTime(Math.max(fBase * 0.8, 80), rel)
    filt.frequency.exponentialRampToValueAtTime(Math.max(fBase * 0.4, 60), end)

    // Amplitude envelope (ADSR)
    const env = actx.createGain()
    const atkEnd = startAt + p.attack
    const decEnd = atkEnd + p.decay
    env.gain.setValueAtTime(0, startAt)
    env.gain.linearRampToValueAtTime(vel, atkEnd)
    env.gain.exponentialRampToValueAtTime(Math.max(vel * p.sustain, 0.0001), decEnd)
    env.gain.setValueAtTime(Math.max(vel * p.sustain, 0.0001), rel)
    env.gain.exponentialRampToValueAtTime(0.0001, end)

    // Wire up: osc1 + osc2 → filter → env → preFx (effects chain)
    osc1.connect(filt)
    osc2.connect(osc2Gain)
    osc2Gain.connect(filt)
    filt.connect(env)
    env.connect(dest)

    osc1.start(startAt); osc1.stop(end)
    osc2.start(startAt); osc2.stop(end)

    activeOscs.current.add(osc1)
    osc1.onended = () => activeOscs.current.delete(osc1)
  }, [])

  // ── Lookahead scheduler (avoids scheduling thousands of nodes at once) ─────
  const runScheduler = useCallback(() => {
    const actx = ctx.current
    const notes = midiData?.notes
    if (!actx || !notes) return

    const AHEAD = 2.0
    const until = actx.currentTime + AHEAD
    let i = noteIdx.current

    while (i < notes.length && midiStart.current + notes[i].time < until) {
      playNote(notes[i], midiStart.current + notes[i].time)
      i++
    }
    noteIdx.current = i

    if (i < notes.length) {
      schedulerTimer.current = setTimeout(runScheduler, 200)
    } else {
      // All notes scheduled — wait for the last one to finish
      const remaining = (midiStart.current + (midiData?.duration ?? 0)) - actx.currentTime
      setTimeout(() => setPlaying(false), remaining * 1000 + 300)
    }
  }, [midiData, playNote])

  const playMidi = useCallback(() => {
    const actx = ctx.current
    if (!actx || !midiData) return
    midiStart.current = actx.currentTime + 0.1
    noteIdx.current = 0
    setPlaying(true)
    runScheduler()
    posTimer.current = setInterval(() => {
      setPos(Math.max(0, (ctx.current?.currentTime ?? 0) - midiStart.current))
    }, 100)
  }, [midiData, runScheduler])

  const stopMidi = useCallback(() => {
    schedulerTimer.current && clearTimeout(schedulerTimer.current)
    posTimer.current && clearInterval(posTimer.current)
    activeOscs.current.forEach(o => { try { o.stop(0) } catch { /* */ } })
    activeOscs.current.clear()
    setPlaying(false)
    setPos(0)
  }, [])

  // ── Fire crackle ───────────────────────────────────────────────────────────
  const startFire = useCallback(() => {
    const actx = ctx.current
    const mg = master.current
    const nb = noiseBuffer.current
    if (!actx || !mg || !nb) return

    const src = actx.createBufferSource()
    src.buffer = nb
    src.loop = true

    const filt = actx.createBiquadFilter()
    filt.type = 'bandpass'
    filt.frequency.value = 900
    filt.Q.value = 1.8

    const gain = actx.createGain()
    gain.gain.value = 0

    src.connect(filt)
    filt.connect(gain)
    gain.connect(mg)
    src.start()

    fireSrc.current = src
    fireGain.current = gain

    const crackle = () => {
      const g = fireGain.current
      const a = actx
      if (!g) return
      const now = a.currentTime
      const intensity = fireIntRef.current
      const amp = (0.08 + Math.random() * 0.35) * intensity
      const burst = 0.008 + Math.random() * 0.07

      g.gain.cancelScheduledValues(now)
      g.gain.setValueAtTime(g.gain.value, now)
      g.gain.linearRampToValueAtTime(amp, now + 0.003)
      g.gain.exponentialRampToValueAtTime(0.0001, now + burst)

      fireTimer.current = setTimeout(crackle, 15 + Math.random() * 170)
    }
    crackle()
    setFireOn(true)
  }, [])

  const stopFire = useCallback(() => {
    fireTimer.current && clearTimeout(fireTimer.current)
    try { fireSrc.current?.stop() } catch { /* */ }
    fireSrc.current = null
    fireGain.current = null
    setFireOn(false)
  }, [])

  // ── Rain ───────────────────────────────────────────────────────────────────
  const startRain = useCallback(() => {
    const actx = ctx.current
    const mg = master.current
    const nb = noiseBuffer.current
    if (!actx || !mg || !nb) return

    // Layer 1: low rumble
    const src1 = actx.createBufferSource()
    src1.buffer = nb
    src1.loop = true
    const filt1 = actx.createBiquadFilter()
    filt1.type = 'lowpass'
    filt1.frequency.value = 450
    const g1 = actx.createGain()
    g1.gain.value = 0.18 * rainIntRef.current
    src1.connect(filt1); filt1.connect(g1); g1.connect(mg)
    src1.start()

    // Layer 2: high detail / drops
    const src2 = actx.createBufferSource()
    src2.buffer = nb
    src2.loop = true
    src2.loopStart = 0.9 // offset so layers don't phase-cancel
    const filt2 = actx.createBiquadFilter()
    filt2.type = 'bandpass'
    filt2.frequency.value = 2200
    filt2.Q.value = 0.9
    const g2 = actx.createGain()
    g2.gain.value = 0.07 * rainIntRef.current
    src2.connect(filt2); filt2.connect(g2); g2.connect(mg)
    src2.start()

    rainSrc1.current = src1; rainSrc2.current = src2
    rainGain1.current = g1; rainGain2.current = g2
    setRainOn(true)
  }, [])

  const stopRain = useCallback(() => {
    try { rainSrc1.current?.stop() } catch { /* */ }
    try { rainSrc2.current?.stop() } catch { /* */ }
    rainSrc1.current = rainSrc2.current = null
    rainGain1.current = rainGain2.current = null
    setRainOn(false)
  }, [])

  // ── Load MIDI from public folder ───────────────────────────────────────────
  const loadMidi = useCallback(async (name: string) => {
    if (playing) stopMidi()
    setLoading(true)
    try {
      const res = await fetch(`/midi/${name}.mid`)
      if (!res.ok) throw new Error('fetch failed')
      const buf = await res.arrayBuffer()
      const parsed = parseMidi(buf)
      setMidiData(parsed)
      setMidiFile(name)
      setPos(0)
    } catch {
      alert(`Could not load ${name}`)
    } finally {
      setLoading(false)
    }
  }, [playing, stopMidi])

  // ── Start screen (required for iOS AudioContext unlock) ────────────────────
  if (!ready) {
    return (
      <div className="min-h-screen bg-gray-950 flex flex-col items-center justify-center gap-4 px-6">
        <div className="text-5xl">🎹</div>
        <h1 className="text-2xl font-bold text-white text-center">Mobile Synth</h1>
        <p className="text-gray-400 text-sm text-center">Tap to unlock audio — required on iPhone</p>
        <button
          onClick={startAudio}
          className="mt-2 bg-orange-500 hover:bg-orange-400 active:scale-95 transition-all text-white text-xl font-bold px-10 py-5 rounded-2xl shadow-xl shadow-orange-900/40"
        >
          Start Synth
        </button>
      </div>
    )
  }

  // ── Main UI ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-gray-950 text-white pb-8">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-4 flex items-center justify-between">
        <h1 className="text-lg font-bold text-orange-400">🎹 Mobile Synth</h1>
        <div className="flex gap-2">
          {fireOn && <span className="text-xs bg-orange-800 text-orange-200 px-2 py-1 rounded-full">🔥 Fire</span>}
          {rainOn && <span className="text-xs bg-blue-800 text-blue-200 px-2 py-1 rounded-full">🌧 Rain</span>}
          {playing && <span className="text-xs bg-green-800 text-green-200 px-2 py-1 rounded-full">▶ MIDI</span>}
        </div>
      </div>

      <div className="px-4 py-5 space-y-4 max-w-md mx-auto">

        {/* ── MIDI Player ── */}
        <section className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          <h2 className="text-sm font-semibold text-blue-400 uppercase tracking-wider mb-3">
            MIDI Player {loading && <span className="text-gray-500 normal-case font-normal">loading…</span>}
          </h2>

          {/* Now playing */}
          {midiFile && (
            <div className="text-white text-sm font-medium mb-2 truncate">
              ♩ {formatName(midiFile)}
            </div>
          )}

          {/* Progress + transport */}
          {midiData && (
            <div className="space-y-3 mb-3">
              <div className="relative h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="absolute inset-y-0 left-0 bg-blue-500 rounded-full transition-all"
                  style={{ width: `${midiData.duration > 0 ? (pos / midiData.duration) * 100 : 0}%` }}
                />
              </div>
              <div className="flex justify-between text-xs text-gray-500">
                <span>{fmt(pos)}</span>
                <span>{midiData.notes.length} notes · {Math.round(midiData.bpm)} BPM</span>
                <span>{fmt(midiData.duration)}</span>
              </div>
              <button
                onClick={playing ? stopMidi : playMidi}
                className={`w-full py-3 rounded-xl font-bold text-base transition-all active:scale-95 ${
                  playing ? 'bg-red-600 hover:bg-red-500' : 'bg-blue-600 hover:bg-blue-500'
                }`}
              >
                {playing ? '⏹  Stop' : '▶  Play'}
              </button>
              <div>
                <div className="flex justify-between text-xs text-gray-500 mb-1">
                  <span>Volume</span><span>{Math.round(midiVol * 100)}%</span>
                </div>
                <input type="range" min="0" max="1" step="0.01" value={midiVol}
                  onChange={e => { const v = parseFloat(e.target.value); setMidiVol(v); if (midiGain.current) midiGain.current.gain.value = v }}
                  className="w-full accent-blue-400"
                />
              </div>
            </div>
          )}

          {/* Song browser */}
          <input
            type="search"
            placeholder="Search 417 Bach pieces…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full bg-gray-800 text-white text-sm rounded-xl px-3 py-2.5 mb-2 outline-none placeholder-gray-600 border border-gray-700 focus:border-blue-500"
          />
          <div className="overflow-y-auto max-h-56 rounded-xl border border-gray-800 divide-y divide-gray-800">
            {filtered.slice(0, 100).map(name => (
              <button
                key={name}
                onClick={() => loadMidi(name)}
                className={`w-full text-left px-3 py-2.5 text-sm transition-colors active:bg-blue-900/40 ${
                  midiFile === name
                    ? 'bg-blue-900/50 text-blue-300'
                    : 'text-gray-300 hover:bg-gray-800'
                }`}
              >
                {formatName(name)}
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="text-gray-600 text-xs text-center py-4">No results</p>
            )}
            {filtered.length > 100 && (
              <p className="text-gray-600 text-xs text-center py-2">
                Showing 100 of {filtered.length} — search to narrow
              </p>
            )}
          </div>
        </section>

        {/* ── Sound ── */}
        <section className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          <h2 className="text-sm font-semibold text-purple-400 uppercase tracking-wider mb-3">Sound</h2>

          {/* Preset buttons */}
          <div className="grid grid-cols-4 gap-2 mb-4">
            {(['piano','organ','pad','synth'] as SoundType[]).map(t => (
              <button
                key={t}
                onClick={() => { setSoundType(t); soundTypeRef.current = t }}
                className={`py-2.5 rounded-xl text-sm font-bold capitalize transition-all active:scale-95 ${
                  soundType === t
                    ? 'bg-purple-600 text-white'
                    : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          {/* Reverb */}
          <div className="mb-3">
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Reverb</span><span>{Math.round(reverbAmtRef.current * 100)}%</span>
            </div>
            <input type="range" min="0" max="0.9" step="0.01"
              defaultValue={reverbAmtRef.current}
              onChange={e => {
                reverbAmtRef.current = parseFloat(e.target.value)
                if (reverbGainRef.current) reverbGainRef.current.gain.value = reverbAmtRef.current
                forceRender(n => n + 1)
              }}
              className="w-full accent-purple-400"
            />
          </div>

          {/* Delay */}
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Delay</span><span>{Math.round(delayAmtRef.current * 100)}%</span>
            </div>
            <input type="range" min="0" max="0.8" step="0.01"
              defaultValue={delayAmtRef.current}
              onChange={e => {
                delayAmtRef.current = parseFloat(e.target.value)
                if (delayWetRef.current) delayWetRef.current.gain.value = delayAmtRef.current
                forceRender(n => n + 1)
              }}
              className="w-full accent-purple-400"
            />
          </div>
        </section>

        {/* ── Fire Crackle ── */}
        <section className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-orange-400 uppercase tracking-wider">🔥 Fire Crackle</h2>
            <button
              onClick={fireOn ? stopFire : startFire}
              className={`px-4 py-2 rounded-xl font-bold text-sm transition-all active:scale-95 ${
                fireOn ? 'bg-orange-700 hover:bg-orange-600' : 'bg-orange-500 hover:bg-orange-400'
              }`}
            >
              {fireOn ? 'Stop' : 'Start'}
            </button>
          </div>
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Intensity</span>
              <span>{Math.round(fireIntRef.current * 100)}%</span>
            </div>
            <input
              type="range" min="0.05" max="1" step="0.01"
              defaultValue={fireIntRef.current}
              onChange={e => {
                fireIntRef.current = parseFloat(e.target.value)
                forceRender(n => n + 1)
              }}
              className="w-full accent-orange-400"
            />
          </div>
        </section>

        {/* ── Rain ── */}
        <section className="bg-gray-900 rounded-2xl p-4 border border-gray-800">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-blue-300 uppercase tracking-wider">🌧 Rain</h2>
            <button
              onClick={rainOn ? stopRain : startRain}
              className={`px-4 py-2 rounded-xl font-bold text-sm transition-all active:scale-95 ${
                rainOn ? 'bg-blue-700 hover:bg-blue-600' : 'bg-blue-500 hover:bg-blue-400'
              }`}
            >
              {rainOn ? 'Stop' : 'Start'}
            </button>
          </div>
          <div>
            <div className="flex justify-between text-xs text-gray-500 mb-1">
              <span>Intensity</span>
              <span>{Math.round(rainIntRef.current * 100)}%</span>
            </div>
            <input
              type="range" min="0.05" max="1" step="0.01"
              defaultValue={rainIntRef.current}
              onChange={e => {
                const v = parseFloat(e.target.value)
                rainIntRef.current = v
                if (rainGain1.current) rainGain1.current.gain.value = 0.18 * v
                if (rainGain2.current) rainGain2.current.gain.value = 0.07 * v
                forceRender(n => n + 1)
              }}
              className="w-full accent-blue-300"
            />
          </div>
        </section>

      </div>
    </div>
  )
}
