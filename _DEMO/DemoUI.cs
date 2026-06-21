using UnityEngine;
using UnityEngine.UIElements;
using System;

namespace DEMO
{
    /// <summary>
    /// UI for demo browser and playback controls using UIToolkit.
    /// Modern Unity 6000 compatible UI system.
    /// </summary>
    public class DemoUI : MonoBehaviour
    {
        [Header("UI Settings")]
        [SerializeField] private UIDocument uiDocument;

        private DemoRecorder _recorder;
        private DemoPlayer _player;
        private DemoManager _manager;

        private VisualElement _root;
        private Label _recordingStatusLabel;
        private Label _bufferLabel;
        private Label _timeLabel;
        private Label _progressLabel;
        private Label _storageLabel;
        private Label _demoCountLabel;

        private Button _recordButton;
        private Button _saveButton;
        private Button _refreshButton;
        private Button _playButton;
        private Button _pauseButton;
        private Button _stopButton;
        private Button _seekBackButton;
        private Button _seekForwardButton;

        private TextField _demoNameField;
        private ListView _demoListView;
        private ScrollView _demoListScrollView;

        private Slider _progressSlider;

        private int _selectedDemoIndex = -1;

        private void Start()
        {
            _recorder = FindAnyObjectByType<DemoRecorder>();
            _player = FindAnyObjectByType<DemoPlayer>();
            _manager = FindAnyObjectByType<DemoManager>();

            if (uiDocument != null)
            {
                _root = uiDocument.rootVisualElement;
                BuildUI();
            }
            else
            {
                Debug.LogError("[DemoUI] UIDocument not assigned");
            }

            // Subscribe to events
            if (_manager != null)
            {
                _manager.OnDemoCacheUpdated += RefreshDemoList;
            }

            if (_player != null)
            {
                _player.OnPlaybackTimeChanged += UpdatePlaybackUI;
                _player.OnPlaybackStarted += OnPlaybackStarted;
                _player.OnPlaybackStopped += OnPlaybackStopped;
            }
        }

        private void OnDestroy()
        {
            if (_manager != null)
            {
                _manager.OnDemoCacheUpdated -= RefreshDemoList;
            }

            if (_player != null)
            {
                _player.OnPlaybackTimeChanged -= UpdatePlaybackUI;
                _player.OnPlaybackStarted -= OnPlaybackStarted;
                _player.OnPlaybackStopped -= OnPlaybackStopped;
            }
        }

        private void Update()
        {
            // Update recording status in real-time
            if (_recorder != null && _recordingStatusLabel != null)
            {
                if (_recorder.IsRecording)
                {
                    _recordingStatusLabel.text = $"Recording: {_recorder.RecordingTime:F2}s";
                    _bufferLabel.text = $"Buffer: {_recorder.BufferFrameCount} frames";
                }
                else
                {
                    _recordingStatusLabel.text = "Not Recording";
                    _bufferLabel.text = $"Buffer: {_recorder.BufferFrameCount} frames";
                }
            }

            // Update playback progress
            if (_player != null && _player.IsPlaying && _progressSlider != null)
            {
                _progressSlider.value = _player.Progress;
            }
        }

        private void BuildUI()
        {
            // Create main container
            var container = new VisualElement
            {
                name = "DemoUIContainer",
                style = {
                    position = Position.Absolute,
                    top = 10,
                    left = 10,
                    width = 400,
                    height = 600,
                    backgroundColor = new Color(0.1f, 0.1f, 0.1f, 0.9f)
                }
            };

            // Title
            var title = new Label("Demo System")
            {
                style = {
                    fontSize = 18,
                    unityFontStyleAndWeight = FontStyle.Bold,
                    unityTextAlign = TextAnchor.MiddleCenter,
                    marginBottom = 10
                }
            };
            container.Add(title);

            // Recording section
            var recordingSection = CreateRecordingSection();
            container.Add(recordingSection);

            // Browser section
            var browserSection = CreateBrowserSection();
            container.Add(browserSection);

            // Playback section
            var playbackSection = CreatePlaybackSection();
            container.Add(playbackSection);

            _root.Add(container);
        }

        private VisualElement CreateRecordingSection()
        {
            var section = new VisualElement
            {
                name = "RecordingSection",
                style = {
                    marginBottom = 10,
                    borderBottomWidth = 1,
                    borderBottomColor = Color.gray
                }
            };

            var sectionTitle = new Label("Recording")
            {
                style = { fontSize = 14, unityFontStyleAndWeight = FontStyle.Bold, marginBottom = 5 }
            };
            section.Add(sectionTitle);

            _recordingStatusLabel = new Label("Not Recording")
            {
                style = { marginBottom = 5 }
            };
            section.Add(_recordingStatusLabel);

            _bufferLabel = new Label("Buffer: 0 frames")
            {
                style = { marginBottom = 5 }
            };
            section.Add(_bufferLabel);

            var buttonRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row, marginBottom = 5 }
            };

            _recordButton = new Button(() => ToggleRecording())
            {
                text = "Start Recording",
                style = { flexGrow = 1 }
            };
            buttonRow.Add(_recordButton);

            section.Add(buttonRow);

            var saveRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row }
            };

            _demoNameField = new TextField()
            {
                label = "Name:",
                style = { flexGrow = 1 }
            };
            saveRow.Add(_demoNameField);

            _saveButton = new Button(() => SaveCurrentRecording())
            {
                text = "Save",
                style = { width = 60 }
            };
            saveRow.Add(_saveButton);

            section.Add(saveRow);

            return section;
        }

        private VisualElement CreateBrowserSection()
        {
            var section = new VisualElement
            {
                name = "BrowserSection",
                style = {
                    marginBottom = 10,
                    borderBottomWidth = 1,
                    borderBottomColor = Color.gray
                }
            };

            var sectionTitle = new Label("Demo Browser")
            {
                style = { fontSize = 14, unityFontStyleAndWeight = FontStyle.Bold, marginBottom = 5 }
            };
            section.Add(sectionTitle);

            var infoRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row, marginBottom = 5 }
            };

            _demoCountLabel = new Label("Demos: 0")
            {
                style = { flexGrow = 1 }
            };
            infoRow.Add(_demoCountLabel);

            _storageLabel = new Label("Storage: 0 MB")
            {
                style = { flexGrow = 1 }
            };
            infoRow.Add(_storageLabel);

            section.Add(infoRow);

            _refreshButton = new Button(() => RefreshDemoList())
            {
                text = "Refresh",
                style = { marginBottom = 5 }
            };
            section.Add(_refreshButton);

            _demoListScrollView = new ScrollView
            {
                style = {
                    height = 200,
                    marginBottom = 5
                }
            };
            section.Add(_demoListScrollView);

            return section;
        }

        private VisualElement CreatePlaybackSection()
        {
            var section = new VisualElement
            {
                name = "PlaybackSection",
                style = {
                    display = DisplayStyle.None  // Hidden by default
                }
            };

            var sectionTitle = new Label("Playback Controls")
            {
                style = { fontSize = 14, unityFontStyleAndWeight = FontStyle.Bold, marginBottom = 5 }
            };
            section.Add(sectionTitle);

            _timeLabel = new Label("Time: 0.00s / 0.00s")
            {
                style = { marginBottom = 5 }
            };
            section.Add(_timeLabel);

            _progressLabel = new Label("Progress: 0%")
            {
                style = { marginBottom = 5 }
            };
            section.Add(_progressLabel);

            _progressSlider = new Slider(0, 1)
            {
                style = { marginBottom = 10 }
            };
            _progressSlider.RegisterCallback<ChangeEvent<float>>(evt => _player?.Seek(evt.newValue * _player.Duration));
            section.Add(_progressSlider);

            var controlRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row, marginBottom = 5 }
            };

            _pauseButton = new Button(() => _player?.Pause())
            {
                text = "Pause",
                style = { flexGrow = 1 }
            };
            controlRow.Add(_pauseButton);

            _stopButton = new Button(() => _player?.Stop())
            {
                text = "Stop",
                style = { flexGrow = 1 }
            };
            controlRow.Add(_stopButton);

            section.Add(controlRow);

            var seekRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row }
            };

            _seekBackButton = new Button(() => _player?.Seek(_player.PlaybackTime - 5f))
            {
                text = "<<",
                style = { flexGrow = 1 }
            };
            seekRow.Add(_seekBackButton);

            _seekForwardButton = new Button(() => _player?.Seek(_player.PlaybackTime + 5f))
            {
                text = ">>",
                style = { flexGrow = 1 }
            };
            seekRow.Add(_seekForwardButton);

            section.Add(seekRow);

            return section;
        }

        private void ToggleRecording()
        {
            if (_recorder == null)
                return;

            if (_recorder.IsRecording)
            {
                _recorder.StopRecording();
                _recordButton.text = "Start Recording";
            }
            else
            {
                _recorder.StartRecording();
                _recordButton.text = "Stop Recording";
            }
        }

        private void SaveCurrentRecording()
        {
            if (_manager == null || _recorder == null)
                return;

            string name = string.IsNullOrEmpty(_demoNameField.value) ? null : _demoNameField.value;
            _manager.SaveCurrentRecording(name);
            _demoNameField.value = "";
        }

        private void RefreshDemoList()
        {
            if (_manager == null)
                return;

            _manager.RefreshDemoCache();

            _demoListScrollView.Clear();

            var demos = _manager.GetAllDemoInfos();
            _demoCountLabel.text = $"Demos: {demos.Length}";
            _storageLabel.text = $"Storage: {_manager.TotalStorageUsed / (1024f * 1024f):F2} MB";

            foreach (var demo in demos)
            {
                var demoItem = CreateDemoItem(demo);
                _demoListScrollView.Add(demoItem);
            }
        }

        private VisualElement CreateDemoItem(DemoManager.DemoInfo demo)
        {
            var item = new VisualElement
            {
                style = {
                    backgroundColor = new Color(0.2f, 0.2f, 0.2f, 1f),
                    marginBottom = 5
                }
            };

            var nameRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row, marginBottom = 3 }
            };

            var nameLabel = new Label(demo.fileName)
            {
                style = { flexGrow = 1, fontSize = 12, unityFontStyleAndWeight = FontStyle.Bold }
            };
            nameRow.Add(nameLabel);

            var durationLabel = new Label($"{demo.duration:F1}s")
            {
                style = { fontSize = 12 }
            };
            nameRow.Add(durationLabel);

            item.Add(nameRow);

            var infoRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row, marginBottom = 5 }
            };

            var mapLabel = new Label($"Map: {demo.mapName}")
            {
                style = { fontSize = 11, flexGrow = 1 }
            };
            infoRow.Add(mapLabel);

            var sizeLabel = new Label($"{demo.FileSizeMB} MB")
            {
                style = { fontSize = 11 }
            };
            infoRow.Add(sizeLabel);

            item.Add(infoRow);

            var buttonRow = new VisualElement
            {
                style = { flexDirection = FlexDirection.Row }
            };

            var playButton = new Button(() => PlayDemo(demo))
            {
                text = "Play",
                style = { flexGrow = 1, marginRight = 5 }
            };
            buttonRow.Add(playButton);

            var deleteButton = new Button(() => DeleteDemo(demo))
            {
                text = "Delete",
                style = { flexGrow = 1 }
            };
            buttonRow.Add(deleteButton);

            item.Add(buttonRow);

            return item;
        }

        private void PlayDemo(DemoManager.DemoInfo demo)
        {
            if (_manager == null)
                return;

            var demos = _manager.GetAllDemoInfos();
            for (int i = 0; i < demos.Length; i++)
            {
                if (demos[i].filePath == demo.filePath)
                {
                    _manager.LoadAndPlayDemo(i);
                    break;
                }
            }
        }

        private void DeleteDemo(DemoManager.DemoInfo demo)
        {
            if (_manager == null)
                return;

            var demos = _manager.GetAllDemoInfos();
            for (int i = 0; i < demos.Length; i++)
            {
                if (demos[i].filePath == demo.filePath)
                {
                    _manager.DeleteDemo(i);
                    RefreshDemoList();
                    break;
                }
            }
        }

        private void UpdatePlaybackUI(float time)
        {
            if (_player == null)
                return;

            _timeLabel.text = $"Time: {time:F2}s / {_player.Duration:F2}s";
            _progressLabel.text = $"Progress: {_player.Progress * 100:F1}%";
        }

        private void OnPlaybackStarted()
        {
            // Show playback section
            var playbackSection = _root.Q("PlaybackSection");
            if (playbackSection != null)
            {
                playbackSection.style.display = DisplayStyle.Flex;
            }
        }

        private void OnPlaybackStopped()
        {
            // Hide playback section
            var playbackSection = _root.Q("PlaybackSection");
            if (playbackSection != null)
            {
                playbackSection.style.display = DisplayStyle.None;
            }
        }
    }
}
