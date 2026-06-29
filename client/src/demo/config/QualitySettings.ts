/**
 * Recording quality presets.
 */
export enum RecordingQuality {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Ultra = 'ultra',
}

/**
 * Recording quality settings.
 */
export interface QualityConfig {
  /** Recording tick rate (Hz) */
  tickRate: number;
  /** Whether to record inputs */
  recordInputs: boolean;
  /** Whether to record peak positions */
  recordPeaks: boolean;
  /** Position precision (decimal places) */
  positionPrecision: number;
  /** Rotation precision (decimal places) */
  rotationPrecision: number;
  /** Velocity precision (decimal places) */
  velocityPrecision: number;
  /** Whether to compress data */
  compress: boolean;
}

/**
 * Demo quality settings.
 * Allows users to balance file size vs recording quality.
 */
export class QualitySettings {
  private static readonly presets: Map<RecordingQuality, QualityConfig> = new Map([
    [
      RecordingQuality.Low,
      {
        tickRate: 15,
        recordInputs: false,
        recordPeaks: false,
        positionPrecision: 2,
        rotationPrecision: 2,
        velocityPrecision: 1,
        compress: true,
      },
    ],
    [
      RecordingQuality.Medium,
      {
        tickRate: 30,
        recordInputs: true,
        recordPeaks: false,
        positionPrecision: 3,
        rotationPrecision: 3,
        velocityPrecision: 2,
        compress: true,
      },
    ],
    [
      RecordingQuality.High,
      {
        tickRate: 60,
        recordInputs: true,
        recordPeaks: true,
        positionPrecision: 4,
        rotationPrecision: 4,
        velocityPrecision: 3,
        compress: false,
      },
    ],
    [
      RecordingQuality.Ultra,
      {
        tickRate: 120,
        recordInputs: true,
        recordPeaks: true,
        positionPrecision: 6,
        rotationPrecision: 6,
        velocityPrecision: 4,
        compress: false,
      },
    ],
  ]);

  /**
   * Get quality preset.
   * @param quality - Quality preset
   * @returns Quality config
   */
  static getPreset(quality: RecordingQuality): QualityConfig {
    return this.presets.get(quality)!;
  }

  /**
   * Get custom quality config.
   * @param tickRate - Recording tick rate
   * @param recordInputs - Whether to record inputs
   * @param recordPeaks - Whether to record peaks
   * @param positionPrecision - Position precision
   * @param rotationPrecision - Rotation precision
   * @param velocityPrecision - Velocity precision
   * @param compress - Whether to compress
   * @returns Quality config
   */
  static getCustomConfig(
    tickRate: number,
    recordInputs: boolean,
    recordPeaks: boolean,
    positionPrecision: number,
    rotationPrecision: number,
    velocityPrecision: number,
    compress: boolean
  ): QualityConfig {
    return {
      tickRate,
      recordInputs,
      recordPeaks,
      positionPrecision,
      rotationPrecision,
      velocityPrecision,
      compress,
    };
  }

  /**
   * Estimate file size for quality config.
   * @param config - Quality config
   * @param duration - Duration in seconds
   * @returns Estimated file size in bytes
   */
  static estimateFileSize(config: QualityConfig, duration: number): number {
    const framesPerSecond = config.tickRate;
    const totalFrames = framesPerSecond * duration;

    // Frame size estimate
    const frameSize = 32; // Base size
    const precisionMultiplier = (config.positionPrecision + config.rotationPrecision + config.velocityPrecision) / 10;
    const estimatedFrameSize = frameSize * precisionMultiplier;

    const totalFrameSize = totalFrames * estimatedFrameSize;

    // Input size (if enabled)
    let inputSize = 0;
    if (config.recordInputs) {
      inputSize = totalFrames * 4; // 4 bytes per frame for inputs
    }

    // Peak size (if enabled)
    let peakSize = 0;
    if (config.recordPeaks) {
      peakSize = totalFrames * 0.1 * 12; // 10% of frames have peaks, 12 bytes each
    }

    const totalSize = totalFrameSize + inputSize + peakSize;

    // Apply compression ratio (if enabled)
    if (config.compress) {
      return totalSize * 0.7; // 30% compression
    }

    return totalSize;
  }

  /**
   * Get recommended quality for use case.
   * @param useCase - Use case
   * @returns Recommended quality preset
   */
  static getRecommendedQuality(useCase: 'highlight' | 'fullmatch' | 'tutorial' | 'analysis'): RecordingQuality {
    switch (useCase) {
      case 'highlight':
        return RecordingQuality.High; // High quality for cool moments
      case 'fullmatch':
        return RecordingQuality.Medium; // Balanced for full matches
      case 'tutorial':
        return RecordingQuality.Ultra; // Maximum quality for tutorials
      case 'analysis':
        return RecordingQuality.Ultra; // Maximum precision for analysis
      default:
        return RecordingQuality.Medium;
    }
  }

  /**
   * Validate quality config.
   * @param config - Quality config
   * @returns Validation result
   */
  static validate(config: QualityConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (config.tickRate < 1 || config.tickRate > 240) {
      errors.push('Tick rate must be between 1 and 240 Hz');
    }

    if (config.positionPrecision < 0 || config.positionPrecision > 10) {
      errors.push('Position precision must be between 0 and 10');
    }

    if (config.rotationPrecision < 0 || config.rotationPrecision > 10) {
      errors.push('Rotation precision must be between 0 and 10');
    }

    if (config.velocityPrecision < 0 || config.velocityPrecision > 10) {
      errors.push('Velocity precision must be between 0 and 10');
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
