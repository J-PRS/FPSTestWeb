# Trap: bare `stop()` on Web Audio sources pops

Symptom: many SFX ended with a small click/pop — most audible on loops
(jet, wind, ski) and any source cut mid-waveform.

## Mechanism

Calling `src.stop()` while the waveform sits at non-zero amplitude
drops the signal to zero in one sample. That discontinuity IS the click
— it's physics, not a browser bug, and the ear picks it up even at low
levels. Our `env()` envelopes and `sample()` tail ramp already decayed
to ~0, so the pops only came from bare `stop()` calls scattered across
a dozen sfx files (loops, scheduled oscillator ends, early cuts).

## Wrong fixes tried / why patching call sites is a trap

- Chasing every `.stop()` call: dozens of sites, and new voices keep
  landing without the fade. A convention you must remember to apply is
  a trap, not a fix.
- `setTargetAtTime` fades: still leaves a faint click; exponential
  ramps decay faster near zero.

## Fix that worked — one global patch

`client/src/core/audio.ts` `wire()` wraps `createBufferSource` and
`createOscillator`: each source gets a private fade `GainNode` spliced
in at wrap time (its `connect`/`disconnect` are mirrored so callers see
the same interface), and its `stop(when)` schedules an exponential ramp
to 0.0001 ending at `when`, then really stops ~5ms later. All existing
call sites work untouched; env'd sources just fade twice harmlessly.

**Fade duration: 15ms.** Sources searched: ~8-10ms is the accepted
no-perceptible-fade minimum (Alemangui's click guide uses 15-30ms;
OpenAL Soft ships a 2ms floor for the same problem; 8ms worked for a
rebuild writeup). 15ms is safe margin — nobody hears 15ms as a fade.

## Rules

- Never call raw `context.createBufferSource()/createOscillator()` —
  go through the wrapped factories (they ARE the context methods now).
- `stop(t)` semantics preserved: `t` is the end of the ramp, real stop
  lands 5ms after — a future-scheduled stop fades INTO t, not from now.
- If a pop persists, check for sources created by a DIFFERENT path
  (BufferSource from `decodeAudioData` consumers that bypass the
  wrapped factories, MediaElementSource, convolver inputs).
