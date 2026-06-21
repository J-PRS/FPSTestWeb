using UnityEngine;
using System;
using System.Collections.Generic;

namespace DEMO
{
    /// <summary>
    /// Detects "cool hits" worthy of demo clip extraction.
    /// Evaluates hits based on distance, velocity, prediction accuracy, and other criteria.
    /// </summary>
    public class CoolHitDetector : MonoBehaviour
    {
        [Header("Detection Thresholds")]
        [SerializeField] private float longRangeDistance = 100f;      // Distance threshold for "long range"
        [SerializeField] private float highVelocityThreshold = 50f;  // Velocity threshold for "high speed"
        [SerializeField] private float predictionThreshold = 2f;      // Lead distance for "prediction shot"
        [SerializeField] private int minBouncesForCool = 2;          // Minimum bounces for "bank shot"

        [Header("Clip Settings")]
        [SerializeField] private float clipBeforeHit = 2f;            // Seconds before hit to include
        [SerializeField] private float clipAfterHit = 1f;             // Seconds after hit to include
        [SerializeField] private int maxClipsPerSession = 20;         // Limit number of clips per session

        private DemoRecorder _recorder;
        private List<DemoClip> _detectedClips;
        private int _clipsThisSession;

        public event Action<DemoClip> OnCoolHitDetected;

        public int DetectedClipCount => _detectedClips.Count;
        public DemoClip[] DetectedClips => _detectedClips.ToArray();

        private void Awake()
        {
            _detectedClips = new List<DemoClip>();
            _clipsThisSession = 0;
        }

        private void Start()
        {
            _recorder = FindAnyObjectByType<DemoRecorder>();
            if (_recorder == null)
            {
                Debug.LogWarning("[CoolHitDetector] No DemoRecorder found");
            }
        }

        /// <summary>
        /// Evaluate a projectile hit and determine if it's "cool".
        /// </summary>
        public bool EvaluateHit(ProjectileEvent hitEvent, ProjectileEvent fireEvent, int bounceCount)
        {
            if (hitEvent.eventType != ProjectileEventType.Hit)
                return false;

            CoolHitCriteria criteria = new CoolHitCriteria
            {
                distance = Vector3.Distance(fireEvent.position, hitEvent.position),
                impactVelocity = hitEvent.velocity.magnitude,
                bounceCount = bounceCount,
                predictionScore = CalculatePredictionScore(fireEvent, hitEvent),
                movingTarget = false,  // TODO: Detect if target was moving
                timeToHit = hitEvent.timestamp - fireEvent.timestamp
            };

            bool isCool = IsCoolHit(criteria);

            if (isCool)
            {
                string description = GenerateHitDescription(criteria);
                ExtractClip(hitEvent.timestamp, description, criteria);
            }

            return isCool;
        }

        /// <summary>
        /// Calculate prediction score based on how much the shooter had to lead the target.
        /// </summary>
        private float CalculatePredictionScore(ProjectileEvent fireEvent, ProjectileEvent hitEvent)
        {
            // Simple estimation: distance between fire position and hit position
            // In a full implementation, this would compare against target position at fire time
            Vector3 displacement = hitEvent.position - fireEvent.position;
            return displacement.magnitude;
        }

        /// <summary>
        /// Determine if a hit meets the criteria for a "cool shot".
        /// </summary>
        private bool IsCoolHit(CoolHitCriteria criteria)
        {
            // Long range shot
            if (criteria.distance >= longRangeDistance)
                return true;

            // High velocity impact
            if (criteria.impactVelocity >= highVelocityThreshold)
                return true;

            // Bank shot (multiple bounces)
            if (criteria.bounceCount >= minBouncesForCool)
                return true;

            // Prediction shot (significant lead)
            if (criteria.predictionScore >= predictionThreshold)
                return true;

            // Moving target hit
            if (criteria.movingTarget)
                return true;

            return false;
        }

        /// <summary>
        /// Generate a human-readable description for the cool hit.
        /// </summary>
        private string GenerateHitDescription(CoolHitCriteria criteria)
        {
            List<string> tags = new List<string>();

            if (criteria.distance >= longRangeDistance)
                tags.Add($"Long Range ({criteria.distance:F0}m)");

            if (criteria.impactVelocity >= highVelocityThreshold)
                tags.Add($"High Speed ({criteria.impactVelocity:F0} m/s)");

            if (criteria.bounceCount >= minBouncesForCool)
                tags.Add($"Bank Shot ({criteria.bounceCount} bounces)");

            if (criteria.predictionScore >= predictionThreshold)
                tags.Add("Prediction Shot");

            if (criteria.movingTarget)
                tags.Add("Moving Target");

            if (tags.Count == 0)
                return "Cool Hit";

            return string.Join(" + ", tags);
        }

        /// <summary>
        /// Extract a clip around the cool hit.
        /// </summary>
        private void ExtractClip(float hitTimestamp, string description, CoolHitCriteria criteria)
        {
            if (_clipsThisSession >= maxClipsPerSession)
            {
                Debug.LogWarning("[CoolHitDetector] Max clips per session reached");
                return;
            }

            if (_recorder != null)
            {
                _recorder.ExtractClipAroundEvent(hitTimestamp, clipBeforeHit, clipAfterHit, description);
            }

            DemoClip clip = new DemoClip
            {
                startTime = hitTimestamp - clipBeforeHit,
                endTime = hitTimestamp + clipAfterHit,
                startFrameIndex = 0,  // Will be set by recorder
                endFrameIndex = 0,
                description = description
            };

            _detectedClips.Add(clip);
            _clipsThisSession++;

            OnCoolHitDetected?.Invoke(clip);

            Debug.Log($"[CoolHitDetector] Cool hit detected: {description}");
        }

        /// <summary>
        /// Reset clip counter for new session.
        /// </summary>
        public void ResetSession()
        {
            _clipsThisSession = 0;
            _detectedClips.Clear();
        }

        /// <summary>
        /// Criteria data structure for hit evaluation.
        /// </summary>
        private struct CoolHitCriteria
        {
            public float distance;
            public float impactVelocity;
            public int bounceCount;
            public float predictionScore;
            public bool movingTarget;
            public float timeToHit;
        }
    }
}
