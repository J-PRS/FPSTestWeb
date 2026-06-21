using UnityEngine;
using UnityEngine.InputSystem;
using System;

namespace DEMO
{
    /// <summary>
    /// Replay component for playing back demo files.
    /// Reconstructs gameplay from recorded keyframes and events.
    /// Uses Unity's new Input System (Unity 6000 compatible).
    /// </summary>
    public class DemoPlayer : MonoBehaviour
    {
        [Header("Playback Settings")]
        [SerializeField] private float playbackSpeed = 1f;
        [SerializeField] private bool loopPlayback = false;

        [Header("Camera")]
        [SerializeField] private bool useFreeCamera = true;
        [SerializeField] private float freeCameraSpeed = 10f;

        private DemoFile _currentDemo;
        private bool _isPlaying;
        private bool _isPaused;
        private float _playbackTime;
        private int _currentFrameIndex;

        // Replay objects
        private GameObject _replayPlayer;
        private GameObject _replayCamera;

        // Input System for playback controls
        private InputAction _pauseAction;
        private InputAction _stopAction;
        private InputAction _seekBackAction;
        private InputAction _seekForwardAction;
        private InputAction _speedUpAction;
        private InputAction _speedDownAction;

        // Events
        public event Action OnPlaybackStarted;
        public event Action OnPlaybackStopped;
        public event Action<float> OnPlaybackTimeChanged;

        public bool IsPlaying => _isPlaying;
        public bool IsPaused => _isPaused;
        public float PlaybackTime => _playbackTime;
        public float Duration => _currentDemo?.header.duration ?? 0f;
        public float Progress => Duration > 0 ? _playbackTime / Duration : 0f;

        private void Start()
        {
            SetupInputActions();
        }

        private void OnDestroy()
        {
            CleanupInputActions();
        }

        private void SetupInputActions()
        {
            // Create input actions for playback controls using InputActionMap
            var actionMap = new InputActionMap("DemoPlayback");

            _pauseAction = actionMap.AddAction("Pause", InputActionType.Button);
            _pauseAction.AddBinding("<Keyboard>/space");

            _stopAction = actionMap.AddAction("Stop", InputActionType.Button);
            _stopAction.AddBinding("<Keyboard>/escape");

            _seekBackAction = actionMap.AddAction("SeekBack", InputActionType.Button);
            _seekBackAction.AddBinding("<Keyboard>/leftArrow");

            _seekForwardAction = actionMap.AddAction("SeekForward", InputActionType.Button);
            _seekForwardAction.AddBinding("<Keyboard>/rightArrow");

            _speedUpAction = actionMap.AddAction("SpeedUp", InputActionType.Button);
            _speedUpAction.AddBinding("<Keyboard>/plus");
            _speedUpAction.AddBinding("<Keyboard>/equals");

            _speedDownAction = actionMap.AddAction("SpeedDown", InputActionType.Button);
            _speedDownAction.AddBinding("<Keyboard>/minus");

            // Enable the action map
            actionMap.Enable();
        }

        private void CleanupInputActions()
        {
            _pauseAction?.Disable();
            _stopAction?.Disable();
            _seekBackAction?.Disable();
            _seekForwardAction?.Disable();
            _speedUpAction?.Disable();
            _speedDownAction?.Disable();
        }

        private void Update()
        {
            if (!_isPlaying || _isPaused)
                return;

            UpdatePlayback();
            HandlePlaybackControls();
        }

        /// <summary>
        /// Load a demo file for playback.
        /// </summary>
        public void LoadDemo(DemoFile demo)
        {
            if (demo == null)
            {
                Debug.LogError("[DemoPlayer] Cannot load null demo");
                return;
            }

            _currentDemo = demo;
            _playbackTime = 0f;
            _currentFrameIndex = 0;

            Debug.Log($"[DemoPlayer] Loaded demo: {demo.header.gameVersion}, Duration: {demo.header.duration:F2}s, Frames: {demo.header.totalFrames}");
        }

        /// <summary>
        /// Start playback of the loaded demo.
        /// </summary>
        public void Play()
        {
            if (_currentDemo == null)
            {
                Debug.LogError("[DemoPlayer] No demo loaded");
                return;
            }

            if (_isPlaying && !_isPaused)
                return;

            if (!_isPlaying)
            {
                SetupReplayScene();
                OnPlaybackStarted?.Invoke();
            }

            _isPlaying = true;
            _isPaused = false;
            Debug.Log("[DemoPlayer] Playback started");
        }

        /// <summary>
        /// Pause playback.
        /// </summary>
        public void Pause()
        {
            if (!_isPlaying)
                return;

            _isPaused = true;
            Debug.Log("[DemoPlayer] Playback paused");
        }

        /// <summary>
        /// Resume playback.
        /// </summary>
        public void Resume()
        {
            if (!_isPlaying || !_isPaused)
                return;

            _isPaused = false;
            Debug.Log("[DemoPlayer] Playback resumed");
        }

        /// <summary>
        /// Stop playback and clean up.
        /// </summary>
        public void Stop()
        {
            if (!_isPlaying)
                return;

            _isPlaying = false;
            _isPaused = false;
            _playbackTime = 0f;
            _currentFrameIndex = 0;

            CleanupReplayScene();
            OnPlaybackStopped?.Invoke();

            Debug.Log("[DemoPlayer] Playback stopped");
        }

        /// <summary>
        /// Seek to a specific time in the demo.
        /// </summary>
        public void Seek(float time)
        {
            if (_currentDemo == null)
                return;

            time = Mathf.Clamp(time, 0f, Duration);
            _playbackTime = time;

            // Find the frame at this time
            _currentFrameIndex = FindFrameAtTime(time);

            OnPlaybackTimeChanged?.Invoke(time);
        }

        /// <summary>
        /// Set playback speed.
        /// </summary>
        public void SetPlaybackSpeed(float speed)
        {
            playbackSpeed = Mathf.Max(0.1f, speed);
        }

        /// <summary>
        /// Update playback state each frame.
        /// </summary>
        private void UpdatePlayback()
        {
            if (_currentDemo == null || _currentDemo.frames.Length == 0)
                return;

            // Advance playback time
            _playbackTime += Time.deltaTime * playbackSpeed;

            // Check if playback is complete
            if (_playbackTime >= Duration)
            {
                if (loopPlayback)
                {
                    _playbackTime = 0f;
                    _currentFrameIndex = 0;
                }
                else
                {
                    Stop();
                    return;
                }
            }

            // Find and apply current frame
            _currentFrameIndex = FindFrameAtTime(_playbackTime);

            if (_currentFrameIndex >= 0 && _currentFrameIndex < _currentDemo.frames.Length)
            {
                ApplyFrame(_currentDemo.frames[_currentFrameIndex]);
            }

            OnPlaybackTimeChanged?.Invoke(_playbackTime);
        }

        /// <summary>
        /// Find the frame index at a specific time.
        /// </summary>
        private int FindFrameAtTime(float time)
        {
            if (_currentDemo == null || _currentDemo.frames.Length == 0)
                return 0;

            // Binary search for efficiency
            int left = 0;
            int right = _currentDemo.frames.Length - 1;

            while (left <= right)
            {
                int mid = (left + right) / 2;
                float frameTime = _currentDemo.frames[mid].timestamp;

                if (frameTime < time)
                    left = mid + 1;
                else if (frameTime > time)
                    right = mid - 1;
                else
                    return mid;
            }

            return Mathf.Clamp(left, 0, _currentDemo.frames.Length - 1);
        }

        /// <summary>
        /// Apply frame data to replay objects.
        /// </summary>
        private void ApplyFrame(DemoFrame frame)
        {
            if (_replayPlayer == null)
                return;

            // Apply player state
            _replayPlayer.transform.position = frame.position;
            _replayPlayer.transform.rotation = frame.rotation;

            Rigidbody rb = _replayPlayer.GetComponent<Rigidbody>();
            if (rb != null)
            {
                rb.linearVelocity = frame.velocity;
            }

            // TODO: Apply inputs to player controller if using input-based replay
            // TODO: Handle projectile and target events
        }

        /// <summary>
        /// Setup the replay scene with ghost objects.
        /// </summary>
        private void SetupReplayScene()
        {
            // Create replay player ghost
            _replayPlayer = new GameObject("ReplayPlayer");
            _replayPlayer.transform.position = _currentDemo.playerStartPosition;
            _replayPlayer.transform.rotation = _currentDemo.playerStartRotation;

            // Add visual representation
            // TODO: Add player mesh or capsule renderer

            Rigidbody rb = _replayPlayer.AddComponent<Rigidbody>();
            rb.isKinematic = true;  // We manually control position
            rb.linearVelocity = _currentDemo.playerStartVelocity;

            // Create free camera if enabled
            if (useFreeCamera)
            {
                _replayCamera = new GameObject("ReplayCamera");
                Camera cam = _replayCamera.AddComponent<Camera>();
                cam.depth = 100;  // Render on top
                _replayCamera.transform.position = _currentDemo.playerStartPosition + Vector3.back * 10f + Vector3.up * 3f;
                _replayCamera.transform.LookAt(_currentDemo.playerStartPosition);

                // TODO: Add free camera controls
            }

            // TODO: Create projectile ghosts
            // TODO: Create target/ball ghosts
        }

        /// <summary>
        /// Clean up replay scene objects.
        /// </summary>
        private void CleanupReplayScene()
        {
            if (_replayPlayer != null)
            {
                Destroy(_replayPlayer);
                _replayPlayer = null;
            }

            if (_replayCamera != null)
            {
                Destroy(_replayCamera);
                _replayCamera = null;
            }
        }

        /// <summary>
        /// Handle keyboard playback controls using new Input System.
        /// </summary>
        private void HandlePlaybackControls()
        {
            // Space: Pause/Resume
            if (_pauseAction != null && _pauseAction.WasPressedThisFrame())
            {
                if (_isPaused)
                    Resume();
                else
                    Pause();
            }

            // Escape: Stop
            if (_stopAction != null && _stopAction.WasPressedThisFrame())
            {
                Stop();
            }

            // Arrow keys: Seek
            if (_seekBackAction != null && _seekBackAction.IsPressed())
            {
                Seek(_playbackTime - Time.deltaTime * 2f);
            }
            if (_seekForwardAction != null && _seekForwardAction.IsPressed())
            {
                Seek(_playbackTime + Time.deltaTime * 2f);
            }

            // +/-: Adjust playback speed
            if (_speedUpAction != null && _speedUpAction.WasPressedThisFrame())
            {
                SetPlaybackSpeed(playbackSpeed + 0.25f);
            }
            if (_speedDownAction != null && _speedDownAction.WasPressedThisFrame())
            {
                SetPlaybackSpeed(playbackSpeed - 0.25f);
            }
        }
    }
}
