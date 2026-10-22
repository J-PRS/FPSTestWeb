using UnityEngine;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace DEMO
{
    /// <summary>
    /// Central manager for demo file operations (save, load, browse, delete).
    /// Provides a unified interface for all demo management tasks.
    /// </summary>
    public class DemoManager : MonoBehaviour
    {
        [Header("Settings")]
        [SerializeField] private string demosDirectory = "Demos";
        [SerializeField] private int maxDemosToKeep = 100;
        [SerializeField] private long maxStorageBytes = 500 * 1024 * 1024;  // 500 MB

        [Header("Auto-Delete")]
        [SerializeField] private bool autoDeleteOldDemos = true;
        [SerializeField] private int demoRetentionDays = 30;

        private string _fullDemosPath;
        private List<DemoInfo> _demoCache;
        private DemoRecorder _recorder;
        private DemoPlayer _player;

        public string DemosDirectory => _fullDemosPath;
        public int DemoCount => _demoCache?.Count ?? 0;
        public long TotalStorageUsed => CalculateTotalStorage();

        public event Action<DemoInfo> OnDemoSaved;
        public event Action<DemoInfo> OnDemoDeleted;
        public event Action OnDemoCacheUpdated;

        private void Awake()
        {
            _fullDemosPath = Path.Combine(Application.persistentDataPath, demosDirectory);
            _demoCache = new List<DemoInfo>();
        }

        private void Start()
        {
            InitializeDemosDirectory();
            RefreshDemoCache();

            _recorder = FindAnyObjectByType<DemoRecorder>();
            _player = FindAnyObjectByType<DemoPlayer>();
        }

        /// <summary>
        /// Initialize the demos directory if it doesn't exist.
        /// </summary>
        private void InitializeDemosDirectory()
        {
            if (!Directory.Exists(_fullDemosPath))
            {
                Directory.CreateDirectory(_fullDemosPath);
                Debug.Log($"[DemoManager] Created demos directory: {_fullDemosPath}");
            }
        }

        /// <summary>
        /// Refresh the demo cache by scanning the directory.
        /// </summary>
        public void RefreshDemoCache()
        {
            _demoCache.Clear();

            if (!Directory.Exists(_fullDemosPath))
                return;

            string[] files = Directory.GetFiles(_fullDemosPath, "*.demo");

            foreach (string file in files)
            {
                try
                {
                    DemoInfo info = LoadDemoInfo(file);
                    if (info != null)
                    {
                        _demoCache.Add(info);
                    }
                }
                catch (Exception e)
                {
                    Debug.LogWarning($"[DemoManager] Failed to load demo info for {file}: {e.Message}");
                }
            }

            // Sort by date (newest first)
            _demoCache = _demoCache.OrderByDescending(d => d.timestamp).ToList();

            OnDemoCacheUpdated?.Invoke();

            Debug.Log($"[DemoManager] Refreshed cache: {_demoCache.Count} demos");
        }

        /// <summary>
        /// Load demo metadata from file.
        /// </summary>
        private DemoInfo LoadDemoInfo(string filePath)
        {
            FileInfo fileInfo = new FileInfo(filePath);

            // Read just the header to get metadata
            try
            {
                byte[] data = File.ReadAllBytes(filePath);
                using (MemoryStream ms = new MemoryStream(data))
                using (BinaryReader reader = new BinaryReader(ms))
                {
                    // Skip magic number
                    reader.ReadByte();

                    // Read header
                    DemoHeader header = new DemoHeader();
                    reader.ReadByte(); // magic number
                    header.formatVersion = reader.ReadInt32();
                    header.gameVersion = ReadString(reader);
                    header.timestamp = reader.ReadInt64();
                    header.description = ReadString(reader);
                    header.totalFrames = reader.ReadUInt32();
                    header.projectileEvents = reader.ReadUInt32();
                    header.targetEvents = reader.ReadUInt32();
                    header.duration = reader.ReadSingle();
                    header.checksum = reader.ReadUInt32();
                    header.playerStartPosition = ReadVector3(reader);
                    header.playerStartRotation = ReadQuaternion(reader);
                    header.playerStartVelocity = ReadVector3(reader);

                    return new DemoInfo
                    {
                        filePath = filePath,
                        fileName = fileInfo.Name,
                        fileSize = fileInfo.Length,
                        timestamp = header.timestamp,
                        mapName = "Unknown",
                        gameMode = "Unknown",
                        duration = header.duration,
                        frameCount = (int)header.totalFrames,
                        formatVersion = (byte)header.formatVersion,
                        gameVersion = header.gameVersion,
                        recordedInputs = false
                    };
                }
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Save a demo file.
        /// </summary>
        public string SaveDemo(DemoFile demo, string customName = null)
        {
            if (demo == null)
            {
                Debug.LogError("[DemoManager] Cannot save null demo");
                return null;
            }

            // Generate filename
            string fileName = customName ?? GenerateDemoFileName(demo);
            string filePath = Path.Combine(_fullDemosPath, fileName);

            // Save the file
            try
            {
                DemoSerializer.SaveToFile(demo, filePath);

                // Add to cache
                DemoInfo info = LoadDemoInfo(filePath);
                if (info != null)
                {
                    _demoCache.Add(info);
                    _demoCache = _demoCache.OrderByDescending(d => d.timestamp).ToList();

                    OnDemoSaved?.Invoke(info);
                    OnDemoCacheUpdated?.Invoke();
                }

                // Check storage limits
                CheckStorageLimits();

                Debug.Log($"[DemoManager] Saved demo: {fileName}");
                return filePath;
            }
            catch (Exception e)
            {
                Debug.LogError($"[DemoManager] Failed to save demo: {e.Message}");
                return null;
            }
        }

        /// <summary>
        /// Save current recording from DemoRecorder.
        /// </summary>
        public string SaveCurrentRecording(string customName = null)
        {
            if (_recorder == null)
            {
                Debug.LogError("[DemoManager] No DemoRecorder found");
                return null;
            }

            DemoFile demo = _recorder.ExtractDemoFile();
            return SaveDemo(demo, customName);
        }

        /// <summary>
        /// Load a demo file.
        /// </summary>
        public DemoFile LoadDemo(string filePath)
        {
            if (!File.Exists(filePath))
            {
                Debug.LogError($"[DemoManager] Demo file not found: {filePath}");
                return null;
            }

            try
            {
                DemoFile demo = DemoSerializer.LoadFromFile(filePath);
                Debug.Log($"[DemoManager] Loaded demo: {Path.GetFileName(filePath)}");
                return demo;
            }
            catch (Exception e)
            {
                Debug.LogError($"[DemoManager] Failed to load demo: {e.Message}");
                return null;
            }
        }

        /// <summary>
        /// Load a demo by index and load it into the DemoPlayer.
        /// </summary>
        public bool LoadAndPlayDemo(int index)
        {
            if (index < 0 || index >= _demoCache.Count)
            {
                Debug.LogError($"[DemoManager] Invalid demo index: {index}");
                return false;
            }

            DemoInfo info = _demoCache[index];
            DemoFile demo = LoadDemo(info.filePath);

            if (demo == null)
                return false;

            if (_player != null)
            {
                _player.LoadDemo(demo);
                _player.Play();
                return true;
            }

            Debug.LogError("[DemoManager] No DemoPlayer found");
            return false;
        }

        /// <summary>
        /// Delete a demo file.
        /// </summary>
        public bool DeleteDemo(string filePath)
        {
            if (!File.Exists(filePath))
            {
                Debug.LogWarning($"[DemoManager] Demo file not found: {filePath}");
                return false;
            }

            try
            {
                File.Delete(filePath);

                // Remove from cache
                DemoInfo info = _demoCache.FirstOrDefault(d => d.filePath == filePath);
                if (info != null)
                {
                    _demoCache.Remove(info);
                    OnDemoDeleted?.Invoke(info);
                    OnDemoCacheUpdated?.Invoke();
                }

                Debug.Log($"[DemoManager] Deleted demo: {Path.GetFileName(filePath)}");
                return true;
            }
            catch (Exception e)
            {
                Debug.LogError($"[DemoManager] Failed to delete demo: {e.Message}");
                return false;
            }
        }

        /// <summary>
        /// Delete a demo by index.
        /// </summary>
        public bool DeleteDemo(int index)
        {
            if (index < 0 || index >= _demoCache.Count)
                return false;

            return DeleteDemo(_demoCache[index].filePath);
        }

        /// <summary>
        /// Get demo info by index.
        /// </summary>
        public DemoInfo GetDemoInfo(int index)
        {
            if (index < 0 || index >= _demoCache.Count)
                return null;

            return _demoCache[index];
        }

        /// <summary>
        /// Get all demo infos.
        /// </summary>
        public DemoInfo[] GetAllDemoInfos()
        {
            return _demoCache.ToArray();
        }

        /// <summary>
        /// Check and enforce storage limits.
        /// </summary>
        private void CheckStorageLimits()
        {
            if (!autoDeleteOldDemos)
                return;

            // Delete old demos by date
            if (demoRetentionDays > 0)
            {
                long cutoffTime = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - (demoRetentionDays * 24 * 60 * 60);

                var oldDemos = _demoCache.Where(d => d.timestamp < cutoffTime).ToList();
                foreach (var demo in oldDemos)
                {
                    DeleteDemo(demo.filePath);
                }
            }

            // Delete oldest demos if over count limit
            if (maxDemosToKeep > 0 && _demoCache.Count > maxDemosToKeep)
            {
                int toDelete = _demoCache.Count - maxDemosToKeep;
                for (int i = 0; i < toDelete; i++)
                {
                    DeleteDemo(_demoCache.Count - 1);  // Delete oldest (at end of sorted list)
                }
            }

            // Delete oldest demos if over storage limit
            if (maxStorageBytes > 0 && TotalStorageUsed > maxStorageBytes)
            {
                while (TotalStorageUsed > maxStorageBytes && _demoCache.Count > 0)
                {
                    DeleteDemo(_demoCache.Count - 1);  // Delete oldest
                }
            }
        }

        /// <summary>
        /// Calculate total storage used by demos.
        /// </summary>
        private long CalculateTotalStorage()
        {
            return _demoCache.Sum(d => d.fileSize);
        }

        /// <summary>
        /// Generate a filename for a demo file.
        /// </summary>
        private string GenerateDemoFileName(DemoFile demo)
        {
            DateTime dateTime = DateTimeOffset.FromUnixTimeSeconds(demo.header.timestamp).DateTime;
            string timestamp = dateTime.ToString("yyyyMMdd_HHmmss");
            return $"demo_{timestamp}.demo";
        }

        /// <summary>
        /// Helper to read string from binary reader.
        /// </summary>
        private string ReadString(BinaryReader reader)
        {
            ushort length = reader.ReadUInt16();
            if (length == 0)
                return string.Empty;

            byte[] bytes = reader.ReadBytes(length);
            return System.Text.Encoding.UTF8.GetString(bytes);
        }

        private static Vector3 ReadVector3(BinaryReader reader)
        {
            return new Vector3(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle());
        }

        private static Quaternion ReadQuaternion(BinaryReader reader)
        {
            return new Quaternion(reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle(), reader.ReadSingle());
        }

        /// <summary>
        /// Demo metadata information.
        /// </summary>
        [Serializable]
        public class DemoInfo
        {
            public string filePath;
            public string fileName;
            public long fileSize;
            public long timestamp;
            public string mapName;
            public string gameMode;
            public float duration;
            public int frameCount;
            public byte formatVersion;
            public string gameVersion;
            public bool recordedInputs;

            public string FileSizeMB => (fileSize / (1024f * 1024f)).ToString("F2");
            public string FormattedDate => DateTimeOffset.FromUnixTimeSeconds(timestamp).ToString("yyyy-MM-dd HH:mm");
        }
    }
}
