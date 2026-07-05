/**
 * Demo Recording and Replay System
 * 
 * A robust, backwards-compatible demo system for recording and replaying gameplay.
 * 
 * Features:
 * - Hybrid event-driven recording (continuous frames + sparse keyframes)
 * - Interface-based integration for minimal coupling
 * - Circular buffer for efficient continuous recording
 * - Binary serialization for minimal file size
 * - Version-aware migration for backwards compatibility
 * - Keyframe interpolation for smooth replay
 * - Ghost object system for visualization
 * - Cool hit detection for automatic clip extraction
 * - CRC32 checksums for file integrity
 * - Keyboard shortcuts for quick controls
 * - Performance profiling for optimization
 * - Run-length compression for smaller files
 * - Quality settings for file size vs precision balance
 * 
 * Usage:
 * 1. Implement IPlayerDataProvider and IInputProvider on your game systems
 * 2. Initialize DemoRecorder with these providers
 * 3. Call demoRecorder.update(deltaTime) every frame
 * 4. Record events via IProjectileEventSource and ITargetEventSource
 * 5. Extract demo files with demoRecorder.extractDemoFile()
 * 6. Load and play back with DemoPlayer
 */

// Core components
export * from './core/index.js';

// Data types
export * from './types/index.js';

// Interfaces
export * from './interfaces/index.js';

// Serialization
export * from './serialization/index.js';

// Playback
export * from './playback/index.js';

// Management
export * from './management/index.js';

// Migrations
export * from './migrations/index.js';

// Configuration
export * from './config.js';
export * from './config/index.js';

// Security
export * from './security/index.js';

// Network
export * from './network/index.js';
