using UnityEngine;
using System;
using System.IO;
using System.Text;

namespace DEMO
{
    /// <summary>
    /// Binary serialization for demo files.
    /// Uses custom binary format for minimal file size and fast I/O.
    /// </summary>
    public static class DemoSerializer
    {
        private const byte DEMO_MAGIC_NUMBER = 0x44;  // 'D'
        private const byte CURRENT_FORMAT_VERSION = 1;

        /// <summary>
        /// Serialize a demo file to binary format.
        /// </summary>
        public static byte[] Serialize(DemoFile demo)
        {
            if (demo == null)
                throw new ArgumentNullException(nameof(demo));

            using (MemoryStream ms = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(ms))
            {
                // Write header
                WriteHeader(writer, demo.header);

                // Write initial state
                WriteVector3(writer, demo.playerStartPosition);
                WriteQuaternion(writer, demo.playerStartRotation);
                WriteVector3(writer, demo.playerStartVelocity);

                // Write frames
                writer.Write((ushort)demo.frames.Length);
                foreach (var frame in demo.frames)
                {
                    WriteFrame(writer, frame);
                }

                // Write projectile events
                writer.Write((ushort)demo.projectileEvents.Length);
                foreach (var evt in demo.projectileEvents)
                {
                    WriteProjectileEvent(writer, evt);
                }

                // Write target events
                writer.Write((ushort)demo.targetEvents.Length);
                foreach (var evt in demo.targetEvents)
                {
                    WriteTargetEvent(writer, evt);
                }

                return ms.ToArray();
            }
        }

        /// <summary>
        /// Deserialize a demo file from binary format.
        /// </summary>
        public static DemoFile Deserialize(byte[] data)
        {
            if (data == null || data.Length == 0)
                throw new ArgumentException("Invalid demo data");

            using (MemoryStream ms = new MemoryStream(data))
            using (BinaryReader reader = new BinaryReader(ms))
            {
                DemoFile demo = new DemoFile();

                // Read header
                demo.header = ReadHeader(reader);

                // Read initial state
                demo.playerStartPosition = ReadVector3(reader);
                demo.playerStartRotation = ReadQuaternion(reader);
                demo.playerStartVelocity = ReadVector3(reader);

                // Read frames
                ushort frameCount = reader.ReadUInt16();
                demo.frames = new DemoFrame[frameCount];
                for (int i = 0; i < frameCount; i++)
                {
                    demo.frames[i] = ReadFrame(reader);
                }

                // Read projectile events
                ushort projectileEventCount = reader.ReadUInt16();
                demo.projectileEvents = new ProjectileEvent[projectileEventCount];
                for (int i = 0; i < projectileEventCount; i++)
                {
                    demo.projectileEvents[i] = ReadProjectileEvent(reader);
                }

                // Read target events
                ushort targetEventCount = reader.ReadUInt16();
                demo.targetEvents = new TargetEvent[targetEventCount];
                for (int i = 0; i < targetEventCount; i++)
                {
                    demo.targetEvents[i] = ReadTargetEvent(reader);
                }

                return demo;
            }
        }

        /// <summary>
        /// Save a demo file to disk.
        /// </summary>
        public static void SaveToFile(DemoFile demo, string filePath)
        {
            if (demo == null)
                throw new ArgumentNullException(nameof(demo));

            if (string.IsNullOrEmpty(filePath))
                throw new ArgumentException("Invalid file path");

            byte[] data = Serialize(demo);
            File.WriteAllBytes(filePath, data);

            Debug.Log($"[DemoSerializer] Saved demo to {filePath} ({data.Length} bytes)");
        }

        /// <summary>
        /// Load a demo file from disk.
        /// </summary>
        public static DemoFile LoadFromFile(string filePath)
        {
            if (!File.Exists(filePath))
                throw new FileNotFoundException($"Demo file not found: {filePath}");

            byte[] data = File.ReadAllBytes(filePath);
            DemoFile demo = Deserialize(data);

            Debug.Log($"[DemoSerializer] Loaded demo from {filePath} ({data.Length} bytes)");

            return demo;
        }

        // --- Helper methods for writing/reading specific types ---

        private static void WriteHeader(BinaryWriter writer, DemoHeader header)
        {
            writer.Write(DEMO_MAGIC_NUMBER);
            writer.Write(header.formatVersion);
            WriteString(writer, header.gameVersion);
            writer.Write(header.timestamp);
            WriteString(writer, header.description);
            writer.Write(header.totalFrames);
            writer.Write(header.projectileEvents);
            writer.Write(header.targetEvents);
            writer.Write(header.duration);
            writer.Write(header.checksum);
            WriteVector3(writer, header.playerStartPosition);
            WriteQuaternion(writer, header.playerStartRotation);
            WriteVector3(writer, header.playerStartVelocity);
        }

        private static DemoHeader ReadHeader(BinaryReader reader)
        {
            DemoHeader header = new DemoHeader();

            byte magic = reader.ReadByte();
            if (magic != DEMO_MAGIC_NUMBER)
                throw new InvalidDataException("Invalid demo file: magic number mismatch");

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

            return header;
        }

        private static void WriteFrame(BinaryWriter writer, DemoFrame frame)
        {
            writer.Write(frame.frameNumber);
            writer.Write(frame.timestamp);
            WriteVector3(writer, frame.position);
            WriteVector3(writer, frame.velocity);
            WriteQuaternion(writer, frame.rotation);
            writer.Write(frame.inputFlags);
            writer.Write(frame.mouseDeltaX);
            writer.Write(frame.mouseDeltaY);
            writer.Write(frame.jetpackFlags);
            writer.Write(frame.jetpackFuel);
        }

        private static DemoFrame ReadFrame(BinaryReader reader)
        {
            DemoFrame frame = new DemoFrame();
            frame.frameNumber = reader.ReadUInt16();
            frame.timestamp = reader.ReadSingle();
            frame.position = ReadVector3(reader);
            frame.velocity = ReadVector3(reader);
            frame.rotation = ReadQuaternion(reader);
            frame.inputFlags = reader.ReadByte();
            frame.mouseDeltaX = reader.ReadInt16();
            frame.mouseDeltaY = reader.ReadInt16();
            frame.jetpackFlags = reader.ReadByte();
            frame.jetpackFuel = reader.ReadSingle();
            return frame;
        }

        private static void WriteProjectileEvent(BinaryWriter writer, ProjectileEvent evt)
        {
            writer.Write((byte)evt.eventType);
            writer.Write(evt.timestamp);
            WriteVector3(writer, evt.position);
            WriteVector3(writer, evt.velocity);
            writer.Write(evt.projectileId);
            writer.Write(evt.weaponType);
            WriteVector3(writer, evt.surfaceNormal);
            writer.Write(evt.targetId);
        }

        private static ProjectileEvent ReadProjectileEvent(BinaryReader reader)
        {
            ProjectileEvent evt = new ProjectileEvent();
            evt.eventType = (ProjectileEventType)reader.ReadByte();
            evt.timestamp = reader.ReadSingle();
            evt.position = ReadVector3(reader);
            evt.velocity = ReadVector3(reader);
            evt.projectileId = reader.ReadUInt16();
            evt.weaponType = reader.ReadByte();
            evt.surfaceNormal = ReadVector3(reader);
            evt.targetId = reader.ReadUInt16();
            return evt;
        }

        private static void WriteTargetEvent(BinaryWriter writer, TargetEvent evt)
        {
            writer.Write((byte)evt.eventType);
            writer.Write(evt.timestamp);
            WriteVector3(writer, evt.position);
            WriteVector3(writer, evt.velocity);
            writer.Write(evt.targetId);
            writer.Write(evt.targetType);
            writer.Write(evt.health);
            writer.Write(evt.hasPeakPosition);
            WriteVector3(writer, evt.peakPosition);
        }

        private static TargetEvent ReadTargetEvent(BinaryReader reader)
        {
            TargetEvent evt = new TargetEvent();
            evt.eventType = (TargetEventType)reader.ReadByte();
            evt.timestamp = reader.ReadSingle();
            evt.position = ReadVector3(reader);
            evt.velocity = ReadVector3(reader);
            evt.targetId = reader.ReadUInt16();
            evt.targetType = reader.ReadByte();
            evt.health = reader.ReadSingle();
            evt.hasPeakPosition = reader.ReadBoolean();
            evt.peakPosition = ReadVector3(reader);
            return evt;
        }

        private static void WriteVector3(BinaryWriter writer, Vector3 v)
        {
            writer.Write(v.x);
            writer.Write(v.y);
            writer.Write(v.z);
        }

        private static Vector3 ReadVector3(BinaryReader reader)
        {
            return new Vector3(
                reader.ReadSingle(),
                reader.ReadSingle(),
                reader.ReadSingle()
            );
        }

        private static void WriteQuaternion(BinaryWriter writer, Quaternion q)
        {
            writer.Write(q.x);
            writer.Write(q.y);
            writer.Write(q.z);
            writer.Write(q.w);
        }

        private static Quaternion ReadQuaternion(BinaryReader reader)
        {
            return new Quaternion(
                reader.ReadSingle(),
                reader.ReadSingle(),
                reader.ReadSingle(),
                reader.ReadSingle()
            );
        }

        private static void WriteString(BinaryWriter writer, string s)
        {
            if (string.IsNullOrEmpty(s))
            {
                writer.Write((ushort)0);
            }
            else
            {
                byte[] bytes = Encoding.UTF8.GetBytes(s);
                writer.Write((ushort)bytes.Length);
                writer.Write(bytes);
            }
        }

        private static string ReadString(BinaryReader reader)
        {
            ushort length = reader.ReadUInt16();
            if (length == 0)
                return string.Empty;

            byte[] bytes = reader.ReadBytes(length);
            return Encoding.UTF8.GetString(bytes);
        }

        /// <summary>
        /// Get estimated file size for a demo file.
        /// </summary>
        public static int EstimateFileSize(DemoFile demo)
        {
            if (demo == null)
                return 0;

            int size = 0;

            // Header
            size += 1 + 4 + 8 + 64 + 64;  // magic + version + timestamp + mapName + gameMode
            size += 2 * 3 + 4 + 1 + 1;     // counts + duration + flags

            // Initial state
            size += 12 + 16 + 12;          // position + rotation + velocity

            // Frames
            size += demo.frames.Length * DemoFrame.Size;

            // Projectile events
            size += demo.projectileEvents.Length * ProjectileEvent.Size;

            // Target events
            size += demo.targetEvents.Length * TargetEvent.Size;

            return size;
        }
    }
}
