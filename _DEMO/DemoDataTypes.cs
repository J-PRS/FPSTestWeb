using UnityEngine;
using System;

namespace DEMO
{
    /// <summary>
    /// Core data structures for the hybrid event-driven demo recording system.
    /// Designed for minimal memory footprint and efficient serialization.
    /// </summary>

    /// <summary>
    /// Single frame of player data (position, velocity, inputs).
    /// ~32 bytes per frame for efficient recording.
    /// </summary>
    [Serializable]
    public struct DemoFrame
    {
        public ushort frameNumber;
        public float timestamp;

        // Player state
        public Vector3 position;
        public Vector3 velocity;
        public Quaternion rotation;

        // Input state (bitmask for efficiency)
        public byte inputFlags;
        public short mouseDeltaX;
        public short mouseDeltaY;

        // Jetpack state
        public byte jetpackFlags;
        public float jetpackFuel;

        public static int Size => sizeof(ushort) + sizeof(float) +
                                   sizeof(float) * 3 + sizeof(float) * 3 + sizeof(float) * 4 +
                                   sizeof(byte) + sizeof(short) * 2 +
                                   sizeof(byte) + sizeof(float);
    }

    /// <summary>
    /// Event types for projectile keyframe recording.
    /// </summary>
    public enum ProjectileEventType : byte
    {
        Fired = 0,
        Bounce = 1,
        Hit = 2,
        Destroyed = 3
    }

    /// <summary>
    /// Keyframe event for projectiles (fire, bounce, hit).
    /// Only records critical moments for efficient storage.
    /// Supports keyframe interpolation for perceptually perfect replay.
    /// </summary>
    [Serializable]
    public struct ProjectileEvent
    {
        public ProjectileEventType eventType;
        public float timestamp;

        // Projectile state
        public Vector3 position;
        public Vector3 velocity;
        public ushort projectileId;
        public byte weaponType;

        // Bounce-specific data
        public Vector3 surfaceNormal;

        // Hit-specific data
        public ushort targetId;

        // Optional: Peak arc position (when velocity.y changes sign)
        public bool hasPeakPosition;
        public Vector3 peakPosition;

        public static int Size => sizeof(byte) + sizeof(float) +
                                   sizeof(float) * 3 + sizeof(float) * 3 +
                                   sizeof(ushort) + sizeof(byte) +
                                   sizeof(float) * 3 + sizeof(ushort) +
                                   sizeof(bool) + sizeof(float) * 3;
    }

    /// <summary>
    /// Event types for target/ball recording.
    /// </summary>
    public enum TargetEventType : byte
    {
        Spawned = 0,
        Bounce = 1,
        Hit = 2,
        Destroyed = 3,
        StateChanged = 4
    }

    /// <summary>
    /// Keyframe event for targets/balls.
    /// Records position/velocity on critical events only.
    /// Supports keyframe interpolation for perceptually perfect replay.
    /// </summary>
    [Serializable]
    public struct TargetEvent
    {
        public TargetEventType eventType;
        public float timestamp;

        // Target state
        public Vector3 position;
        public Vector3 velocity;
        public ushort targetId;
        public byte targetType;

        // Health/state
        public float health;

        // Optional: Peak arc position (when velocity.y changes sign)
        public bool hasPeakPosition;
        public Vector3 peakPosition;

        public static int Size => sizeof(byte) + sizeof(float) +
                                   sizeof(float) * 3 + sizeof(float) * 3 +
                                   sizeof(ushort) + sizeof(byte) + sizeof(float) +
                                   sizeof(bool) + sizeof(float) * 3;
    }

    /// <summary>
    /// Demo file header with metadata.
    /// </summary>
    [Serializable]
    public struct DemoHeader
    {
        public int formatVersion;       // Demo format version (for compatibility)
        public string gameVersion;       // Game version
        public float duration;           // Total duration in seconds
        public uint totalFrames;         // Total number of frames (uint for larger capacity)
        public uint projectileEvents;    // Number of projectile events
        public uint targetEvents;        // Number of target events
        public Vector3 playerStartPosition;
        public Quaternion playerStartRotation;
        public Vector3 playerStartVelocity;
        public string description;       // Optional description
        public uint checksum;            // CRC32 checksum for integrity
        public long timestamp;           // Unix timestamp when recorded
    }

    /// <summary>
    /// Complete demo file structure.
    /// </summary>
    [Serializable]
    public class DemoFile
    {
        public DemoHeader header;
        public DemoFrame[] frames;
        public ProjectileEvent[] projectileEvents;
        public TargetEvent[] targetEvents;

        // Initial state for replay
        public Vector3 playerStartPosition;
        public Quaternion playerStartRotation;
        public Vector3 playerStartVelocity;

        public DemoFile()
        {
            header = new DemoHeader();
            frames = new DemoFrame[0];
            projectileEvents = new ProjectileEvent[0];
            targetEvents = new TargetEvent[0];
        }
    }

    /// <summary>
    /// Input flag bitmasks for efficient input storage.
    /// </summary>
    [Flags]
    public enum InputFlags : byte
    {
        None = 0,
        Forward = 1 << 0,
        Backward = 1 << 1,
        Left = 1 << 2,
        Right = 1 << 3,
        Jump = 1 << 4,
        Crouch = 1 << 5,
        Sprint = 1 << 6,
        Fire = 1 << 7
    }

    /// <summary>
    /// Jetpack flag bitmasks.
    /// </summary>
    [Flags]
    public enum JetpackFlags : byte
    {
        None = 0,
        Active = 1 << 0,
        Boost = 1 << 1,
        Hover = 1 << 2,
        Brake = 1 << 3
    }

    /// <summary>
    /// Demo clip segment for cool hit extraction.
    /// </summary>
    [Serializable]
    public struct DemoClip
    {
        public float startTime;
        public float endTime;
        public ushort startFrameIndex;
        public ushort endFrameIndex;
        public string description;

        public float Duration => endTime - startTime;
        public ushort FrameCount => (ushort)(endFrameIndex - startFrameIndex + 1);
    }
}
