/**
 * Demo system configuration constants.
 * Centralized configuration for easy tuning.
 */

/**
 * Recording configuration.
 */
export const DEMO_RECORDING_CONFIG = {
  /** Buffer duration in seconds */
  BUFFER_DURATION: 30,

  /** Recording tick rate (Hz) */
  RECORDING_TICK_RATE: 60,

  /** Whether to record input state */
  RECORD_INPUTS: true,

  /** Whether to auto-start recording */
  AUTO_RECORD: true,

  /** Whether to record peak positions */
  RECORD_PEAK_POSITIONS: false,

  /** Maximum events per second */
  MAX_EVENTS_PER_SECOND: 1000,

  /** Maximum total events */
  MAX_TOTAL_EVENTS: 10000,

  /** Whether to require data providers */
  REQUIRE_DATA_PROVIDERS: true,

  /** Whether to log missing providers */
  LOG_MISSING_PROVIDERS: true,
} as const;

/**
 * Serialization configuration.
 */
export const DEMO_SERIALIZATION_CONFIG = {
  /** Current format version */
  CURRENT_FORMAT_VERSION: 1,

  /** Magic number for demo files */
  MAGIC_NUMBER: 0x44, // 'D'

  /** Header size in bytes */
  HEADER_SIZE: 64,

  /** Whether to calculate checksums */
  ENABLE_CHECKSUM: true,
} as const;

/**
 * Playback configuration.
 */
export const DEMO_PLAYBACK_CONFIG = {
  /** Default playback speed */
  DEFAULT_PLAYBACK_SPEED: 1.0,

  /** Whether to loop playback by default */
  DEFAULT_LOOP_PLAYBACK: false,

  /** Default interpolation mode */
  DEFAULT_INTERPOLATION_MODE: 'linear' as const,

  /** Gravity for parabolic interpolation */
  GRAVITY: -20.0,

  /** Maximum extrapolation time (seconds) */
  MAX_EXTRAPOLATION_TIME: 0.5,
} as const;

/**
 * Cool hit detection configuration.
 */
export const DEMO_COOL_HIT_CONFIG = {
  /** Minimum distance for long range shot (meters) */
  LONG_RANGE_DISTANCE: 100,

  /** Minimum velocity for high velocity shot (m/s) */
  HIGH_VELOCITY_THRESHOLD: 50,

  /** Minimum bounces for bank shot */
  MIN_BOUNCES_FOR_COOL: 2,

  /** Whether to enable prediction detection */
  ENABLE_PREDICTION_DETECTION: true,

  /** Seconds before hit to include in clip */
  CLIP_BEFORE_HIT: 2,

  /** Seconds after hit to include in clip */
  CLIP_AFTER_HIT: 2,

  /** Maximum clips per session */
  MAX_CLIPS_PER_SESSION: 10,
} as const;

/**
 * File management configuration.
 */
export const DEMO_FILE_CONFIG = {
  /** Demo file extension */
  FILE_EXTENSION: '.demo',

  /** Default demo directory (browser: not applicable, use IndexedDB) */
  DEFAULT_DIRECTORY: 'demos',

  /** Maximum demos to keep */
  MAX_DEMOS_TO_KEEP: 50,

  /** Maximum storage in bytes (50 MB) */
  MAX_STORAGE_BYTES: 50 * 1024 * 1024,

  /** Whether to auto-delete old demos */
  AUTO_DELETE_OLD_DEMOS: true,

  /** Demo retention in days */
  DEMO_RETENTION_DAYS: 30,
} as const;

/**
 * All demo configuration.
 */
export const DEMO_CONFIG = {
  RECORDING: DEMO_RECORDING_CONFIG,
  SERIALIZATION: DEMO_SERIALIZATION_CONFIG,
  PLAYBACK: DEMO_PLAYBACK_CONFIG,
  COOL_HIT: DEMO_COOL_HIT_CONFIG,
  FILE: DEMO_FILE_CONFIG,
} as const;
