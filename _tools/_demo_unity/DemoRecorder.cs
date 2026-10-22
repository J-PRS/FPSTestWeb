using UnityEngine;
using UnityEngine.InputSystem;
using System;
using System.Collections.Generic;

namespace DEMO
{
    /// <summary>
    /// Recording mode options.
    /// </summary>
    public enum RecordingMode
    {
        /// <summary>
        /// Record every frame at variable framerate.
        /// Simpler, adaptive to performance, interpolation smooths replay.
        /// Recommended for highlight clips.
        /// </summary>
        VariableFramerate,

        /// <summary>
        /// Record at fixed tick rate (deterministic).
        /// Independent of actual FPS, consistent timing.
        /// Recommended for debugging/deterministic replay.
        /// </summary>
        FixedTimestep
    }

    /// <summary>
    /// Main recording component for capturing gameplay events.
    /// Uses continuous circular buffer recording with selective extraction.
    /// Designed for minimal runtime overhead.
    /// Uses Unity's new Input System (Unity 6000 compatible).
    /// Minimally coupled to game systems via interfaces.
    /// </summary>
    public class DemoRecorder : MonoBehaviour, IProjectileEventSource, ITargetEventSource
    {
        [Header("Recording Settings")]
        [SerializeField] private float bufferDuration = 30f;  // Seconds of data to keep in buffer
        [SerializeField] private RecordingMode recordingMode = RecordingMode.VariableFramerate;  // Recording mode
        [SerializeField] private bool recordInputs = false;    // true = inputs, false = state only
        [SerializeField] private bool autoRecord = true;       // Start recording automatically
        [SerializeField] private int recordingTickRate = 60;   // Fixed tick rate (only for FixedTimestep mode)
        [SerializeField] private bool requireDataProviders = true;  // Fail if providers missing

        [Header("Keyframe Options")]
        [SerializeField] private bool recordPeakPositions = false;    // Record velocity sign changes (peak arc)

        [Header("Limits")]
        [SerializeField] private int maxEventsPerSecond = 1000;  // Rate limit for event spam
        [SerializeField] private int maxTotalEvents = 10000;       // Absolute limit for events

        [Header("Debug")]
        [SerializeField] private bool showDebugInfo = false;
        [SerializeField] private bool logMissingProviders = true;

        // Circular buffers for continuous recording
        private CircularBuffer<DemoFrame> _frameBuffer;
        private List<ProjectileEvent> _projectileEvents;
        private List<TargetEvent> _targetEvents;

        // Recording state
        private bool _isRecording;
        private float _recordingStartTime;
        private float _fixedDeltaTime;
        private float _accumulator;
        private uint _frameCount;
        private uint _projectileIdCounter;
        private uint _targetIdCounter;
        private int _eventsThisSecond;
        private float _lastSecondTime;

        // Data providers (minimal coupling via interfaces)
        private IPlayerDataProvider _playerDataProvider;
        private IInputProvider _inputProvider;

        // Events for external systems to hook into
        public event Action<ProjectileEvent> OnProjectileEvent;
        public event Action<TargetEvent> OnTargetEvent;
        public event Action<DemoClip> OnCoolHitDetected;

        public bool IsRecording => _isRecording;
        public float RecordingTime => Time.time - _recordingStartTime;
        public uint FrameCount => _frameCount;
        public int BufferFrameCount => _frameBuffer?.Count ?? 0;
        public static readonly int CurrentFormatVersion = 1;

        private void Awake()
        {
            // Calculate buffer size based on duration and tick rate
            int bufferCapacity = Mathf.CeilToInt(bufferDuration * recordingTickRate);
            _frameBuffer = new CircularBuffer<DemoFrame>(bufferCapacity);
            _projectileEvents = new List<ProjectileEvent>();
            _targetEvents = new List<TargetEvent>();

            // Setup fixed timestep
            _fixedDeltaTime = 1f / recordingTickRate;
        }

        private void Start()
        {
            // Discover data providers via interfaces (minimal coupling)
            _playerDataProvider = FindAnyObjectByType<MonoBehaviour>() as IPlayerDataProvider;
            _inputProvider = FindAnyObjectByType<MonoBehaviour>() as IInputProvider;

            // Validate data providers
            if (requireDataProviders)
            {
                if (_playerDataProvider == null)
                {
                    string msg = "[DemoRecorder] IPlayerDataProvider not found in scene. Recording will use default values.";
                    if (logMissingProviders)
                        Debug.LogWarning(msg);
                    else
                        Debug.LogError(msg);
                }

                if (_inputProvider == null)
                {
                    string msg = "[DemoRecorder] IInputProvider not found in scene. Recording will use default values.";
                    if (logMissingProviders)
                        Debug.LogWarning(msg);
                    else
                        Debug.LogError(msg);
                }
            }

            if (autoRecord)
            {
                StartRecording();
            }
        }

        private void OnDestroy()
        {
            // Cleanup handled by Unity
        }

        private void Update()
        {
            if (!_isRecording)
                return;

            // Recording mode selection
            if (recordingMode == RecordingMode.FixedTimestep)
            {
                // Fixed timestep recording for deterministic playback
                _accumulator += Time.deltaTime;

                while (_accumulator >= _fixedDeltaTime)
                {
                    RecordFrame();
                    _accumulator -= _fixedDeltaTime;
                }
            }
            else
            {
                // Variable framerate recording - record every frame
                RecordFrame();
            }

            // Reset event counter every second
            if (Time.time - _lastSecondTime >= 1f)
            {
                _eventsThisSecond = 0;
                _lastSecondTime = Time.time;
            }
        }

        /// <summary>
        /// Start recording gameplay.
        /// </summary>
        public void StartRecording()
        {
            if (_isRecording)
                return;

            _isRecording = true;
            _recordingStartTime = Time.time;
            _frameCount = 0;
            _projectileIdCounter = 0;
            _targetIdCounter = 0;
            _accumulator = 0f;
            _eventsThisSecond = 0;
            _lastSecondTime = Time.time;

            _frameBuffer.Clear();
            _projectileEvents.Clear();
            _targetEvents.Clear();

            Debug.Log("[DemoRecorder] Recording started");
        }

        /// <summary>
        /// Stop recording gameplay.
        /// </summary>
        public void StopRecording()
        {
            if (!_isRecording)
                return;

            _isRecording = false;
            Debug.Log($"[DemoRecorder] Recording stopped. Frames: {_frameCount}, Projectile events: {_projectileEvents.Count}, Target events: {_targetEvents.Count}");
        }

        /// <summary>
        /// Record current frame data.
        /// </summary>
        private void RecordFrame()
        {
            // Check for frame counter overflow
            if (_frameCount >= uint.MaxValue - 1)
            {
                Debug.LogWarning("[DemoRecorder] Frame counter approaching overflow, wrapping around");
                _frameCount = 0;
            }

            DemoFrame frame = new DemoFrame
            {
                frameNumber = (ushort)_frameCount,
                timestamp = Time.time - _recordingStartTime,
                position = _playerDataProvider != null ? _playerDataProvider.Position : Vector3.zero,
                velocity = _playerDataProvider != null ? _playerDataProvider.Velocity : Vector3.zero,
                rotation = _playerDataProvider != null ? _playerDataProvider.Rotation : Quaternion.identity,
                inputFlags = recordInputs ? CaptureInputFlags() : (byte)0,
                mouseDeltaX = recordInputs ? (short)CaptureMouseDeltaX() : (short)0,
                mouseDeltaY = recordInputs ? (short)CaptureMouseDeltaY() : (short)0,
                jetpackFlags = recordInputs ? CaptureJetpackFlags() : (byte)0,
                jetpackFuel = recordInputs ? CaptureJetpackFuel() : 0f
            };

            _frameBuffer.Add(frame);
            _frameCount++;
        }

        /// <summary>
        /// Capture input flags as bitmask using IInputProvider interface.
        /// </summary>
        private byte CaptureInputFlags()
        {
            try
            {
                return _inputProvider != null ? _inputProvider.InputFlags : (byte)0;
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[DemoRecorder] Error capturing input flags: {e.Message}");
                return (byte)0;
            }
        }

        /// <summary>
        /// Capture jetpack flags using IInputProvider interface.
        /// </summary>
        private byte CaptureJetpackFlags()
        {
            try
            {
                return _inputProvider != null ? _inputProvider.JetpackFlags : (byte)0;
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[DemoRecorder] Error capturing jetpack flags: {e.Message}");
                return (byte)0;
            }
        }

        /// <summary>
        /// Capture jetpack fuel using IInputProvider interface.
        /// </summary>
        private float CaptureJetpackFuel()
        {
            try
            {
                return _inputProvider != null ? Mathf.Clamp01(_inputProvider.JetpackFuel) : 0f;
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[DemoRecorder] Error capturing jetpack fuel: {e.Message}");
                return 0f;
            }
        }

        /// <summary>
        /// Capture mouse delta X using IInputProvider interface.
        /// </summary>
        private float CaptureMouseDeltaX()
        {
            try
            {
                return _inputProvider != null ? Mathf.Clamp(_inputProvider.MouseDeltaX, -32767f, 32767f) : 0f;
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[DemoRecorder] Error capturing mouse delta X: {e.Message}");
                return 0f;
            }
        }

        /// <summary>
        /// Capture mouse delta Y using IInputProvider interface.
        /// </summary>
        private float CaptureMouseDeltaY()
        {
            try
            {
                return _inputProvider != null ? Mathf.Clamp(_inputProvider.MouseDeltaY, -32767f, 32767f) : 0f;
            }
            catch (System.Exception e)
            {
                Debug.LogWarning($"[DemoRecorder] Error capturing mouse delta Y: {e.Message}");
                return 0f;
            }
        }

        /// <summary>
        /// Record a projectile event (fire, bounce, hit).
        /// Called by projectile system.
        /// </summary>
        public void RecordProjectileEvent(ProjectileEventType eventType, Vector3 position, Vector3 velocity,
                                         byte weaponType, Vector3 surfaceNormal = default, ushort targetId = 0)
        {
            if (!_isRecording)
                return;

            // Rate limiting
            if (!CheckEventRateLimit())
                return;

            // Total event limit
            if (_projectileEvents.Count + _targetEvents.Count >= maxTotalEvents)
            {
                Debug.LogWarning("[DemoRecorder] Max total events reached, dropping projectile event");
                return;
            }

            ProjectileEvent evt = new ProjectileEvent
            {
                eventType = eventType,
                timestamp = Time.time - _recordingStartTime,
                position = position,
                velocity = velocity,
                projectileId = (ushort)_projectileIdCounter++,
                weaponType = weaponType,
                surfaceNormal = surfaceNormal,
                targetId = targetId,
                hasPeakPosition = false,
                peakPosition = Vector3.zero
            };

            _projectileEvents.Add(evt);
            _eventsThisSecond++;
            OnProjectileEvent?.Invoke(evt);

            // Check if this is a cool hit
            if (eventType == ProjectileEventType.Hit)
            {
                CheckForCoolHit(evt);
            }
        }

        /// <summary>
        /// Record projectile peak position (velocity.y sign change).
        /// Optional enhancement for precision.
        /// </summary>
        public void RecordProjectilePeak(ushort projectileId, Vector3 peakPosition)
        {
            if (!_isRecording || !recordPeakPositions)
                return;

            // Find the most recent event for this projectile and update it
            for (int i = _projectileEvents.Count - 1; i >= 0; i--)
            {
                if (_projectileEvents[i].projectileId == projectileId)
                {
                    var evt = _projectileEvents[i];
                    evt.hasPeakPosition = true;
                    evt.peakPosition = peakPosition;
                    _projectileEvents[i] = evt;
                    break;
                }
            }
        }

        /// <summary>
        /// Check event rate limit to prevent event spam.
        /// </summary>
        private bool CheckEventRateLimit()
        {
            if (_eventsThisSecond >= maxEventsPerSecond)
            {
                if (Time.frameCount % 60 == 0)  // Log once per second
                    Debug.LogWarning($"[DemoRecorder] Event rate limit reached ({maxEventsPerSecond}/s), dropping events");
                return false;
            }
            return true;
        }

        // IProjectileEventSource implementation
        public void RecordProjectileFired(Vector3 position, Vector3 velocity, byte weaponType)
        {
            RecordProjectileEvent(ProjectileEventType.Fired, position, velocity, weaponType);
        }

        public void RecordProjectileBounce(ushort projectileId, Vector3 position, Vector3 velocity, Vector3 surfaceNormal)
        {
            RecordProjectileEvent(ProjectileEventType.Bounce, position, velocity, 0, surfaceNormal);
        }

        public void RecordProjectileHit(ushort projectileId, Vector3 position, ushort targetId)
        {
            RecordProjectileEvent(ProjectileEventType.Hit, position, Vector3.zero, 0, default, targetId);
        }

        public void RecordProjectileDestroyed(ushort projectileId, Vector3 position)
        {
            RecordProjectileEvent(ProjectileEventType.Destroyed, position, Vector3.zero, 0);
        }

        /// <summary>
        /// Record a target/ball event.
        /// Called by target system.
        /// </summary>
        public void RecordTargetEvent(TargetEventType eventType, Vector3 position, Vector3 velocity,
                                      bool hasOrbitalGravity = false, Vector3 gravityCenter = default, float gravityStrength = 0f)
        {
            if (!_isRecording)
                return;

            // Rate limiting
            if (!CheckEventRateLimit())
                return;

            // Total event limit
            if (_projectileEvents.Count + _targetEvents.Count >= maxTotalEvents)
            {
                Debug.LogWarning("[DemoRecorder] Max total events reached, dropping target event");
                return;
            }

            // Validate position/velocity (prevent NaN/Infinity)
            if (!IsValidVector3(position) || !IsValidVector3(velocity))
            {
                Debug.LogWarning("[DemoRecorder] Invalid position/velocity in target event, skipping");
                return;
            }

            TargetEvent evt = new TargetEvent
            {
                eventType = eventType,
                timestamp = Time.time - _recordingStartTime,
                position = position,
                velocity = velocity,
                targetId = (ushort)_targetIdCounter++,
                targetType = 0,  // TODO: Get from target system
                health = 1f,  // TODO: Get from target system
                hasPeakPosition = false,
                peakPosition = Vector3.zero
            };

            _targetEvents.Add(evt);
            _eventsThisSecond++;
            OnTargetEvent?.Invoke(evt);
        }

        /// <summary>
        /// Record target peak position (velocity.y sign change).
        /// Optional enhancement for precision.
        /// </summary>
        public void RecordTargetPeak(ushort targetId, Vector3 peakPosition)
        {
            if (!_isRecording || !recordPeakPositions)
                return;

            // Find the most recent event for this target and update it
            for (int i = _targetEvents.Count - 1; i >= 0; i--)
            {
                if (_targetEvents[i].targetId == targetId)
                {
                    var evt = _targetEvents[i];
                    evt.hasPeakPosition = true;
                    evt.peakPosition = peakPosition;
                    _targetEvents[i] = evt;
                    break;
                }
            }
        }

        /// <summary>
        /// Validate Vector3 for NaN/Infinity.
        /// </summary>
        private bool IsValidVector3(Vector3 v)
        {
            return !float.IsNaN(v.x) && !float.IsNaN(v.y) && !float.IsNaN(v.z) &&
                   !float.IsInfinity(v.x) && !float.IsInfinity(v.y) && !float.IsInfinity(v.z);
        }

        // ITargetEventSource implementation
        public void RecordTargetSpawned(ushort targetId, Vector3 position, Vector3 velocity, byte targetType)
        {
            RecordTargetEvent(TargetEventType.Spawned, position, velocity);
        }

        public void RecordTargetBounce(ushort targetId, Vector3 position, Vector3 velocity)
        {
            RecordTargetEvent(TargetEventType.Bounce, position, velocity);
        }

        public void RecordTargetHit(ushort targetId, Vector3 position, float health)
        {
            RecordTargetEvent(TargetEventType.Hit, position, Vector3.zero);
        }

        public void RecordTargetDestroyed(ushort targetId, Vector3 position)
        {
            RecordTargetEvent(TargetEventType.Destroyed, position, Vector3.zero);
        }

        public void RecordTargetStateChanged(ushort targetId, byte newState)
        {
            RecordTargetEvent(TargetEventType.StateChanged, Vector3.zero, Vector3.zero);
        }

        /// <summary>
        /// Check if a hit qualifies as a "cool shot" worthy of extraction.
        /// </summary>
        private void CheckForCoolHit(ProjectileEvent hitEvent)
        {
            // TODO: Implement cool hit detection logic
            // Criteria could include:
            // - Long distance shot
            // - High velocity hit
            // - Prediction shot (leading target)
            // - Multiple bounces before hit
            // - Moving target hit

            // For MVP, extract all hits for now
            ExtractClipAroundEvent(hitEvent.timestamp, 2f, 2f, "Hit");
        }

        /// <summary>
        /// Extract a clip segment around a specific event.
        /// </summary>
        /// <param name="eventTimestamp">Timestamp of the event</param>
        /// <param name="secondsBefore">Seconds before event to include</param>
        /// <param name="secondsAfter">Seconds after event to include</param>
        /// <param name="description">Clip description</param>
        public void ExtractClipAroundEvent(float eventTimestamp, float secondsBefore, float secondsAfter, string description)
        {
            float startTime = eventTimestamp - secondsBefore;
            float endTime = eventTimestamp + secondsAfter;

            // Find frame indices
            int startIndex = _frameBuffer.FindIndexAfterTimestamp(startTime, f => f.timestamp);
            int endIndex = _frameBuffer.FindIndexAfterTimestamp(endTime, f => f.timestamp);

            if (startIndex == -1)
                startIndex = 0;
            if (endIndex == -1)
                endIndex = _frameBuffer.Count - 1;

            DemoClip clip = new DemoClip
            {
                startTime = startTime,
                endTime = endTime,
                startFrameIndex = (ushort)startIndex,
                endFrameIndex = (ushort)endIndex,
                description = description
            };

            OnCoolHitDetected?.Invoke(clip);

            Debug.Log($"[DemoRecorder] Extracted clip: {description} ({clip.Duration}s, {clip.FrameCount} frames)");
        }

        /// <summary>
        /// Extract all recorded data as a DemoFile.
        /// </summary>
        public DemoFile ExtractDemoFile()
        {
            Vector3 startPos = _playerDataProvider != null ? _playerDataProvider.Position : Vector3.zero;
            Quaternion startRot = _playerDataProvider != null ? _playerDataProvider.Rotation : Quaternion.identity;
            Vector3 startVel = _playerDataProvider != null ? _playerDataProvider.Velocity : Vector3.zero;

            DemoFile demoFile = new DemoFile
            {
                header = new DemoHeader
                {
                    formatVersion = CurrentFormatVersion,
                    gameVersion = Application.version,
                    duration = RecordingTime,
                    totalFrames = (uint)_frameBuffer.Count,
                    projectileEvents = (uint)_projectileEvents.Count,
                    targetEvents = (uint)_targetEvents.Count,
                    playerStartPosition = startPos,
                    playerStartRotation = startRot,
                    playerStartVelocity = startVel,
                    description = "Full session recording",
                    checksum = 0,  // TODO: Calculate checksum
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                },
                frames = _frameBuffer.ExtractAll(),
                projectileEvents = _projectileEvents.ToArray(),
                targetEvents = _targetEvents.ToArray()
            };

            return demoFile;
        }

        /// <summary>
        /// Extract a clip as a DemoFile.
        /// </summary>
        public DemoFile ExtractClipAsDemoFile(DemoClip clip)
        {
            DemoFile demoFile = new DemoFile
            {
                header = new DemoHeader
                {
                    formatVersion = CurrentFormatVersion,
                    gameVersion = Application.version,
                    duration = clip.Duration,
                    totalFrames = (uint)clip.FrameCount,
                    projectileEvents = 0,  // TODO: Filter events within clip range
                    targetEvents = 0,
                    playerStartPosition = Vector3.zero,
                    playerStartRotation = Quaternion.identity,
                    playerStartVelocity = Vector3.zero,
                    description = clip.description,
                    checksum = 0,  // TODO: Calculate checksum
                    timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
                },
                frames = _frameBuffer.ExtractRange(clip.startFrameIndex, clip.FrameCount),
                projectileEvents = new ProjectileEvent[0],  // TODO: Filter events
                targetEvents = new TargetEvent[0]
            };

            return demoFile;
        }

        private void OnGUI()
        {
            if (!showDebugInfo)
                return;

            GUILayout.BeginArea(new Rect(10, 10, 300, 200));
            GUILayout.Label($"[DemoRecorder]");
            GUILayout.Label($"Recording: {_isRecording}");
            GUILayout.Label($"Time: {RecordingTime:F2}s");
            GUILayout.Label($"Frames: {_frameCount}");
            GUILayout.Label($"Buffer: {_frameBuffer.Count}/{_frameBuffer.Capacity}");
            GUILayout.Label($"Projectile Events: {_projectileEvents.Count}");
            GUILayout.Label($"Target Events: {_targetEvents.Count}");
            GUILayout.EndArea();
        }
    }
}
