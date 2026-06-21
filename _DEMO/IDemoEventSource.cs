using UnityEngine;

namespace DEMO
{
    /// <summary>
    /// Interface for recording projectile events.
    /// Game systems call these methods to notify the demo recorder.
    /// </summary>
    public interface IProjectileEventSource
    {
        /// <summary>
        /// Record a projectile fired event.
        /// </summary>
        void RecordProjectileFired(Vector3 position, Vector3 velocity, byte weaponType);

        /// <summary>
        /// Record a projectile bounce event.
        /// </summary>
        void RecordProjectileBounce(ushort projectileId, Vector3 position, Vector3 velocity, Vector3 surfaceNormal);

        /// <summary>
        /// Record a projectile hit event.
        /// </summary>
        void RecordProjectileHit(ushort projectileId, Vector3 position, ushort targetId);

        /// <summary>
        /// Record a projectile destroyed event.
        /// </summary>
        void RecordProjectileDestroyed(ushort projectileId, Vector3 position);

        /// <summary>
        /// Record projectile peak position (velocity.y sign change).
        /// Optional enhancement for precision.
        /// </summary>
        void RecordProjectilePeak(ushort projectileId, Vector3 peakPosition);
    }

    /// <summary>
    /// Interface for recording target events.
    /// Game systems call these methods to notify the demo recorder.
    /// </summary>
    public interface ITargetEventSource
    {
        /// <summary>
        /// Record a target spawned event.
        /// </summary>
        void RecordTargetSpawned(ushort targetId, Vector3 position, Vector3 velocity, byte targetType);

        /// <summary>
        /// Record a target bounce event.
        /// </summary>
        void RecordTargetBounce(ushort targetId, Vector3 position, Vector3 velocity);

        /// <summary>
        /// Record a target hit event.
        /// </summary>
        void RecordTargetHit(ushort targetId, Vector3 position, float health);

        /// <summary>
        /// Record a target destroyed event.
        /// </summary>
        void RecordTargetDestroyed(ushort targetId, Vector3 position);

        /// <summary>
        /// Record a target state changed event.
        /// </summary>
        void RecordTargetStateChanged(ushort targetId, byte newState);

        /// <summary>
        /// Record target peak position (velocity.y sign change).
        /// Optional enhancement for precision.
        /// </summary>
        void RecordTargetPeak(ushort targetId, Vector3 peakPosition);
    }
}
