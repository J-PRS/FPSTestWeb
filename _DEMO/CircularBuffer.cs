using System;
using System.Collections.Generic;

namespace DEMO
{
    /// <summary>
    /// Generic circular buffer for efficient continuous recording.
    /// Automatically overwrites old data when full, maintaining a fixed-size window.
    /// Zero-allocation operation for maximum performance.
    /// </summary>
    /// <typeparam name="T">Type of data to store</typeparam>
    public class CircularBuffer<T>
    {
        private readonly T[] _buffer;
        private int _head;
        private int _tail;
        private int _count;
        private readonly int _capacity;

        public int Capacity => _capacity;
        public int Count => _count;
        public bool IsFull => _count == _capacity;
        public bool IsEmpty => _count == 0;

        public CircularBuffer(int capacity)
        {
            if (capacity <= 0)
                throw new ArgumentException("Capacity must be greater than 0", nameof(capacity));
            
            _capacity = capacity;
            _buffer = new T[capacity];
            _head = 0;
            _tail = 0;
            _count = 0;
        }

        /// <summary>
        /// Add an item to the buffer. Overwrites oldest if full.
        /// </summary>
        public void Add(T item)
        {
            _buffer[_head] = item;
            _head = (_head + 1) % _capacity;
            
            if (_count < _capacity)
            {
                _count++;
            }
            else
            {
                // Buffer is full, tail moves forward (overwrites oldest)
                _tail = (_tail + 1) % _capacity;
            }
        }

        /// <summary>
        /// Get item at specific index (0 = oldest, Count-1 = newest).
        /// </summary>
        public T Get(int index)
        {
            if (index < 0 || index >= _count)
                throw new IndexOutOfRangeException($"Index {index} out of range [0, {_count - 1}]");
            
            int actualIndex = (_tail + index) % _capacity;
            return _buffer[actualIndex];
        }

        /// <summary>
        /// Get item without bounds checking (for performance).
        /// </summary>
        public T GetUnsafe(int index)
        {
            int actualIndex = (_tail + index) % _capacity;
            return _buffer[actualIndex];
        }

        /// <summary>
        /// Peek at the newest item without removing it.
        /// </summary>
        public T PeekNewest()
        {
            if (_count == 0)
                throw new InvalidOperationException("Buffer is empty");
            
            int newestIndex = (_head - 1 + _capacity) % _capacity;
            return _buffer[newestIndex];
        }

        /// <summary>
        /// Peek at the oldest item without removing it.
        /// </summary>
        public T PeekOldest()
        {
            if (_count == 0)
                throw new InvalidOperationException("Buffer is empty");
            
            return _buffer[_tail];
        }

        /// <summary>
        /// Clear the buffer.
        /// </summary>
        public void Clear()
        {
            _head = 0;
            _tail = 0;
            _count = 0;
        }

        /// <summary>
        /// Extract a range of items as an array.
        /// </summary>
        /// <param name="startIndex">Start index (0 = oldest)</param>
        /// <param name="length">Number of items to extract</param>
        public T[] ExtractRange(int startIndex, int length)
        {
            if (startIndex < 0 || startIndex >= _count)
                throw new IndexOutOfRangeException($"Start index {startIndex} out of range");
            
            if (length <= 0 || startIndex + length > _count)
                throw new ArgumentException($"Invalid length {length} for range starting at {startIndex}");
            
            T[] result = new T[length];
            for (int i = 0; i < length; i++)
            {
                result[i] = Get(startIndex + i);
            }
            return result;
        }

        /// <summary>
        /// Extract the newest N items.
        /// </summary>
        public T[] ExtractNewest(int count)
        {
            if (count > _count)
                count = _count;
            
            return ExtractRange(_count - count, count);
        }

        /// <summary>
        /// Extract all items and clear the buffer.
        /// </summary>
        public T[] ExtractAll()
        {
            T[] result = ExtractRange(0, _count);
            Clear();
            return result;
        }

        /// <summary>
        /// Copy buffer contents to a target array.
        /// More efficient than ExtractRange for large operations.
        /// </summary>
        public void CopyTo(T[] target, int targetOffset, int startIndex, int length)
        {
            if (target == null)
                throw new ArgumentNullException(nameof(target));
            
            if (startIndex < 0 || startIndex >= _count)
                throw new IndexOutOfRangeException($"Start index {startIndex} out of range");
            
            if (length <= 0 || startIndex + length > _count)
                throw new ArgumentException($"Invalid length {length} for range starting at {startIndex}");
            
            if (targetOffset + length > target.Length)
                throw new ArgumentException("Target array too small");
            
            for (int i = 0; i < length; i++)
            {
                target[targetOffset + i] = Get(startIndex + i);
            }
        }

        /// <summary>
        /// Get the index of the newest item that is older than a given timestamp.
        /// Assumes items are added in chronological order.
        /// </summary>
        /// <param name="timestamp">Timestamp to compare against</param>
        /// <param name="timestampSelector">Function to extract timestamp from T</param>
        /// <returns>Index of the oldest item newer than timestamp, or -1 if none</returns>
        public int FindIndexAfterTimestamp(float timestamp, Func<T, float> timestampSelector)
        {
            for (int i = 0; i < _count; i++)
            {
                if (timestampSelector(GetUnsafe(i)) > timestamp)
                {
                    return i;
                }
            }
            return -1;
        }
    }
}
