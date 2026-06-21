# Demo System Integration Guide

## Overview

The demo recording system uses **interface-based integration** to minimize coupling with game systems. Game systems implement simple interfaces to provide data to the demo recorder without direct dependencies.

## Recording Philosophy

**Continuous Recording (Unpredictable):**
- Player movement - Player input is unpredictable, needs frame-by-frame capture
- Camera rotation - Directly tied to player input, unpredictable
- Anything with complex AI or player-driven behavior

**Sparse Recording (Predictable):**
- Projectiles - Physics-based, predictable trajectory (straight line or gravity-affected)
- Bouncy balls/targets - Gravity-bound rigidbodies, predictable between bounces
- Keyframes recorded at moments of indeterminism (bounces, hits, spawns)

**Why this split:**
- Predictable physics can be interpolated between keyframes with perceptual perfection
- Unpredictable player behavior needs continuous capture
- Bounces/contacts are the only moments of indeterminism for physics objects
- Dramatically reduces data size while maintaining accuracy

**Interpolation Accuracy:**
- **Projectiles:** With spawn point (position, rotation, velocity) and hit point, interpolation is mathematically identical to physics simulation for simple rules (straight line or gravity-affected)
- **Targets:** Spawned with rotation and velocity, bounce off terrain. Between bounces, velocity-based interpolation is perceptually perfect. Bounces are keyframes.
- **Timing:** Events are frame-aligned (recorded at Update time). Sub-frame timing is not used since we cannot know what happens between frames in Unity's physics system.
- **Optional enhancement:** Record velocity sign change (upward → downward) as keyframe to capture peak arc position. Not necessary for perceptual accuracy, but provides exact apex for precision needs.

## Architecture

```
Game Systems → Interfaces → Demo Recorder
```

**Benefits:**
- Minimal coupling - demo system doesn't know about game-specific classes
- Easy to add/remove - implement interfaces on existing components
- Testable - can mock data providers for testing
- Flexible - works with any game architecture

## Required Interfaces

### 1. IPlayerDataProvider

Implement this on your player controller to provide player state data.

```csharp
public class PlayerController : MonoBehaviour, IPlayerDataProvider
{
    public Vector3 Position => transform.position;
    public Vector3 Velocity => _rigidbody.linearVelocity;
    public Quaternion Rotation => transform.rotation;
    
    private Rigidbody _rigidbody;
    
    private void Awake()
    {
        _rigidbody = GetComponent<Rigidbody>();
    }
}
```

**Required Data:**
- `Position` - Current world position
- `Velocity` - Current linear velocity
- `Rotation` - Current rotation

### 2. IInputProvider

Implement this on your input handler to provide input state data.

```csharp
public class InputHandler : MonoBehaviour, IInputProvider
{
    private PlayerInput _playerInput;
    private InputAction _moveAction;
    private InputAction _lookAction;
    private InputAction _jumpAction;
    private InputAction _fireAction;
    
    public byte InputFlags
    {
        get
        {
            byte flags = 0;
            
            if (_moveAction != null)
            {
                Vector2 move = _moveAction.ReadValue<Vector2>();
                if (move.y > 0.5f) flags |= (byte)InputFlags.Forward;
                if (move.y < -0.5f) flags |= (byte)InputFlags.Backward;
                if (move.x < -0.5f) flags |= (byte)InputFlags.Left;
                if (move.x > 0.5f) flags |= (byte)InputFlags.Right;
            }
            
            if (_jumpAction != null && _jumpAction.IsPressed())
                flags |= (byte)InputFlags.Jump;
            
            if (_fireAction != null && _fireAction.IsPressed())
                flags |= (byte)InputFlags.Fire;
            
            return flags;
        }
    }
    
    public float MouseDeltaX
    {
        get
        {
            if (_lookAction != null)
            {
                Vector2 look = _lookAction.ReadValue<Vector2>();
                return look.x * 100f;
            }
            return 0f;
        }
    }
    
    public float MouseDeltaY
    {
        get
        {
            if (_lookAction != null)
            {
                Vector2 look = _lookAction.ReadValue<Vector2>();
                return look.y * 100f;
            }
            return 0f;
        }
    }
    
    public byte JetpackFlags
    {
        get
        {
            // TODO: Implement based on your jetpack system
            return 0;
        }
    }
    
    public float JetpackFuel
    {
        get
        {
            // TODO: Return actual fuel level from jetpack system
            return 0f;
        }
    }
}
```

**Required Data:**
- `InputFlags` - Bitmask of input state (Forward, Backward, Left, Right, Jump, Fire, etc.)
- `MouseDeltaX` - Mouse movement X
- `MouseDeltaY` - Mouse movement Y
- `JetpackFlags` - Jetpack state bitmask
- `JetpackFuel` - Current fuel level

### 3. IProjectileEventSource

Call these methods from your projectile system to record events.

```csharp
public class ProjectileController : MonoBehaviour
{
    private IProjectileEventSource _demoRecorder;
    
    private void Awake()
    {
        _demoRecorder = FindAnyObjectByType<DemoRecorder>();
    }
    
    private void OnFire(Vector3 position, Vector3 velocity, byte weaponType)
    {
        _demoRecorder?.RecordProjectileFired(position, velocity, weaponType);
    }
    
    private void OnBounce(Vector3 position, Vector3 velocity, Vector3 normal)
    {
        _demoRecorder?.RecordProjectileBounce(_id, position, velocity, normal);
    }
    
    private void OnHit(Vector3 position, ushort targetId)
    {
        _demoRecorder?.RecordProjectileHit(_id, position, targetId);
    }
    
    private void OnDestroy()
    {
        _demoRecorder?.RecordProjectileDestroyed(_id, transform.position);
    }
}
```

**Methods to Call:**
- `RecordProjectileFired` - When projectile is fired
- `RecordProjectileBounce` - When projectile bounces
- `RecordProjectileHit` - When projectile hits target
- `RecordProjectileDestroyed` - When projectile is destroyed

### 4. ITargetEventSource

Call these methods from your target/ball system to record events.

```csharp
public class TargetController : MonoBehaviour
{
    private ITargetEventSource _demoRecorder;
    private ushort _id;
    
    private void Awake()
    {
        _demoRecorder = FindAnyObjectByType<DemoRecorder>();
        _id = GetUniqueId(); // Your ID assignment logic
    }
    
    private void OnSpawn()
    {
        _demoRecorder?.RecordTargetSpawned(_id, transform.position, _rigidbody.linearVelocity, _type);
    }
    
    private void OnBounce()
    {
        _demoRecorder?.RecordTargetBounce(_id, transform.position, _rigidbody.linearVelocity);
    }
    
    private void OnHit(float health)
    {
        _demoRecorder?.RecordTargetHit(_id, transform.position, health);
    }
    
    private void OnDestroy()
    {
        _demoRecorder?.RecordTargetDestroyed(_id, transform.position);
    }
    
    private void OnStateChanged(byte newState)
    {
        _demoRecorder?.RecordTargetStateChanged(_id, newState);
    }
}
```

**Methods to Call:**
- `RecordTargetSpawned` - When target spawns
- `RecordTargetBounce` - When target bounces
- `RecordTargetHit` - When target is hit
- `RecordTargetDestroyed` - When target is destroyed
- `RecordTargetStateChanged` - When target state changes

## Integration Steps

### Step 1: Implement Data Providers

Add interfaces to your existing components:

```csharp
// On your player controller
public class PlayerController : MonoBehaviour, IPlayerDataProvider
{
    // Implement properties
}

// On your input handler
public class InputHandler : MonoBehaviour, IInputProvider
{
    // Implement properties
}
```

### Step 2: Add Event Calls

Add demo recording calls to your existing event handlers:

```csharp
// In projectile system
private void Fire()
{
    // Existing fire logic
    FireProjectile();
    
    // Add demo recording
    _demoRecorder?.RecordProjectileFired(position, velocity, weaponType);
}
```

### Step 3: Verify Integration

1. Add `DemoRecorder` component to scene
2. Set `Auto Record` to true or call `StartRecording()` manually
3. Play game and verify recording works
4. Check demo files in `Application.persistentDataPath/DEMO/`

## Optional Integration

### Cool Hit Detection

The demo system can automatically detect "cool hits" and extract clips. To enable:

```csharp
// Add CoolHitDetector component to scene
// Configure thresholds in inspector:
// - Long range distance
// - High velocity threshold
// - Prediction threshold
// - Minimum bounces
```

### Demo UI

Add `DemoUI` component with `UIDocument` reference for in-game controls.

## Troubleshooting

**No data being recorded:**
- Verify interfaces are implemented correctly
- Check that components implementing interfaces are in scene
- Ensure `DemoRecorder` is active and recording

**Missing player data:**
- Verify `IPlayerDataProvider` is implemented
- Check that component is active
- Ensure transform and rigidbody are available

**Missing input data:**
- Verify `IInputProvider` is implemented
- Check Input System setup
- Ensure actions are properly configured

**No projectile events:**
- Verify `IProjectileEventSource` calls are added
- Check that `_demoRecorder` reference is not null
- Ensure recording is active when events occur

## Best Practices

1. **Null checks** - Always check for null before calling demo methods
2. **Performance** - Demo recording has minimal overhead, but still consider impact
3. **Cleanup** - Remove demo recording calls in production builds if not needed
4. **Testing** - Test with and without demo system active
5. **Versioning** - Keep interface versions in sync if changing data structures

## Example Complete Integration

```csharp
// PlayerController.cs
public class PlayerController : MonoBehaviour, IPlayerDataProvider
{
    public Vector3 Position => transform.position;
    public Vector3 Velocity => _rb.linearVelocity;
    public Quaternion Rotation => transform.rotation;
    
    private Rigidbody _rb;
    
    private void Awake() => _rb = GetComponent<Rigidbody>();
}

// InputHandler.cs
public class InputHandler : MonoBehaviour, IInputProvider
{
    public byte InputFlags => CalculateInputFlags();
    public float MouseDeltaX => _lookAction.ReadValue<Vector2>().x * 100f;
    public float MouseDeltaY => _lookAction.ReadValue<Vector2>().y * 100f;
    public byte JetpackFlags => _jetpackSystem.Flags;
    public float JetpackFuel => _jetpackSystem.Fuel;
    
    private byte CalculateInputFlags()
    {
        // Your input flag logic
        return 0;
    }
}

// ProjectileController.cs
public class ProjectileController : MonoBehaviour
{
    private IProjectileEventSource _demoRecorder;
    
    private void Awake()
    {
        _demoRecorder = FindAnyObjectByType<DemoRecorder>();
    }
    
    public void Fire(Vector3 pos, Vector3 vel, byte weapon)
    {
        _demoRecorder?.RecordProjectileFired(pos, vel, weapon);
    }
}
```
