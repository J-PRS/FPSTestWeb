import type { DemoManager } from './DemoManager.js';

// Playback/UI wiring — the callback graft between DemoPlayer/DemoUI and
// the manager's public surface. Lives outside DemoManager so the wire-up
// doesn't sit between the action methods.

export function wirePlayerCallbacks(m: DemoManager): void {

    m.player.setCallbacks({
      onFrameUpdate: (state, events) => {
        m.onPlaybackState?.(state);
        m.onPlaybackEvent?.(events);
      },
      onPlaybackEnd: () => {
        m.mode = 'paused';
        m.ui.setPlaying(false);
        m.onPlaybackEnd?.();
      },
      onTimeUpdate: (current, duration) => {
        m.ui.setTime(current, duration);
      },
      onSeek: () => {
        m.onPlaybackSeek?.();
      },
    });
}

export function buildDemoUI(m: DemoManager): void {
    m.ui.setCallbacks({
      onPlayPause: () => m.togglePlayPause(),
      onSeek: (time: number) => {
        m.player.seek(time);
        // Replicas snap to the interpolated pose at the seek target
        m.onRemotePlayback?.(m.player.getRemoteStates(), 0);
      },
      onSpeedChange: (speed: number) => {
        m.player.setSpeed(speed);
      },
      onLoop: (loop: boolean) => {
        m.player.setLoop(loop);
        m.ui.setLoopActive(loop);
      },
      onStop: () => {
        m.player.stop();
        m.mode = 'idle';
        m.ui.setPlaying(false);
        m.ui.hide();
        m.uiVisible = false;
        m.onPlaybackStop?.();
        // Stop exits replay — flush any in-flight video export so the clip
        // isn't abandoned silently.
        if (m.video.isRecording) m.toggleVideoRecord();
      },
      onSave: () => {
        m.saveDemo();
      },
      onLoad: (file: File) => {
        m.loadDemo(file);
      },
      onRecordToggle: () => {
        if (m.mode === 'recording') {
          m.stopRecording();
        } else {
          m.startRecording();
        }
      },
      onVideoToggle: () => {
        m.toggleVideoRecord();
      },
    });
}
