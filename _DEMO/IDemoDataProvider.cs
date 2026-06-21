using UnityEngine;

namespace DEMO
{
    /// <summary>
    /// Interface for providing player state data to the demo recorder.
    /// Game systems implement this to feed data without direct coupling.
    /// </summary>
    public interface IPlayerDataProvider
    {
        /// <summary>
        /// Current player position.
        /// </summary>
        Vector3 Position { get; }
        
        /// <summary>
        /// Current player velocity.
        /// </summary>
        Vector3 Velocity { get; }
        
        /// <summary>
        /// Current player rotation.
        /// </summary>
        Quaternion Rotation { get; }
    }

    /// <summary>
    /// Interface for providing input state data to the demo recorder.
    /// Game systems implement this to feed input data without direct coupling.
    /// </summary>
    public interface IInputProvider
    {
        /// <summary>
        /// Current input flags as bitmask.
        /// </summary>
        byte InputFlags { get; }
        
        /// <summary>
        /// Current mouse delta X.
        /// </summary>
        float MouseDeltaX { get; }
        
        /// <summary>
        /// Current mouse delta Y.
        /// </summary>
        float MouseDeltaY { get; }
        
        /// <summary>
        /// Current jetpack flags as bitmask.
        /// </summary>
        byte JetpackFlags { get; }
        
        /// <summary>
        /// Current jetpack fuel level.
        /// </summary>
        float JetpackFuel { get; }
    }
}
