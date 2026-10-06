# Tribes 1 Physics, Part Two: Movement | Andrew

URL: https://floodyberry.wordpress.com/2008/02/24/tribes-1-physics-part-two-movement/
Published: 2008-02-24

Covers jumping, jetting, and ground movement/friction — ~90% of the "Tribes" feeling.

## Player.Tick

Takes user input (left, right, forward, back) and creates the speed vector for walking and the direction vector for jumping/jetting.

```
Player.Tick( Move move, int tickLenMs ) {
    float tickLen = ( 1000 / tickLenMs )

    float maxSpeed = MetersToUnits( armor.WALKSPEED )
    float forwardSpeed = MetersToUnits( armor.WALKSPEED ), sideSpeed = MetersToUnits( armor.WALKSPEED - 1 )

    move.speed = Vector3( ( move.right - move.left ) * forwardSpeed, ( move.forward - move.back ) * sideSpeed, 0 )
    if ( move.speed.Length > maxSpeed )
        move.speed *= ( maxSpeed / move.speed.Length )

    move.speed = self.ToWorldSpace( move.speed )
    move.direction = move.speed.Normalize
}
```

Then player energy is updated, lastJumpableNormalTimestamp is checked to see if a jump is allowed, then jumping, jetting, and walking run.

Notes:

- **Tribes lets you jump up to 256ms after your last ground contact**, allowing you to jump smoothly through little bumps where you technically leave the ground but don't appear to.
- Tribes handles jetpack energy so that around 5% the jets cut off and recharge a little, causing stutter.
- **Tribes applies gravity constantly** — it is not hacked off when resting on a surface.
- JETENERGY_CHARGE equals "8 + 3" with +3 being the energy pack recharge boost.

```
    bool isJetting = ( move.jetting && ( energy > 0 ) )
    bool isJumping = ( move.jumping && ( lastJumpableNormalTimestamp < Physics.MAXJUMPTICKS ) )

    // jump
    if ( isJumping )
        velocity += Jump( move.direction )
    crawlToStop = ( velocity.Length < MetersToUnits( Physics.CRAWLTOSTOP ) )

    // jets and acceleration
    accel = Gravity.force
    energy += ( armor.JETENERGY_CHARGE * tickLen )
    if ( isJetting ) {
        accel += Jet( move.direction, tickLen )
        energy -= ( armor.JETENERGY_DRAIN * tickLen )
    }
    energy.Clamp( 0, armor.MAXENERGY )
    velocity += ( accel / tickLen )

    // walking and friction
    if ( collisionLastTick )
        velocity += Friction( move.speed, tickLen )

    // update jumpableNormal timestamp and try to move
    lastJumpableNormalTimestamp += tickLenMs
    /* position, velocity = UpdatePosition( tickLen ) */
```

## Player.Jump

```
Player.Jump( Vector3 moveDirection ) {
    // need another ground contact before we can jump again
    lastJumpableNormalTimestamp = Physics.MAXJUMPTICKS

    // jump up
    float surfaceDirection = lastJumpableNormal.Dot( Gravity.upNormal )
    float impulse = MetersToUnits( armor.JUMPIMPULSE / armor.MASS )
    Vector3 jump = ( surfaceDirection * impulse ) * Gravity.upNormal

    // if we're moving away from the surface, jump away
    float orientation = lastJumpableNormal.Dot( moveDirection )
    if ( orientation > 0 )
        jump += ( impulse * orientation ) * moveDirection

    return ( jump )
}
```

## Player.Jet

Side jets only kick in if the player is holding a movement key AND it's been longer than MAXJUMPTICKS since the last ground contact. Jumping sets the timestamp to the limit, so jumping and jetting gives side jets immediately, while holding jets on the ground gives a startup of full jets regardless of direction keys.

```
Player.Jet( Vector3 moveDirection ) {
    float forwardVelocity = MetersToUnits( armor.JETFORWARD )
    float jetForce = MetersToUnits( armor.JETFORCE / armor.MASS )

    if ( ( lastJumpableNormalTimestamp >= Physics.MAXJUMPTICKS ) && ( moveDirection.Length != 0 ) ) {
        float sidePower
        float orientation = velocity.Dot( moveDirection )
        if ( orientation > forwardVelocity )
            sidePower = 0
        else if ( orientation < 0 )
            sidePower = armor.JETSIDEFORCE
        else
            sidePower = ( 1 - ( orientation / forwardVelocity ) )

        sidePower = Min( sidePower, armor.JETSIDEFORCE )
        Vector3 sideForce = ( sidePower * jetForce ) * moveDirection
        Vector3 upForce = ( ( 1 - sidePower ) * jetForce ) * Gravity.upNormal
        return ( upForce + sideForce )
    } else {
        // straight up, full jets
        return ( jetForce * Gravity.upNormal )
    }
}
```

## Vector.ProjectOntoPlane

```
Vector3.ProjectOntoPlane( Vector3 normal ) {
    this -= ( this.Dot( normal ) * normal )
}
```

## Player.Friction

Multiplying GROUNDTRACTION by currentFriction is NOT the magical "Friction = 0" that supposedly causes skiing. currentFriction decays every tick when there hasn't been ground contact — that's what lets you jet and slide against walls/ceilings without being slowed by contact friction.

```
Player.Friction( Vector3 moveSpeed, float tickLen ) {
    Vector3 dampen = ( moveSpeed - velocity )
    dampen.ProjectOntoPlane( Gravity.downNormal )

    float traction = Min( currentFriction * armor.GROUNDTRACTION, 1 )
    float force = ( MetersToUnits( armor.GROUNDFORCE / armor.MASS ) * traction * tickLen )
    if ( dampen.Length > force )
        dampen *= ( force / dampen.Length )
    else
        crawlToStop = true

    return ( dampen )
}
```
