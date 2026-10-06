# Tribes 1 Physics, Part One: Overview | Andrew (floodyberry)

URL: https://floodyberry.wordpress.com/2008/02/20/tribes-1-physics-part-one-overview/
Published: 2008-02-20

## Overview

Games have been trying replicate the feel of Tribes 1 for almost as long as it's been out (Tribes 2 started development in mid-1999) and every single one of them has failed, usually miserably.

- Tribes 2 physics are an abomination, although in hindsight it should have come as no surprise after the Base+ mod Dynamix play-tested in Tribes 1 to massive disdain.
- Legends has always felt wrong despite how often they tweaked and twiddled the physics and boasted of having the original physics source code.
- Tribes Vengeance is so far removed from the feel of Tribes that it shouldn't even enter the discussion. Jetting is wrong, air movement shouldn't even exist, collisions are wrong, and skiing is a sick joke.
- The yet-to-be-released Fallen Empire: Legions appears to be following the "We're not a Tribes 1 clone" mantra.

What all of these games ostensibly want is to appeal to Tribes 1 players, yet they attempt to accomplish this by using a different and/or completely arbitrary physics system, adding something that resembles a jetpack and skiing and hoping everyone likes it. Almost any Tribes 1 veteran will be unsatisfied with any Tribes style game that does not replicate the feel of Tribes 1.

These articles provide everything needed for a 99% re-creation of the Tribes 1 physics on any 3d engine.

## Basics

- All units are in meters, the default unit of Tribes. Use a conversion function (MetersToUnits / UnitsToMeters) to the engine's native units so the authentic Tribes 1 constants are used with nothing mis-scaled by hand.
- Tribes runs at **31.25 ticks a second (0.032s per tick)**. Altering the ticks per second results in slightly different physics: gravity accumulates per tick while jumping is a singular impulse, so as the tick length grows gravity slowly subsumes the jump impulse.
- Coordinate system is **Z up**.

## Physics Workflow

```
Tick( Move move, float ticklen ) {
    if ( jumping and canJump )
        velocity += Jump( move.direction )

    accel = Gravity.force
    if ( jetting )
        accel += Jet( move.direction )

    velocity += ( accel / ticklen )
    if ( collisionLastTick )
        velocity += Friction( move.speed, ticklen )

    position, velocity = UpdatePosition( ticklen )
}
```

There is nothing special in Tribes 1 physics — skiing is **not** achieved by "Friction = 0" — the only feature an engine needs is the ability to properly detect collisions. There are a lot of nuances required to achieve a simulation that doesn't feel subtly wrong, but none are of the earth-shatteringly unique variety.

## Structures

```
Gravity {
    Vector3 force = ( 0, 0, -20 )
    Vector3 upNormal = -force.Normalize
    Vector3 downNormal = force.Normalize
}

Physics {
    float TICKBASE = 0.032
    float ELASTICITY = 0.001
    float CRAWLTOSTOP = 0.1
    float MINSPEED = 0.75
    float FRICTIONDECAY = 0.6
    int MAXJUMPTICKS = 256   // ms — jump window after last ground contact
}

LightArmor : Armor {
    float MASS = 9
    float GROUNDFORCE = 9 * 40
    float GROUNDTRACTION = 3
    float WALKSPEED = 11
    float JUMPIMPULSE = 75
    float JUMPSURFACE_MINDOT = 0.2

    float MINDAMAGESPEED = 25
    float DAMAGESCALE = 0.005

    float JETFORCE = 236
    float JETSIDEFORCE = 0.8
    float JETFORWARD = 22
    float MAXENERGY = 60
    float JETENERGY_DRAIN = 25
    float JETENERGY_CHARGE = 8 + 3   // +3 = energy pack boost

    float BOX_WIDTH = 0.5
    float BOX_DEPTH = 0.5
    float BOX_HEIGHT = 2.3
}

Player {
    Armor armor
    Vector3 position, velocity
    float energy

    bool crawledToStop
    bool collisionLastTick
    Vector3 lastJumpableNormal
    int lastJumpableNormalTimestamp
    float currentFriction
}
```

---
