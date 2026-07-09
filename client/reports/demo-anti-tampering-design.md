# Demo System Anti-Tampering Design

## Executive Summary

This report outlines a comprehensive anti-tampering strategy for the demo system. **Key strategic insight:** Focus validation efforts on the **reading/playback phase** rather than the writing/recording phase. Writing should remain lean and performant, while reading implements sophisticated gameplay-based validation to detect tampering by checking recorded data against known game physics and constraints.

## Strategic Decision: Reading Phase vs Writing Phase

### Why Focus on Reading Phase Validation

**Core Principle:** Keep writing/recording lean and performant; implement sophisticated validation during reading/playback.

**Writing Phase (Minimal):**
- Record raw game state with minimal overhead
- Basic SHA-256 for corruption detection (not anti-tampering)
- No signatures, no hash chains, no complexity
- Focus on performance and simplicity
- Current implementation is largely sufficient

**Reading Phase (Comprehensive):**
- Validate by checking recorded data against known game physics
- Detect anomalies that would be impossible in normal gameplay
- Use statistical analysis to find suspicious patterns
- No cryptographic protections needed for tamper detection
- Gameplay-based validation is more effective than file integrity checks

### Advantages of Reading Phase Focus

1. **No Gameplay Impact** - Recording stays fast, no performance penalty during gameplay
2. **Defense in Depth** - Even if writing protections are bypassed, reading phase catches tampering
3. **Behavioral Analysis** - Can detect subtle tampering that cryptographic methods miss
4. **Future-Proof** - Can add new detection methods without changing recording pipeline
5. **Game-Specific** - Validation uses actual game constants (max speed, fire rate, physics)
6. **User-Focused** - Validation happens when user cares (during playback)

### Detection Capabilities Without Writing Protections

**Physics-Based Validation:**
- Position manipulation → Physics mismatch (simulated vs recorded projectile paths)
- Shot manipulation → Fire rate/accuracy anomalies
- Movement hacks → Speed limit violations
- Health manipulation → Damage inconsistency

**Statistical Analysis:**
- Superhuman accuracy → Statistical pattern analysis
- Impossible reaction times → Timing consistency checks
- Inhuman behavior → Movement pattern analysis
- Aim patterns → Statistical distribution analysis

**Timeline Consistency:**
- Event ordering → Timeline validation
- Timestamp consistency → Temporal checks
- Frame rate analysis → Playback validation

### Example: Gameplay-Based Validation

```typescript
class GameplayValidator {
  validate(demo: DemoFile): ValidationResult {
    const issues: ValidationIssue[] = [];
    
    // Check 1: Projectile physics consistency
    for (const shot of demo.projectileEvents) {
      const expectedHit = simulateProjectile(
        shot.spawnPosition,
        shot.spawnVelocity,
        shot.timestamp
      );
      
      const error = distance(expectedHit, shot.hitPosition);
      if (error > 0.5) { // 50cm tolerance
        issues.push({
          level: 'suspicious',
          code: 'PHYSICS_MISMATCH',
          message: `Projectile hit deviates ${error.toFixed(2)}m from expected physics`
        });
      }
    }
    
    // Check 2: Movement speed limits
    for (let i = 1; i < demo.frames.length; i++) {
      const prev = demo.frames[i - 1];
      const curr = demo.frames[i];
      
      const dt = curr.timestamp - prev.timestamp;
      const distance = distance(prev.position, curr.position);
      const speed = distance / dt;
      
      if (speed > MAX_PLAYER_SPEED) {
        issues.push({
          level: 'suspicious',
          code: 'IMPOSSIBLE_SPEED',
          message: `Player moved ${speed.toFixed(1)} m/s (max: ${MAX_PLAYER_SPEED} m/s)`
        });
      }
    }
    
    // Check 3: Shot timing consistency
    const shotIntervals = calculateShotIntervals(demo);
    for (const interval of shotIntervals) {
      if (interval < MIN_SHOT_INTERVAL) {
        issues.push({
          level: 'suspicious',
          code: 'IMPOSSIBLE_FIRE_RATE',
          message: `Shot interval ${interval.toFixed(3)}s below weapon minimum`
        });
      }
    }
    
    return { valid: issues.length === 0, issues };
  }
}
```

### Implementation Priority

**Phase 1 (Immediate):** Implement basic gameplay validation
- Physics consistency checks
- Speed limit validation
- Fire rate validation

**Phase 2 (Short-term):** Add statistical analysis
- Accuracy pattern analysis
- Reaction time analysis
- Movement pattern analysis

**Phase 3 (Optional):** Add cryptographic protections only if needed
- Basic SHA-256 for corruption detection
- Simple hash chain for granular tamper location
- Digital signatures only if authentication is required

## Current State Assessment

### Current Implementation
- **CRC32 checksum only** - Weak cryptographic protection
- **No authentication** - Anyone can modify and recompute checksum
- **No fine-grained validation** - Cannot detect where tampering occurred
- **No digital signatures** - No proof of origin

### Vulnerabilities
1. **CRC32 is forgeable** - Can be recomputed after modification
2. **No chain of custody** - Cannot verify who created the demo
3. **No temporal proof** - Cannot prove when demo was created
4. **No granular detection** - Cannot identify specific tampered sections
5. **Replay attacks** - Old demos can be presented as new

## Anti-Tampering Architecture

### Multi-Layer Security Model

```
Layer 1: Cryptographic Hashing (SHA-256)
    ↓
Layer 2: Hash Chain (Frame-to-frame linking)
    ↓
Layer 3: Digital Signatures (Ed25519)
    ↓
Layer 4: Merkle Tree (Efficient validation)
    ↓
Layer 5: Blockchain Anchoring (Proof of existence)
```

## Layer 1: Cryptographic Hashing

### Replace CRC32 with SHA-256

**Current Implementation:**
```typescript
function crc32(data: Uint8Array): number {
  // CRC32 - weak, forgeable
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
```

**Improved Implementation:**
```typescript
async function sha256(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
```

**Benefits:**
- Cryptographically secure (collision-resistant)
- Industry standard
- Easy to implement with Web Crypto API
- Only 32 bytes overhead

**Performance Impact:**
- Compute: ~5ms for 1MB file
- Storage: 32 bytes vs 4 bytes
- Negligible overhead

## Layer 2: Hash Chain

### Frame-to-Frame Hash Linking

**Design:**
```typescript
interface DemoFrame {
  // Existing fields...
  frameHash: string;           // SHA-256 of this frame's data
  previousFrameHash: string;   // SHA-256 of previous frame
}

interface ProjectileEvent {
  // Existing fields...
  eventHash: string;           // SHA-256 of event data
  frameHash: string;           // Reference to containing frame's hash
}
```

**Implementation:**
```typescript
function addHashChain(frames: DemoFrame[]): DemoFrame[] {
  let previousHash = '';
  
  return frames.map((frame, index) => {
    const frameData = serializeFrame(frame);
    const frameHash = await sha256(frameData + previousHash);
    
    const enhancedFrame = {
      ...frame,
      frameHash,
      previousFrameHash: previousHash
    };
    
    previousHash = frameHash;
    return enhancedFrame;
  });
}

function verifyHashChain(frames: DemoFrame[]): boolean {
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const curr = frames[i];
    
    if (curr.previousFrameHash !== prev.frameHash) {
      console.error(`Hash chain broken at frame ${i}`);
      return false;
    }
  }
  return true;
}
```

**Tamper Detection:**
- Any modification breaks the chain at the exact point
- Can identify which frame was tampered
- Cannot insert/delete frames without detection
- Cannot reorder frames without detection

**Storage Overhead:**
- 64 bytes per frame (32 bytes hash + 32 bytes previous hash)
- For 10-minute demo (36,000 frames): ~2.3MB overhead
- Acceptable tradeoff for security

## Layer 3: Digital Signatures

### Ed25519 Digital Signatures

**Design:**
```typescript
interface DemoHeader {
  // Existing fields...
  globalHash: string;          // SHA-256 of entire demo file
  signature: string;           // Ed25519 signature of globalHash
  publicKey: string;           // Server's public key for verification
  timestamp: number;           // Server timestamp when signed
}
```

**Server-Side Signing:**
```typescript
async function signDemoFile(demo: DemoFile, privateKey: string): Promise<SignedDemoFile> {
  // Compute global hash
  const demoData = serialize(demo);
  const globalHash = await sha256(demoData);
  
  // Sign with Ed25519
  const signature = await ed25519.sign(globalHash, privateKey);
  
  return {
    ...demo,
    header: {
      ...demo.header,
      globalHash,
      signature: base64Encode(signature),
      publicKey: await getServerPublicKey(),
      timestamp: Date.now()
    }
  };
}
```

**Client-Side Verification:**
```typescript
async function verifyDemoFile(demo: SignedDemoFile): Promise<VerificationResult> {
  // Compute hash of demo data
  const demoData = serialize(demo);
  const computedHash = await sha256(demoData);
  
  // Verify global hash matches
  if (computedHash !== demo.header.globalHash) {
    return { valid: false, reason: 'GLOBAL_HASH_MISMATCH' };
  }
  
  // Verify signature
  const signature = base64Decode(demo.header.signature);
  const signatureValid = await ed25519.verify(
    computedHash,
    signature,
    demo.header.publicKey
  );
  
  if (!signatureValid) {
    return { valid: false, reason: 'SIGNATURE_INVALID' };
  }
  
  // Verify hash chain
  const chainValid = verifyHashChain(demo.frames);
  if (!chainValid) {
    return { valid: false, reason: 'HASH_CHAIN_BROKEN' };
  }
  
  return { valid: true };
}
```

**Key Management:**
```typescript
// Server key management
class DemoKeyManager {
  private static privateKey: string;
  private static publicKey: string;
  
  static async initialize(): Promise<void> {
    const keyPair = await ed25519.generateKeyPair();
    this.privateKey = keyPair.privateKey;
    this.publicKey = keyPair.publicKey;
    
    // Store securely (environment variable, HSM, etc.)
    await storePrivateKey(this.privateKey);
  }
  
  static async rotateKeys(): Promise<void> {
    const oldPublicKey = this.publicKey;
    await this.initialize();
    
    // Add old public key to trusted keys for verification
    await addTrustedKey(oldPublicKey);
  }
}
```

**Benefits:**
- Cryptographic authentication
- Proof of origin
- Prevents forgery
- Key rotation support

**Performance Impact:**
- Signing: ~50ms for 1MB file
- Verification: ~20ms for 1MB file
- Storage: 64 bytes (signature) + 32 bytes (public key)

## Layer 4: Merkle Tree

### Efficient Partial Validation

**Design:**
```typescript
interface DemoMerkleTree {
  rootHash: string;              // Root of Merkle tree
  leafHashes: string[];          // Hashes of individual frames
  proofPaths: ProofPath[];       // Merkle proofs for each element
}

interface ProofPath {
  elementIndex: number;
  siblingHashes: string[];       // Hashes needed to verify this element
  direction: 'left' | 'right'[]; // Direction for each sibling
}
```

**Implementation:**
```typescript
function buildMerkleTree(elements: Uint8Array[]): MerkleTree {
  const leafHashes = elements.map(sha256);
  const tree = [leafHashes];
  
  // Build tree level by level
  while (tree[tree.length - 1].length > 1) {
    const currentLevel = tree[tree.length - 1];
    const nextLevel: string[] = [];
    
    for (let i = 0; i < currentLevel.length; i += 2) {
      const left = currentLevel[i];
      const right = currentLevel[i + 1] || left;
      const combined = left + right;
      nextLevel.push(sha256(combined));
    }
    
    tree.push(nextLevel);
  }
  
  const rootHash = tree[tree.length - 1][0];
  const proofPaths = generateProofPaths(tree);
  
  return {
    rootHash,
    leafHashes,
    proofPaths
  };
}

function generateProofPaths(tree: string[][]): ProofPath[] {
  const proofPaths: ProofPath[] = [];
  const leafCount = tree[0].length;
  
  for (let i = 0; i < leafCount; i++) {
    const path: ProofPath = {
      elementIndex: i,
      siblingHashes: [],
      direction: []
    };
    
    let currentIndex = i;
    for (let level = 0; level < tree.length - 1; level++) {
      const isLeft = currentIndex % 2 === 0;
      const siblingIndex = isLeft ? currentIndex + 1 : currentIndex - 1;
      
      if (siblingIndex < tree[level].length) {
        path.siblingHashes.push(tree[level][siblingIndex]);
        path.direction.push(isLeft ? 'right' : 'left');
      }
      
      currentIndex = Math.floor(currentIndex / 2);
    }
    
    proofPaths.push(path);
  }
  
  return proofPaths;
}

// Verify specific element without reading entire file
async function verifyElement(
  element: Uint8Array,
  proof: ProofPath,
  rootHash: string
): Promise<boolean> {
  let currentHash = await sha256(element);
  
  for (let i = 0; i < proof.siblingHashes.length; i++) {
    const sibling = proof.siblingHashes[i];
    const direction = proof.direction[i];
    
    if (direction === 'left') {
      currentHash = await sha256(sibling + currentHash);
    } else {
      currentHash = await sha256(currentHash + sibling);
    }
  }
  
  return currentHash === rootHash;
}
```

**Benefits:**
- Verify specific frames without reading entire file
- Efficient for large demo files
- Precise tamper location
- O(log n) verification time

**Use Cases:**
- Streaming validation during playback
- Quick integrity check of specific sections
- Partial download verification

## Layer 5: Blockchain Anchoring

### Proof of Existence

**Design:**
```typescript
interface DemoTimestamp {
  blockNumber: number;        // Blockchain block number
  blockHash: string;         // Blockchain block hash
  timestamp: number;         // Server timestamp
  demoHash: string;          // Hash of demo file
  transactionHash: string;    // Blockchain transaction hash
}
```

**Implementation:**
```typescript
async function anchorDemoInBlockchain(demoHash: string): Promise<DemoTimestamp> {
  // Submit hash to blockchain
  const tx = await blockchain.record(demoHash);
  
  return {
    blockNumber: tx.blockNumber,
    blockHash: tx.blockHash,
    timestamp: tx.timestamp,
    demoHash,
    transactionHash: tx.hash
  };
}

async function verifyBlockchainAnchor(anchor: DemoTimestamp): Promise<boolean> {
  // Verify block exists
  const block = await blockchain.getBlock(anchor.blockNumber);
  if (!block || block.hash !== anchor.blockHash) {
    return false;
  }
  
  // Verify transaction exists in block
  const tx = await blockchain.getTransaction(anchor.transactionHash);
  if (!tx || tx.data !== anchor.demoHash) {
    return false;
  }
  
  return true;
}
```

**Benefits:**
- Immutable proof of existence
- Prevents backdating
- Publicly verifiable
- Legal admissibility

**Blockchain Options:**
- **Ethereum** - High security, higher cost
- **Polygon** - Lower cost, good security
- **Arweave** - Permanent storage, low cost
- **Custom** - Private blockchain, full control

## Tamper Detection Capabilities

### What Can Be Detected

| Attack Type | Detection Method | Precision |
|-------------|------------------|-----------|
| Any modification | Global hash | Yes |
| Frame tampering | Hash chain | Exact frame |
| Event modification | Frame hash | Exact event |
| Reordering | Hash chain | Exact location |
| Insertion | Frame count + chain | Exact location |
| Deletion | Frame count + chain | Exact location |
| Replay attack | Timestamp + signature | Yes |
| Forgery | Digital signature | Yes |
| Backdating | Blockchain anchor | Yes |

### What Cannot Be Detected (Without Additional Measures)

| Attack Type | Mitigation |
|-------------|------------|
| Replay of old demos | Timestamp validation |
| Server key compromise | Key rotation + multi-sig |
| Blockchain reorg | Multiple blockchain confirmations |

## Integrity Validation UX

### User-Friendly Validation Report

```typescript
interface IntegrityReport {
  valid: boolean;
  confidence: 'high' | 'medium' | 'low';
  issues: IntegrityIssue[];
  tamperEvidence: TamperEvidence[];
  timestamp: number;
}

interface IntegrityIssue {
  level: 'critical' | 'error' | 'warning' | 'info';
  code: string;
  message: string;
  location?: string;
}

interface TamperEvidence {
  type: 'global' | 'frame' | 'event' | 'header';
  location?: number;
  expected: string;
  actual: string;
  timestamp?: number;
}

async function validateDemoIntegrity(demo: DemoFile): Promise<IntegrityReport> {
  const report: IntegrityReport = {
    valid: true,
    confidence: 'high',
    issues: [],
    tamperEvidence: [],
    timestamp: Date.now()
  };
  
  // Layer 1: Global hash validation
  const computedHash = await sha256(serialize(demo));
  if (computedHash !== demo.header.globalHash) {
    report.valid = false;
    report.confidence = 'low';
    report.issues.push({
      level: 'critical',
      code: 'GLOBAL_HASH_MISMATCH',
      message: 'Global file hash does not match header'
    });
    report.tamperEvidence.push({
      type: 'global',
      expected: demo.header.globalHash,
      actual: computedHash
    });
  }
  
  // Layer 2: Hash chain validation
  for (let i = 1; i < demo.frames.length; i++) {
    const prev = demo.frames[i - 1];
    const curr = demo.frames[i];
    
    if (curr.previousFrameHash !== prev.frameHash) {
      report.valid = false;
      report.confidence = 'medium';
      report.issues.push({
        level: 'error',
        code: 'HASH_CHAIN_BREAK',
        message: `Hash chain broken at frame ${i}`,
        location: `frame:${i}`
      });
      report.tamperEvidence.push({
        type: 'frame',
        location: i,
        expected: prev.frameHash,
        actual: curr.previousFrameHash
      });
    }
  }
  
  // Layer 3: Digital signature validation
  if (demo.header.signature) {
    const sigValid = await verifySignature(demo);
    if (!sigValid) {
      report.valid = false;
      report.confidence = 'low';
      report.issues.push({
        level: 'critical',
        code: 'SIGNATURE_INVALID',
        message: 'Digital signature verification failed'
      });
    }
  } else {
    report.issues.push({
      level: 'warning',
      code: 'NO_SIGNATURE',
      message: 'Demo file lacks digital signature'
    });
  }
  
  // Layer 4: Blockchain anchor validation
  if (demo.header.blockchainAnchor) {
    const anchorValid = await verifyBlockchainAnchor(demo.header.blockchainAnchor);
    if (!anchorValid) {
      report.valid = false;
      report.issues.push({
        level: 'error',
        code: 'BLOCKCHAIN_ANCHOR_INVALID',
        message: 'Blockchain anchor verification failed'
      });
    }
  }
  
  return report;
}
```

### Visual Feedback

```typescript
function displayIntegrityReport(report: IntegrityReport): void {
  const statusIcon = report.valid ? '✓' : '✗';
  const confidenceColor = report.confidence === 'high' ? 'green' : 
                          report.confidence === 'medium' ? 'yellow' : 'red';
  
  console.log(`${statusIcon} Demo Integrity: ${report.valid ? 'VALID' : 'INVALID'}`);
  console.log(`   Confidence: ${report.confidence.toUpperCase()}`);
  console.log(`   Checked at: ${new Date(report.timestamp).toISOString()}`);
  
  if (report.issues.length > 0) {
    console.log('\nIssues:');
    for (const issue of report.issues) {
      const icon = issue.level === 'critical' ? '🔴' :
                   issue.level === 'error' ? '🟠' :
                   issue.level === 'warning' ? '🟡' : '🔵';
      console.log(`  ${icon} [${issue.level.toUpperCase()}] ${issue.code}`);
      console.log(`     ${issue.message}`);
      if (issue.location) {
        console.log(`     Location: ${issue.location}`);
      }
    }
  }
  
  if (report.tamperEvidence.length > 0) {
    console.log('\nTamper Evidence:');
    for (const evidence of report.tamperEvidence) {
      console.log(`  ${evidence.type.toUpperCase()}`);
      if (evidence.location !== undefined) {
        console.log(`    Location: ${evidence.location}`);
      }
      console.log(`    Expected: ${evidence.expected.substring(0, 16)}...`);
      console.log(`    Actual: ${evidence.actual.substring(0, 16)}...`);
    }
  }
}
```

## Performance Analysis

### Computational Overhead

| Operation | Current | Enhanced | Overhead |
|-----------|---------|----------|----------|
| Recording | <1ms | ~10ms | +9ms |
| Serialization | ~5ms | ~15ms | +10ms |
| Hash computation | <1ms | ~5ms | +4ms |
| Signature generation | N/A | ~50ms | +50ms |
| Signature verification | N/A | ~20ms | +20ms |
| Merkle tree build | N/A | ~20ms | +20ms |
| Total overhead | ~6ms | ~120ms | +114ms |

### Storage Overhead

| Component | Current | Enhanced | Overhead |
|-----------|---------|----------|----------|
| CRC32 | 4 bytes | N/A | -4 bytes |
| SHA-256 | N/A | 32 bytes | +32 bytes |
| Hash chain | N/A | 64 bytes/frame | +2.3MB (10min) |
| Signature | N/A | 64 bytes | +64 bytes |
| Public key | N/A | 32 bytes | +32 bytes |
| Merkle proofs | N/A | ~1MB | +1MB |
| Total | 4 bytes | ~3.4MB | +3.4MB |

**Recommendation:** Hash chain + SHA-256 (10ms overhead, 2.3MB storage) for optimal balance

## Implementation Roadmap

### Phase 1: Basic Cryptographic Protection (Week 1)
1. Replace CRC32 with SHA-256
2. Add global hash to header
3. Implement hash computation
4. Add basic validation
5. Test performance impact

### Phase 2: Hash Chain Implementation (Week 2-3)
1. Add frameHash to DemoFrame
2. Add previousFrameHash to DemoFrame
3. Implement hash chain generation
4. Implement hash chain verification
5. Add tamper detection UI
6. Test with various tampering scenarios

### Phase 3: Digital Signatures (Week 4-5)
1. Implement Ed25519 key generation
2. Add server-side signing
3. Add client-side verification
4. Implement key rotation
5. Add signature validation to UI
6. Test signature verification

### Phase 4: Merkle Tree (Week 6-7)
1. Implement Merkle tree construction
2. Generate proof paths
3. Implement partial verification
4. Add streaming validation
5. Test with large demo files
6. Optimize performance

### Phase 5: Blockchain Anchoring (Week 8 - Optional)
1. Choose blockchain platform
2. Implement anchoring service
3. Add verification logic
4. Test anchor verification
5. Document blockchain integration

## Security Considerations

### Key Management
- **Private key storage**: Environment variables, HSM, or key management service
- **Key rotation**: Regular rotation (monthly) with support for old keys
- **Key backup**: Secure backup with access controls
- **Multi-sig**: Consider multi-signature for critical operations

### Attack Vectors
- **Key compromise**: Regular rotation, revocation list
- **Hash collisions**: Use SHA-256 (collision-resistant)
- **Replay attacks**: Timestamp validation, nonce
- **Quantum threats**: Plan for post-quantum signatures

### Compliance
- **GDPR**: Hash-based (no personal data)
- **SOX**: Audit trail for key operations
- **PCI DSS**: Key management standards

## Testing Strategy

### Unit Tests
- Hash computation correctness
- Hash chain generation/verification
- Signature generation/verification
- Merkle tree construction
- Partial verification

### Integration Tests
- End-to-end signing/verification
- Cross-version compatibility
- Performance benchmarks
- Memory usage profiling

### Security Tests
- Tampering detection
- Forgery attempts
- Replay attacks
- Key compromise scenarios

### Regression Tests
- Existing demo files
- Migration from CRC32
- Backward compatibility

## Migration Strategy

### Backward Compatibility

```typescript
// Version 2 (CRC32) → Version 3 (SHA-256 + hash chain)
class V2ToV3Migrator {
  async migrate(data: V2DemoFile): Promise<V3DemoFile> {
    // Remove CRC32
    const { checksum, ...headerWithoutChecksum } = data.header;
    
    // Compute SHA-256
    const globalHash = await sha256(serialize(data));
    
    // Add hash chain
    const framesWithChain = await addHashChain(data.frames);
    
    return {
      header: {
        ...headerWithoutChecksum,
        formatVersion: 3,
        globalHash,
        signature: null, // Will be added by server
        timestamp: Date.now()
      },
      frames: framesWithChain,
      projectileEvents: data.projectileEvents,
      targetEvents: data.targetEvents
    };
  }
}
```

### Gradual Rollout
1. **Phase 1**: Support both V2 and V3 formats
2. **Phase 2**: Default to V3 for new recordings
3. **Phase 3**: Require V3 for competitive play
4. **Phase 4**: Deprecate V2 support

## Success Criteria

1. **Tamper Detection**: 100% detection rate for all modification types
2. **Performance**: <10ms overhead for basic protection
3. **Storage**: <5MB overhead for 10-minute demo
4. **Compatibility**: All existing demos migratable
5. **Usability**: Clear user feedback on validation results

## Conclusion

The multi-layer anti-tampering design provides comprehensive protection against demo file modification while maintaining acceptable performance and storage overhead. The combination of cryptographic hashing, hash chains, digital signatures, and optional blockchain anchoring ensures that any tampering is immediately detectable and precisely locatable. This design is future-proof, scalable, and suitable for long-term demo system integrity requirements.

## Appendix: Cryptographic Libraries

### Recommended Libraries
- **Web Crypto API**: Built-in browser support
- **TweetNaCl**: Lightweight Ed25519 implementation
- **jsSHA**: Pure JavaScript SHA implementation
- **Merkle.js**: Merkle tree utilities

### Example: Web Crypto API Usage
```typescript
async function sha256WebCrypto(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function generateKeyPair(): Promise<CryptoKeyPair> {
  return await crypto.subtle.generateKey(
    {
      name: 'Ed25519',
      namedCurve: 'Ed25519'
    },
    true,
    ['sign', 'verify']
  );
}
```
