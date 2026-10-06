# Tribes 1 Physics, Part Four: Explosions | Andrew (floodyberry)

URL: https://floodyberry.wordpress.com/2008/04/29/tribes-1-physics-part-four-explosions/
Published: 2008-04-29

Explosions (knockback) — the final piece. If you implement the basic formula and disc-jump, you get a nice and wimpy boost. Playing with the knockback force only breaks explosions in new ways.

## Basic Knockback

```
Player.onExplosion( Vector3 explosion, float radius, float knockback, float damage ) {
    Vector3 distance = ( hitbox.center - explosion ), direction = distance.Normalize
    if ( distance.Length > radius )
        return

    float power = 1 - ( distance.Length / radius )
    ApplyDamage( power * damage )
    ApplyImpulse( knockback * ( power * direction ) / armor.Mass )
}
```

`power` should be an exponential falloff; linear is common because there is not much difference. It is also where Tribes deviates from the norm in a fairly big way.

## Tribes Knockback

The Tribes knockback up close (at your feet from a standstill) is actually WEAKER than from a bit of a distance (at your feet while you're in the air after jumping). Whether intended as an aid to disc jumping or an accident of a botched formula is impossible to say, but it would have been harder to gain speed from disc jumps without this odd feature.

Instead of `( 1 - ( d / r ) )`, Tribes uses `( ( d / Max( d - minHitboxDimension, 1 ) ) - ( d / r ) )` — weird calculations presumably trying to account for the hitbox. The power curve ramps UP over the smallest hitbox dimension before falling off — that's why a linear falloff can't be fixed by boosting knockback force without getting wildly inaccurate up close.

```
Player.onExplosion( Vector3 explosion, float radius, float knockback, float damage ) {
    Vector3 distance = ( hitbox.Center - explosion ), direction = distance.Normalize
    float minbox = Min( Min( hitbox.Width.x, hitbox.Width.y ), hitbox.Width.z )
    float d = Max( distance.Length - minbox, MetersToUnits( 1 ) )
    if ( d > radius )
        return

    float power = ( distance.Length / d ) - ( distance.Length / radius )
    ApplyDamage( damage * ( 1 - d / radius ) )
    ApplyImpulse( knockback * ( power * direction ) / armor.Mass )
}
```

For the Light Armor (BOX_WIDTH 0.5, BOX_DEPTH 0.5, BOX_HEIGHT 2.3), minbox = Min(0.5*2, 0.5*2, 2.3) = 1.0. The player origin is at the feet; width/depth extend in both directions and need doubling while height goes feet→head. Increasing the smallest hitbox dimension grows the ramp-up region — presumably to account for greater surface contact area with the explosion.

## Notes

- The author verified this full T1 physics running on Raindance in ET:QW (for the ET:QW Tribes mod) — the closest thing to Tribes seen in another engine.
