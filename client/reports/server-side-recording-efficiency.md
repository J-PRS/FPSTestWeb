# Server-Side Recording Efficiency Design

## Executive Summary

This report outlines a server-side recording architecture optimized for cost efficiency while maintaining logic portability for client-side recording. The design prioritizes storage and computational cost reduction through hybrid keyframe/simulation formats, with shared recording logic that works identically on both server and client. Server-side recording provides guaranteed legitimacy without anti-tampering overhead, while client-side recording remains available as a fallback.

## Architecture Overview

### Dual-Mode Recording System

```
                    Shared Recording Logic
                            ↓
                    ┌─────────────────┐
                    │  DemoRecorder   │
                    │  (Portable)     │
                    └─────────────────┘
                            ↓
              ┌─────────────┴─────────────┐
              ↓                           ↓
        Server Recording            Client Recording
        (Primary Mode)              (Fallback Mode)
              ↓                           ↓
        - Trusted source              - Validation needed
        - Cost optimized              - Same logic
        - No anti-tamper              - Portable
```

### Key Design Principles

1. **Shared Logic** - Recording logic identical on server and client
2. **Cost Optimization** - Storage and computational efficiency for server scale
3. **Portability** - Same format works in both contexts
4. **Trust Model** - Server = trusted, client = untrusted
5. **Fallback Support** - Client recording available when server unavailable

## Server-Side Recording

### Advantages

**Legitimacy:**
- Server controls recording process
- Data comes directly from authoritative game state
- No client tampering possible
- Guaranteed accuracy

**Cost Focus:**
- Storage efficiency is primary concern
- Computational efficiency secondary
- Network bandwidth optimization
- Long-term archival costs

**Simplified Architecture:**
- No anti-tampering needed during recording
- No digital signatures or hash chains
- No complex validation during write
- Focus on pure efficiency

### Recording Architecture

```typescript
// Shared recording logic (works on both server and client)
class DemoRecorder {
  private config: RecordingConfig;
  private mode: RecordingMode;
  
  constructor(config: RecordingConfig, mode: RecordingMode) {
    this.config = config;
    this.mode = mode; // 'server' or 'client'
  }
  
  // Identical logic for both modes
  recordFrame(gameState: GameState): void {
    const frame = this.extractFrame(gameState);
    
    // Adaptive sampling based on activity
    if (this.shouldSample(frame)) {
      this.frames.push(frame);
    }
  }
  
  recordEvent(event: GameEvent): void {
    // Only record critical events
    if (this.isCriticalEvent(event)) {
      this.events.push(this.extractEvent(event));
    }
  }
  
  // Server-specific optimizations
  private shouldSample(frame: DemoFrame): boolean {
    if (this.mode === 'server') {
      // More aggressive sampling for cost savings
      return this.serverSamplingStrategy(frame);
    } else {
      // Less aggressive for client recording
      return this.clientSamplingStrategy(frame);
    }
  }
}
```

### Server-Specific Optimizations

**1. Aggressive Adaptive Sampling**
```typescript
// Server can sample more aggressively for cost savings
serverSamplingStrategy(frame: DemoFrame): boolean {
  const activity = detectActivity(frame);
  
  switch (activity) {
    case ActivityLevel.IDLE: return sampleAt(1); // 1fps
    case ActivityLevel.MOVING: return sampleAt(5); // 5fps
    case ActivityLevel.COMBAT: return sampleAt(15); // 15fps
    case ActivityLevel.HIGH_ACTION: return sampleAt(30); // 30fps
  }
}

// Client needs higher sampling for accuracy
clientSamplingStrategy(frame: DemoFrame): boolean {
  const activity = detectActivity(frame);
  
  switch (activity) {
    case ActivityLevel.IDLE: return sampleAt(5); // 5fps
    case ActivityLevel.MOVING: return sampleAt(15); // 15fps
    case ActivityLevel.COMBAT: return sampleAt(30); // 30fps
    case ActivityLevel.HIGH_ACTION: return sampleAt(60); // 60fps
  }
}
```

**2. Server-Side Event Filtering**
```typescript
// Server can filter non-critical events more aggressively
isCriticalEvent(event: GameEvent): boolean {
  if (this.mode === 'server') {
    // Only record events that affect gameplay state
    return event.type === 'projectile_spawn' ||
           event.type === 'projectile_hit' ||
           event.type === 'player_death' ||
           event.type === 'target_spawn' ||
           event.type === 'target_destroy';
  } else {
    // Client records more events for validation
    return event.type === 'projectile_spawn' ||
           event.type === 'projectile_hit' ||
           event.type === 'projectile_bounce' ||
           event.type === 'player_death' ||
           event.type === 'target_spawn' ||
           event.type === 'target_destroy' ||
           event.type === 'target_hit';
  }
}
```

**3. Batch Processing**
```typescript
// Server can batch writes for efficiency
class ServerDemoRecorder extends DemoRecorder {
  private writeBuffer: DemoFrame[] = [];
  private batchSize = 1000;
  
  recordFrame(gameState: GameState): void {
    super.recordFrame(gameState);
    
    // Batch writes
    this.writeBuffer.push(this.frames[this.frames.length - 1]);
    
    if (this.writeBuffer.length >= this.batchSize) {
      this.flushBuffer();
    }
  }
  
  private flushBuffer(): void {
    // Write batch to storage
    this.storage.writeBatch(this.writeBuffer);
    this.writeBuffer = [];
  }
  
  stop(): void {
    this.flushBuffer(); // Flush remaining
    super.stop();
  }
}
```

## Cost Analysis

### Storage Costs

**Current Format (V2):**
- 60fps × 44 bytes = 2.64KB/sec
- 10 minutes = 158KB
- 1 hour = 950KB
- 1M demos/month = 950TB/month

**Hybrid Format (V3 - Server Optimized):**
- Adaptive sampling (avg 15fps) + delta encoding + compression
- ~0.15KB/sec (94% reduction)
- 10 minutes = 90KB
- 1 hour = 540KB
- 1M demos/month = 540TB/month

**Cost Savings:**
- Storage: 950TB → 540TB (43% reduction)
- At $0.023/GB (AWS S3): $21,850 → $12,420/month savings
- Annual savings: ~$113,000

### Computational Costs

**Current Format:**
- Recording: <1% CPU per match
- Serialization: ~5ms per match
- No compression

**Hybrid Format (Server):**
- Recording: ~2% CPU per match (adaptive sampling)
- Serialization: ~10ms per match (delta encoding)
- Compression: ~50ms per match (LZ4)
- Total: ~65ms per match

**Trade-off Analysis:**
- Extra 65ms per match for 43% storage savings
- For 1M matches/month: 18 hours extra CPU time
- CPU cost: Minimal compared to storage savings

### Network Costs

**Download Bandwidth:**
- Current: 158KB per 10-minute demo
- Hybrid: 90KB per 10-minute demo
- Reduction: 43%

**For 100K downloads/day:**
- Current: 15.8GB/day
- Hybrid: 9GB/day
- Savings: 6.8GB/day = 204GB/month

## Portability Design

### Shared Recording Logic

```typescript
// Core recording logic (shared between server and client)
class CoreDemoRecorder {
  protected frames: DemoFrame[] = [];
  protected events: GameEvent[] = [];
  protected config: RecordingConfig;
  
  constructor(config: RecordingConfig) {
    this.config = config;
  }
  
  // Shared frame extraction
  protected extractFrame(gameState: GameState): DemoFrame {
    return {
      frameNumber: gameState.frameNumber,
      timestamp: gameState.timestamp,
      position: gameState.player.position,
      velocity: gameState.player.velocity,
      rotation: gameState.player.rotation,
      inputFlags: gameState.player.inputFlags,
      // ... other fields
    };
  }
  
  // Shared event extraction
  protected extractEvent(event: GameEvent): GameEvent {
    return {
      type: event.type,
      timestamp: event.timestamp,
      data: event.data
    };
  }
  
  // Shared serialization
  serialize(): ArrayBuffer {
    return DemoSerializer.serialize({
      header: this.buildHeader(),
      frames: this.frames,
      events: this.events
    });
  }
}

// Server-specific implementation
class ServerDemoRecorder extends CoreDemoRecorder {
  constructor(config: ServerRecordingConfig) {
    super(config);
  }
  
  // Server-specific optimizations
  protected shouldSample(frame: DemoFrame): boolean {
    return this.serverSamplingStrategy(frame);
  }
}

// Client-specific implementation
class ClientDemoRecorder extends CoreDemoRecorder {
  constructor(config: ClientRecordingConfig) {
    super(config);
  }
  
  // Client-specific optimizations
  protected shouldSample(frame: DemoFrame): boolean {
    return this.clientSamplingStrategy(frame);
  }
  
  // Client-specific validation
  validate(): ValidationResult {
    return GameplayValidator.validate(this.serialize());
  }
}
```

### Configuration System

```typescript
// Base configuration
interface RecordingConfig {
  tickRate: number;
  bufferSeconds: number;
  compressionEnabled: boolean;
  formatVersion: number;
}

// Server-specific configuration
interface ServerRecordingConfig extends RecordingConfig {
  samplingStrategy: 'aggressive' | 'balanced' | 'conservative';
  eventFiltering: 'minimal' | 'standard' | 'comprehensive';
  batchSize: number;
  storageBackend: 'local' | 's3' | 'gcs';
}

// Client-specific configuration
interface ClientRecordingConfig extends RecordingConfig {
  samplingStrategy: 'standard' | 'high_quality';
  eventFiltering: 'standard' | 'comprehensive';
  validationEnabled: boolean;
  maxFileSize: number;
}

// Example configurations
const serverConfig: ServerRecordingConfig = {
  tickRate: 60,
  bufferSeconds: 600, // 10 minutes
  compressionEnabled: true,
  formatVersion: 3,
  samplingStrategy: 'aggressive',
  eventFiltering: 'minimal',
  batchSize: 1000,
  storageBackend: 's3'
};

const clientConfig: ClientRecordingConfig = {
  tickRate: 60,
  bufferSeconds: 300, // 5 minutes
  compressionEnabled: true,
  formatVersion: 3,
  samplingStrategy: 'standard',
  eventFiltering: 'standard',
  validationEnabled: true,
  maxFileSize: 50 * 1024 * 1024 // 50MB
};
```

## Client-Side Recording

### Use Cases

**1. Server Unavailability**
- Network issues
- Server maintenance
- Offline mode

**2. Local Development**
- Testing recording logic
- Debugging playback
- Performance profiling

**3. User-Requested Recording**
- "Save this clip" feature
- Cool shot recording
- Personal highlights

**4. Competitive Integrity**
- Client-side validation reference
- Dispute resolution
- Anti-cheat evidence

### Client-Specific Features

**1. Validation Integration**
```typescript
class ClientDemoRecorder extends CoreDemoRecorder {
  private validator: GameplayValidator;
  
  constructor(config: ClientRecordingConfig) {
    super(config);
    this.validator = new GameplayValidator(config.gameConfig);
  }
  
  stop(): DemoFile {
    const demo = super.stop();
    
    // Validate before returning
    if (this.config.validationEnabled) {
      const validation = this.validator.validate(demo);
      
      if (!validation.valid) {
        console.warn('Demo validation failed:', validation.issues);
        // Still return demo, but flag as suspicious
        demo.validationResult = validation;
      }
    }
    
    return demo;
  }
}
```

**2. User Controls**
```typescript
class ClientDemoRecorder extends CoreDemoRecorder {
  private userPreferences: UserPreferences;
  
  constructor(config: ClientRecordingConfig, preferences: UserPreferences) {
    super(config);
    this.userPreferences = preferences;
  }
  
  // Respect user preferences
  protected shouldSample(frame: DemoFrame): boolean {
    if (!this.userPreferences.enableRecording) {
      return false;
    }
    
    if (this.userPreferences.quality === 'high') {
      return this.highQualitySampling(frame);
    } else {
      return this.standardSampling(frame);
    }
  }
  
  // Auto-stop on file size limit
  protected checkFileSizeLimit(): void {
    const currentSize = this.getCurrentSize();
    
    if (currentSize > this.config.maxFileSize) {
      console.warn('Demo file size limit reached, stopping recording');
      this.stop();
    }
  }
}
```

## Hybrid Format Implementation

### Format Structure

```typescript
interface HybridDemoFile {
  header: DemoHeader;
  frames: HybridFrame[];
  events: CriticalEvent[];
  metadata: RecordingMetadata;
}

interface HybridFrame {
  frameType: 'keyframe' | 'delta';
  frameNumber: number;
  timestamp: number;
  
  // Keyframe: full data
  // Delta: only changes
  position?: Vec3;
  velocity?: Vec3;
  rotation?: Rotation;
  inputFlags?: number;
  
  // Activity level for adaptive sampling
  activityLevel: ActivityLevel;
}

interface CriticalEvent {
  eventType: 'projectile_spawn' | 'projectile_hit' | 'player_death' | 'target_spawn' | 'target_destroy';
  frameNumber: number;  // Reference to nearest frame
  frameOffset: number;  // Microsecond offset
  
  // Event-specific data
  data: EventData;
}

interface RecordingMetadata {
  recordingMode: 'server' | 'client';
  samplingStrategy: string;
  compressionEnabled: boolean;
  recordingStartTime: number;
  recordingEndTime: number;
  serverVersion?: string;  // For server recordings
  clientVersion?: string;  // For client recordings
}
```

### Delta Encoding

```typescript
// Shared delta encoding logic
class DeltaEncoder {
  static encodeFrame(current: DemoFrame, previous: DemoFrame | null): HybridFrame {
    if (!previous || current.frameType === 'keyframe') {
      // Store full keyframe
      return {
        frameType: 'keyframe',
        frameNumber: current.frameNumber,
        timestamp: current.timestamp,
        position: current.position,
        velocity: current.velocity,
        rotation: current.rotation,
        inputFlags: current.inputFlags,
        activityLevel: detectActivity(current)
      };
    }
    
    // Store delta
    return {
      frameType: 'delta',
      frameNumber: current.frameNumber,
      timestamp: current.timestamp,
      position: {
        x: current.position.x - previous.position.x,
        y: current.position.y - previous.position.y,
        z: current.position.z - previous.position.z
      },
      velocity: {
        x: current.velocity.x - previous.velocity.x,
        y: current.velocity.y - previous.velocity.y,
        z: current.velocity.z - previous.velocity.z
      },
      rotation: {
        yaw: current.rotation.yaw - previous.rotation.yaw,
        pitch: current.rotation.pitch - previous.rotation.pitch
      },
      activityLevel: detectActivity(current)
    };
  }
  
  static decodeFrame(delta: HybridFrame, previous: DemoFrame | null): DemoFrame {
    if (delta.frameType === 'keyframe' || !previous) {
      // Full keyframe
      return {
        frameNumber: delta.frameNumber,
        timestamp: delta.timestamp,
        position: delta.position!,
        velocity: delta.velocity!,
        rotation: delta.rotation!,
        inputFlags: delta.inputFlags!
      };
    }
    
    // Apply delta
    return {
      frameNumber: delta.frameNumber,
      timestamp: delta.timestamp,
      position: {
        x: previous.position.x + delta.position!.x,
        y: previous.position.y + delta.position!.y,
        z: previous.position.z + delta.position!.z
      },
      velocity: {
        x: previous.velocity.x + delta.velocity!.x,
        y: previous.velocity.y + delta.velocity!.y,
        z: previous.velocity.z + delta.velocity!.z
      },
      rotation: {
        yaw: previous.rotation.yaw + delta.rotation!.yaw,
        pitch: previous.rotation.pitch + delta.rotation!.pitch
      },
      inputFlags: delta.inputFlags!
    };
  }
}
```

## Storage Strategy

### Server-Side Storage

**1. Tiered Storage**
```typescript
class TieredStorageManager {
  private hotStorage: S3Storage;      // Frequent access
  private warmStorage: S3Storage;    // Occasional access
  private coldStorage: GlacierStorage; // Archival
  
  async store(demo: DemoFile, accessPattern: AccessPattern): Promise<void> {
    switch (accessPattern) {
      case 'frequent':
        await this.hotStorage.store(demo);
        break;
      case 'occasional':
        await this.warmStorage.store(demo);
        break;
      case 'archival':
        await this.coldStorage.store(demo);
        break;
    }
  }
  
  async retrieve(demoId: string): Promise<DemoFile> {
    // Try hot storage first
    const hot = await this.hotStorage.retrieve(demoId);
    if (hot) return hot;
    
    // Try warm storage
    const warm = await this.warmStorage.retrieve(demoId);
    if (warm) {
      // Promote to hot storage
      await this.hotStorage.store(warm);
      return warm;
    }
    
    // Try cold storage
    const cold = await this.coldStorage.retrieve(demoId);
    if (cold) {
      // Promote to warm storage
      await this.warmStorage.store(cold);
      return cold;
    }
    
    throw new Error('Demo not found');
  }
}
```

**2. Lifecycle Management**
```typescript
class DemoLifecycleManager {
  private policies: LifecyclePolicy[];
  
  constructor() {
    this.policies = [
      {
        name: 'competitive_matches',
        retention: 90, // days
        accessPattern: 'frequent',
        compression: 'lz4'
      },
      {
        name: 'casual_matches',
        retention: 30, // days
        accessPattern: 'occasional',
        compression: 'zstandard'
      },
      {
        name: 'user_recordings',
        retention: 7, // days
        accessPattern: 'archival',
        compression: 'zstandard'
      }
    ];
  }
  
  async applyLifecycle(demo: DemoFile, category: string): Promise<void> {
    const policy = this.policies.find(p => p.name === category);
    
    // Schedule archival
    await this.scheduleArchival(demo.id, policy.retention);
    
    // Apply compression
    if (policy.compression) {
      const compressed = await this.compress(demo, policy.compression);
      await this.storage.update(demo.id, compressed);
    }
  }
}
```

### Client-Side Storage

**1. Local Storage**
```typescript
class ClientStorageManager {
  private maxStorage: number = 500 * 1024 * 1024; // 500MB
  private currentUsage: number = 0;
  
  async store(demo: DemoFile): Promise<void> {
    const size = demo.byteLength;
    
    // Check storage limit
    if (this.currentUsage + size > this.maxStorage) {
      await this.cleanupOldest(size);
    }
    
    // Store locally
    await localStorage.setItem(demo.id, JSON.stringify(demo));
    this.currentUsage += size;
  }
  
  private async cleanupOldest(requiredSpace: number): Promise<void> {
    const demos = await this.listDemos();
    demos.sort((a, b) => a.timestamp - b.timestamp);
    
    let freedSpace = 0;
    for (const demo of demos) {
      if (freedSpace >= requiredSpace) break;
      
      await localStorage.removeItem(demo.id);
      freedSpace += demo.size;
      this.currentUsage -= demo.size;
    }
  }
}
```

**2. Cloud Sync (Optional)**
```typescript
class CloudSyncManager {
  async syncToCloud(demo: DemoFile): Promise<void> {
    if (!this.userPreferences.enableCloudSync) {
      return;
    }
    
    try {
      await this.cloudStorage.upload(demo);
      console.log('Demo synced to cloud');
    } catch (error) {
      console.warn('Failed to sync demo to cloud:', error);
      // Queue for retry
      this.syncQueue.push(demo);
    }
  }
}
```

## Performance Optimization

### Server-Side Optimizations

**1. Parallel Processing**
```typescript
class ParallelDemoProcessor {
  async processMatches(matches: Match[]): Promise<DemoFile[]> {
    // Process matches in parallel
    const chunks = chunkArray(matches, 10); // 10 matches per worker
    
    const results = await Promise.all(
      chunks.map(chunk => this.processChunk(chunk))
    );
    
    return results.flat();
  }
  
  private async processChunk(matches: Match[]): Promise<DemoFile[]> {
    return Promise.all(
      matches.map(match => this.processMatch(match))
    );
  }
}
```

**2. Memory Pooling**
```typescript
class FrameBufferPool {
  private pool: DemoFrame[] = [];
  private poolSize = 1000;
  
  acquire(): DemoFrame {
    return this.pool.pop() || this.createFrame();
  }
  
  release(frame: DemoFrame): void {
    if (this.pool.length < this.poolSize) {
      this.resetFrame(frame);
      this.pool.push(frame);
    }
  }
  
  private resetFrame(frame: DemoFrame): void {
    // Reset frame to default values
    frame.position = { x: 0, y: 0, z: 0 };
    frame.velocity = { x: 0, y: 0, z: 0 };
    // ... reset other fields
  }
}
```

### Client-Side Optimizations

**1. Lazy Validation**
```typescript
class LazyValidator {
  private validationCache = new Map<string, ValidationResult>();
  
  async validate(demo: DemoFile): Promise<ValidationResult> {
    const cacheKey = demo.id;
    
    if (this.validationCache.has(cacheKey)) {
      return this.validationCache.get(cacheKey)!;
    }
    
    // Validate in background
    const result = await GameplayValidator.validate(demo);
    this.validationCache.set(cacheKey, result);
    
    return result;
  }
}
```

**2. Progressive Loading**
```typescript
class ProgressiveDemoLoader {
  async loadDemo(demoId: string): Promise<AsyncIterator<DemoFrame>> {
    const demo = await this.storage.retrieve(demoId);
    
    return this.createFrameIterator(demo);
  }
  
  private async *createFrameIterator(demo: DemoFile): AsyncIterator<DemoFrame> {
    for (const frame of demo.frames) {
      yield frame;
      
      // Yield to allow UI updates
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
}
```

## Monitoring and Analytics

### Server-Side Monitoring

```typescript
class RecordingMetrics {
  private metrics: MetricsCollector;
  
  recordRecordingStart(matchId: string): void {
    this.metrics.increment('recording.starts', { matchId });
  }
  
  recordRecordingComplete(matchId: string, duration: number, size: number): void {
    this.metrics.histogram('recording.duration', duration, { matchId });
    this.metrics.histogram('recording.size', size, { matchId });
    this.metrics.increment('recording.completes', { matchId });
  }
  
  recordStorageUsage(category: string, size: number): void {
    this.metrics.gauge('storage.usage', size, { category });
  }
  
  recordCompressionRatio(original: number, compressed: number): void {
    const ratio = compressed / original;
    this.metrics.histogram('compression.ratio', ratio);
  }
}
```

### Client-Side Analytics

```typescript
class ClientRecordingAnalytics {
  private analytics: AnalyticsCollector;
  
  recordUserRecordingStart(): void {
    this.analytics.track('demo_recording_started');
  }
  
  recordUserRecordingComplete(duration: number, size: number): void {
    this.analytics.track('demo_recording_completed', {
      duration,
      size,
      compressionEnabled: true
    });
  }
  
  recordValidationResult(result: ValidationResult): void {
    this.analytics.track('demo_validation', {
      valid: result.valid,
      issueCount: result.issues.length,
      confidence: result.confidence
    });
  }
}
```

## Implementation Roadmap

### Phase 1: Core Recording Logic (Week 1-2)
1. Implement CoreDemoRecorder with shared logic
2. Implement ServerDemoRecorder with server optimizations
3. Implement ClientDemoRecorder with client features
4. Add configuration system
5. Basic testing

### Phase 2: Hybrid Format (Week 3-4)
1. Implement delta encoding/decoding
2. Add adaptive sampling
3. Implement critical event filtering
4. Add compression layer
5. Performance testing

### Phase 3: Storage Integration (Week 5-6)
1. Implement tiered storage for server
2. Add lifecycle management
3. Implement client local storage
4. Add cloud sync (optional)
5. Storage cost analysis

### Phase 4: Optimization (Week 7-8)
1. Add parallel processing
2. Implement memory pooling
3. Add lazy validation
4. Implement progressive loading
5. Performance benchmarking

### Phase 5: Monitoring (Week 9-10)
1. Implement server metrics
2. Add client analytics
3. Create dashboards
4. Set up alerts
5. Cost optimization

## Success Criteria

1. **Cost Reduction**: 40%+ storage cost reduction vs current format
2. **Performance**: <100ms recording overhead per match
3. **Portability**: Same logic works on server and client
4. **Reliability**: 99.9% recording success rate
5. **Scalability**: Support 1M+ recordings per month

## Conclusion

The server-side recording architecture prioritizes cost efficiency through hybrid formats and aggressive optimization while maintaining logic portability for client-side recording. The shared recording logic ensures consistency across contexts, while mode-specific optimizations address the unique requirements of each environment. This design provides significant cost savings at scale while maintaining flexibility for client-side recording as a fallback and for user-initiated recordings.

## Appendix: Cost Comparison

### Monthly Costs for 1M Demos

| Component | Current Format | Hybrid Format | Savings |
|-----------|---------------|---------------|---------|
| Storage (10min avg) | 950TB | 540TB | 410TB |
| Storage Cost | $21,850 | $12,420 | $9,430 |
| Network (100K downloads) | 6.1TB | 3.5TB | 2.6TB |
| Network Cost | $610 | $350 | $260 |
| Compute (extra processing) | $0 | $500 | -$500 |
| **Total** | **$22,460** | **$13,270** | **$9,190** |

**Annual Savings: ~$110,000**
