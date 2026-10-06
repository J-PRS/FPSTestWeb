# Tribes 1 Physics, Part Three: Collision | Andrew (floodyberry)

URL: https://floodyberry.wordpress.com/2008/04/11/tribes-1-physics-part-three-collision/
Published: 2008-04-11

Covers moving the player and what happens on contact — the most convoluted part of the physics.

## Warning — how Tribes actually moves

When Tribes attempts to move an object, it takes the maximum distance the object will cover in the remaining time (X), divides the remaining time by ceil(X) and does ceil(X) collision loops — ostensibly to ensure an object only moves 1m at a time.

Tribes does something a little weird on collisions: instead of adjusting the position to the collision point on a hit, Tribes adjusts the position based on the velocity no matter what. It moves the player, hits a surface, adjusts velocity from the collision, then moves the player from the ORIGINAL position based on the new velocity — usually bouncing the player slightly away from the contacted surface. The "correct" way feels slightly velcroish; the Tribes way feels more fluid.

## Collision Code

```
Player.UpdatePosition( float tickLen ) {
    float decayFriction = currentFriction * Physics.FRICTIONDECAY
    float lastSurfDirection = lastJumpableNormal.Dot( Gravity.upNormal )
    float timeLeft = tickLen
    int maxBumps = 4, bumps

    currentFriction = 0
    collisionLastTick = false

    for ( bumps = 0; ( bumps < maxBumps ) && ( timeLeft > 0 ); bumps++ ) {
        // slice fixup values
        Vector3 maxDistance = ( velocity * timeLeft )
        int iterations = ceil( UnitsToMeters( maxDistance.Length ) )
        float sliceTime = timeLeft / iterations

        // attempt to move through the world
        Vector3 originalPos = position, endPos = position + maxDistance
        moveFraction, finalPos, contactNormal = Physics.Translate( originalPos, endPos )

        // figure out how long we moved and adjust the remaining time
        float duration = timeLeft * moveFraction
        timeLeft -= duration
        position = finalPos

        // did we move the entire distance safely?
        if ( !timeLeft )
            break

        // collisionLastFrame gets set even if we step up and don't have an actual collision
        collisionLastFrame = true
        float surfDirection = contactNormal.Dot( Gravity.upNormal )

        if ( surfDirection < armor.JUMPSURFACE_MINDOT ) {
            // code to handle potentially stepping up sheer surfaces
            if ( steppedUp )
                continue
        }

        float impactDot = -velocity.Dot( contactNormal )

        // take damage if needed
        if ( UnitsToMeters( impactDot ) > armor.MINDAMAGESPEED )
            OnDamage( ( UnitsToMeters( impactDot ) - armor.MINDAMAGESPEED ) * armor.DAMAGESCALE )

        // if we hit a jumpable surface, update the jumpable normal and reset the timestamp
        if ( surfDirection >= armor.JUMPSURFACE_MINDOT ) {
            if ( ( lastJumpableNormalTimestamp > ( Physics.TICKBASE * 1000 ) ) ||
                 ( surfDirection < lastSurfDirection ) ) {
                lastSurfDirection = surfDirection
                lastJumpableNormalTimestamp = 0
                lastJumpableNormal = contactNormal
            }
        }

        // voodoo for tribes collision adjustments and timeslices
        int impactIterations = ceil( duration / sliceTime )
        float fullMotionTime = sliceTime * ( impactIterations - 1 )
        float fixupTime = duration - fullMotionTime
        position = originalPosition + ( velocity * fullMotionTime )

        // bounce
        Vector3 bounce = ( contactNormal * ( impactDot + MetersToUnits( Physics.ELASTICITY ) ) )
        velocity += bounce

        // readjust position based on bounced velocity
        position = Physics.Translate( position, position + ( velocity * fixupTime ) )

        // only update friction on upward facing surfaces
        if ( surfDirection > 0 ) {
            currentFriction = surfDirection

            if ( crawledToStop && ( velocity < MetersToUnits( Physics.MINSPEED ) ) ) {
                velocity = Vector3( 0, 0, 0 )
                position = originalPosition
                break
            }
        }
    }

    if ( bumps >= maxBumps ) {
        // Tribes sets the velocity to 0 here, this is where skibugs happen
    }

    if ( collisionLastFrame )
        currentFriction = Min( Max( currentFriction, decayFriction ), 1 )

    return ( collisionLastFrame )
}
```

## Notes

- **Ski bugs** are caused when the translation loop exceeds the max collisions — Tribes zeros velocity there. Just ignoring it and hoping the next tick dislodges the player works much better.
- `collisionLastFrame` gets set even if you merely step up — contact, not impact, is what counts.
- `currentFriction` decays via `FRICTIONDECAY (0.6)` each tick without ground contact — that decay IS skiing: while airborne or after jumping, traction fades and contacts no longer slow you. It is NOT "friction = 0".
