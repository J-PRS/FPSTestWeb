# Demo System Long-Term Robustness Plan

## Executive Summary

The demo system requires significant architectural improvements to ensure long-term robustness, forward/backward compatibility, and data integrity. This plan addresses critical gaps in the current implementation and provides a roadmap for evolution over years of use.

## Current State Assessment

### Strengths
- Binary-efficient format (~44 bytes/frame)
- Version fields (magic, format version, game version)
- CRC32 checksums
- Clean module separation
- Interface-based decoupling

### Critical Gaps
- No migration system for format changes
- No backward compatibility layer
- No forward compatibility (unknown fields not handled)
- Insufficient validation (only CRC32)
- Weak error recovery
- No defined evolution path
- High function complexity (DemoRecorder: 43, Player: 85)

## Architecture Improvements

### 1. Format Registry System

**Objective:** Enable seamless format evolution with backward/forward compatibility.

**Implementation:**

```typescript
// src/demo/format/DemoFormatRegistry.ts
export class DemoFormatRegistry {
  private static formats = new Map<number, DemoFormatSpec>();
  
  static register(spec: DemoFormatSpec): void {
    this.formats.set(spec.version, spec);
  }
  
  static get(version: number): DemoFormatSpec | undefined {
    return this.formats.get(version);
  }
  
  static getLatest(): number {
    return Math.max(...this.formats.keys());
  }
  
  static canMigrate(from: number, to: number): boolean {
    return this.get(from)?.canMigrateTo(to) ?? false;
  }
}

export interface DemoFormatSpec {
  version: number;
  serializer: DemoSerializer;
  deserializer: DemoDeserializer;
  validator: DemoValidator;
  migrator?: DemoMigrator;
  canMigrateTo(targetVersion: number): boolean;
}
```

**Migration Path:**
- V1 (current) → V2 (enhanced validation)
- V2 → V3 (compression)
- Each version supports reading previous 2 versions
- Unknown fields in newer versions are skipped (forward compatibility)

### 2. Multi-Layer Validation System

**Objective:** Comprehensive data integrity beyond CRC32.

**Implementation:**

```typescript
// src/demo/validation/DemoValidator.ts
export class DemoValidator {
  static validate(data: DemoFile, version: number): ValidationResult {
    const results: ValidationIssue[] = [];
    
    // Layer 1: CRC32 checksum
    if (!this.validateChecksum(data)) {
      results.push({ level: 'critical', code: 'CHECKSUM_MISMATCH' });
    }
    
    // Layer 2: Schema validation
    const schemaErrors = this.validateSchema(data, version);
    results.push(...schemaErrors);
    
    // Layer 3: Range validation
    const rangeErrors = this.validateRanges(data);
    results.push(...rangeErrors);
    
    // Layer 4: Consistency validation
    const consistencyErrors = this.validateConsistency(data);
    results.push(...consistencyErrors);
    
    // Layer 5: Temporal validation
    const temporalErrors = this.validateTimeline(data);
    results.push(...temporalErrors);
    
    return {
      valid: results.filter(r => r.level === 'critical').length === 0,
      issues: results
    };
  }
  
  private validateChecksum(data: DemoFile): boolean {
    // CRC32 + additional hash for critical sections
    const headerHash = this.hashHeader(data.header);
    const framesHash = this.hashFrames(data.frames);
    return headerHash === data.header.checksum && framesHash === data.header.framesChecksum;
  }
  
  private validateSchema(data: DemoFile, version: number): ValidationIssue[] {
    const spec = DemoFormatRegistry.get(version);
    return spec.validator.validate(data);
  }
  
  private validateRanges(data: DemoFile): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    
    // Check frame counts match header
    if (data.frames.length !== data.header.totalFrames) {
      issues.push({ level: 'error', code: 'FRAME_COUNT_MISMATCH' });
    }
    
    // Check timestamps are monotonic
    for (let i = 1; i < data.frames.length; i++) {
      if (data.frames[i].timestamp < data.frames[i-1].timestamp) {
        issues.push({ level: 'warning', code: 'NON_MONOTONIC_TIME', frame: i });
      }
    }
    
    // Check position/velocity ranges
    for (const frame of data.frames) {
      if (!this.isValidPosition(frame.posX, frame.posY, frame.posZ)) {
        issues.push({ level: 'warning', code: 'INVALID_POSITION', frame: frame.frameNumber });
      }
      if (!this.isValidVelocity(frame.velX, frame.velY, frame.velZ)) {
        issues.push({ level: 'warning', code: 'INVALID_VELOCITY', frame: frame.frameNumber });
      }
    }
    
    return issues;
  }
  
  private validateConsistency(data: DemoFile): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    
    // Check event counts match header
    if (data.projectileEvents.length !== data.header.projectileEventCount) {
      issues.push({ level: 'error', code: 'PROJ_EVENT_COUNT_MISMATCH' });
    }
    if (data.targetEvents.length !== data.header.targetEventCount) {
      issues.push({ level: 'error', code: 'TARGET_EVENT_COUNT_MISMATCH' });
    }
    
    // Check event timestamps are within frame range
    const frameStart = data.frames[0]?.timestamp ?? 0;
    const frameEnd = data.frames[data.frames.length - 1]?.timestamp ?? 0;
    
    for (const event of data.projectileEvents) {
      if (event.timestamp < frameStart || event.timestamp > frameEnd) {
        issues.push({ level: 'warning', code: 'EVENT_OUT_OF_RANGE', eventId: event.projectileId });
      }
    }
    
    return issues;
  }
  
  private validateTimeline(data: DemoFile): ValidationIssue[] {
    const issues: ValidationIssue[] = [];
    
    // Check duration matches actual frame data
    const actualDuration = data.frames[data.frames.length - 1]?.timestamp - data.frames[0]?.timestamp ?? 0;
    if (Math.abs(actualDuration - data.header.duration) > 0.1) {
      issues.push({ level: 'warning', code: 'DURATION_MISMATCH', 
                   expected: data.header.duration, actual: actualDuration });
    }
    
    // Check frame rate consistency
    const frameIntervals: number[] = [];
    for (let i = 1; i < data.frames.length; i++) {
      frameIntervals.push(data.frames[i].timestamp - data.frames[i-1].timestamp);
    }
    const avgInterval = frameIntervals.reduce((a, b) => a + b, 0) / frameIntervals.length;
    const variance = frameIntervals.reduce((sum, val) => sum + Math.pow(val - avgInterval, 2), 0) / frameIntervals.length;
    
    if (variance > 0.01) { // High variance in frame timing
      issues.push({ level: 'info', code: 'INCONSISTENT_FRAME_RATE', variance });
    }
    
    return issues;
  }
}
```

### 3. Error Recovery System

**Objective:** Graceful degradation when corruption is detected.

**Implementation:**

```typescript
// src/demo/recovery/DemoRecovery.ts
export class DemoRecovery {
  static recover(data: DemoFile, issues: ValidationIssue[]): RecoveredDemoFile {
    const recovered: RecoveredDemoFile = {
      data,
      skippedFrames: [],
      skippedEvents: [],
      recoveredFrames: 0,
      recoveredEvents: 0
    };
    
    // Skip corrupted frames
    const frameErrors = issues.filter(i => i.code === 'INVALID_POSITION' || i.code === 'INVALID_VELOCITY');
    for (const error of frameErrors) {
      if (error.frame !== undefined) {
        recovered.skippedFrames.push(error.frame);
        recovered.data.frames = recovered.data.frames.filter(f => f.frameNumber !== error.frame);
        recovered.recoveredFrames++;
      }
    }
    
    // Skip corrupted events
    const eventErrors = issues.filter(i => i.code === 'EVENT_OUT_OF_RANGE');
    for (const error of eventErrors) {
      if (error.eventId !== undefined) {
        recovered.skippedEvents.push(error.eventId);
        recovered.data.projectileEvents = recovered.data.projectileEvents.filter(e => e.projectileId !== error.eventId);
        recovered.recoveredEvents++;
      }
    }
    
    // Interpolate missing frames
    recovered.data.frames = this.interpolateFrames(recovered.data.frames);
    
    return recovered;
  }
  
  private static interpolateFrames(frames: DemoFrame[]): DemoFrame[] {
    const result: DemoFrame[] = [];
    let lastValidFrame: DemoFrame | null = null;
    
    for (let i = 0; i < frames.length; i++) {
      const frame = frames[i];
      
      // Detect gaps (frame numbers not sequential)
      if (lastValidFrame && frame.frameNumber > lastValidFrame.frameNumber + 1) {
        const gapSize = frame.frameNumber - lastValidFrame.frameNumber - 1;
        
        // Linear interpolation for missing frames
        for (let j = 1; j <= gapSize; j++) {
          const t = j / (gapSize + 1);
          result.push({
            frameNumber: lastValidFrame.frameNumber + j,
            timestamp: lastValidFrame.timestamp + t * (frame.timestamp - lastValidFrame.timestamp),
            posX: lastValidFrame.posX + t * (frame.posX - lastValidFrame.posX),
            posY: lastValidFrame.posY + t * (frame.posY - lastValidFrame.posY),
            posZ: lastValidFrame.posZ + t * (frame.posZ - lastValidFrame.posZ),
            velX: lastValidFrame.velX + t * (frame.velX - lastValidFrame.velX),
            velY: lastValidFrame.velY + t * (frame.velY - lastValidFrame.velY),
            velZ: lastValidFrame.velZ + t * (frame.velZ - lastValidFrame.velZ),
            yaw: lastValidFrame.yaw + t * (frame.yaw - lastValidFrame.yaw),
            pitch: lastValidFrame.pitch + t * (frame.pitch - lastValidFrame.pitch),
            inputFlags: lastValidFrame.inputFlags,
            mouseDeltaX: 0,
            mouseDeltaY: 0,
            jetpackFlags: lastValidFrame.jetpackFlags,
            jetpackFuel: lastValidFrame.jetpackFuel
          });
        }
      }
      
      result.push(frame);
      lastValidFrame = frame;
    }
    
    return result;
  }
}
```

### 4. Feature Flag System

**Objective:** Enable gradual rollout of new format features.

**Implementation:**

```typescript
// src/demo/features/DemoFeatureFlags.ts
export class DemoFeatureFlags {
  private static flags = new Map<string, boolean>();
  
  static setFlag(name: string, enabled: boolean): void {
    this.flags.set(name, enabled);
  }
  
  static isEnabled(name: string): boolean {
    return this.flags.get(name) ?? false;
  }
  
  static getActiveFeatures(): string[] {
    return Array.from(this.flags.entries())
      .filter(([_, enabled]) => enabled)
      .map(([name, _]) => name);
  }
}

// Example usage
DemoFeatureFlags.setFlag('compression', false);  // V2 feature
DemoFeatureFlags.setFlag('encryption', false);   // V3 feature
DemoFeatureFlags.setFlag('delta_encoding', false); // V4 feature
```

### 5. Migration System

**Objective:** Seamless conversion between format versions.

**Implementation:**

```typescript
// src/demo/migration/DemoMigrator.ts
export class DemoMigrator {
  static migrate(data: DemoFile, fromVersion: number, toVersion: number): DemoFile {
    if (fromVersion === toVersion) return data;
    
    // Step-by-step migration through intermediate versions
    let current = data;
    let currentVersion = fromVersion;
    
    while (currentVersion !== toVersion) {
      const nextVersion = currentVersion < toVersion ? currentVersion + 1 : currentVersion - 1;
      const migrator = DemoFormatRegistry.get(currentVersion)?.migrator;
      
      if (!migrator || !migrator.canMigrateTo(nextVersion)) {
        throw new Error(`Cannot migrate from V${currentVersion} to V${nextVersion}`);
      }
      
      current = migrator.migrate(current, nextVersion);
      currentVersion = nextVersion;
    }
    
    return current;
  }
}

// Example V1 → V2 migrator
export class V1ToV2Migrator implements DemoMigrator {
  canMigrateTo(targetVersion: number): boolean {
    return targetVersion === 2;
  }
  
  migrate(data: DemoFile, targetVersion: number): DemoFile {
    // Add new fields with defaults
    return {
      ...data,
      header: {
        ...data.header,
        formatVersion: targetVersion,
        framesChecksum: this.calculateFramesChecksum(data.frames),
        metadata: {} // New V2 field
      }
    };
  }
  
  private calculateFramesChecksum(frames: DemoFrame[]): number {
    // Additional checksum for frames data
    return 0; // Implementation
  }
}
```

## Refactoring Plan

### High-Complexity Functions

**Priority 1: Player.ts (complexity 85)**
- Break down into smaller functions
- Extract physics logic
- Extract input handling
- Extract state management

**Priority 2: DemoRecorder.ts (complexity 43, 18)**
- Extract frame recording logic
- Extract event recording logic
- Extract buffer management
- Extract validation logic

**Priority 3: DemoPlayer.ts (complexity 18)**
- Extract playback state machine
- Extract frame interpolation
- Extract event synchronization

**Priority 4: DemoManager.ts (nested template literals)**
- Extract string formatting
- Extract error message generation
- Extract status message generation

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)
1. Create format registry system
2. Implement multi-layer validation
3. Add basic error recovery
4. Refactor DemoRecorder (complexity 43 → 15)

### Phase 2: Compatibility (Week 3-4)
1. Implement migration system
2. Add feature flag system
3. Implement forward compatibility
4. Refactor Player.ts (complexity 85 → 20)

### Phase 3: Robustness (Week 5-6)
1. Enhanced error recovery
2. Comprehensive testing
3. Performance optimization
4. Refactor remaining high-complexity functions

### Phase 4: Documentation & Testing (Week 7-8)
1. Format specification document
2. Migration guide
3. Test suite for all versions
4. Performance benchmarks

## Testing Strategy

### Unit Tests
- Format registry
- Validation layers
- Migration functions
- Error recovery

### Integration Tests
- End-to-end recording/playback
- Cross-version compatibility
- Corruption handling
- Performance under load

### Regression Tests
- Existing demo files
- Migration paths
- Edge cases

## Performance Considerations

### Current Performance
- Frame size: ~44 bytes
- Serialization: O(n)
- Validation: O(n)

### Target Performance
- Maintain < 1ms per frame validation
- Migration: < 100ms for typical demo
- Recovery: < 50ms for typical corruption

### Optimization Strategies
- Lazy validation (validate on demand)
- Parallel validation where possible
- Caching validation results
- Incremental checksums

## Security Considerations

### Data Sanitization
- Validate all input ranges
- Prevent buffer overflows
- Sanitize user-provided descriptions

### File Security
- Validate file size limits
- Check for malicious patterns
- Prevent path traversal in filenames

## Monitoring & Observability

### Metrics to Track
- Demo file sizes
- Validation failure rates
- Migration success rates
- Playback performance

### Logging
- Format version distribution
- Common validation errors
- Migration patterns
- Recovery statistics

## Success Criteria

1. **Compatibility**: All existing demos play correctly after format changes
2. **Validation**: 99%+ of corrupted demos detected before playback
3. **Recovery**: 90%+ of corrupted demos recover with <5% data loss
4. **Performance**: Validation adds <10% overhead to playback
5. **Maintainability**: All functions <15 complexity

## Risks & Mitigations

### Risk: Breaking existing demos
- Mitigation: Comprehensive migration testing
- Fallback: Keep V1 reader indefinitely

### Risk: Performance degradation
- Mitigation: Performance benchmarks at each phase
- Fallback: Lazy validation option

### Risk: Complex migration bugs
- Mitigation: Extensive test coverage
- Fallback: Rollback mechanism

## Future Considerations

### Potential Enhancements
- Compression (LZ4, Zstandard)
- Encryption for sensitive demos
- Streaming support for large demos
- Cloud storage integration
- Collaborative editing

### Scalability
- Support for hours-long recordings
- Multi-player demos
- Split-screen demos
- VR demos

## Conclusion

This plan provides a comprehensive roadmap for transforming the demo system into a robust, future-proof platform capable of years of evolution. The phased approach allows for incremental improvements while maintaining backward compatibility and data integrity.
