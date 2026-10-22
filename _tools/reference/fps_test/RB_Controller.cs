using System.Collections;
using System.Collections.Generic;
using UnityEngine;

public class RB_Controller : MonoBehaviour
{
    [SerializeField] private bool controller_enabled = true;
    [SerializeField] private float max_velocity_ground = 7f;
    [SerializeField] private float max_passive_airvel = 10f;
    [SerializeField] private float ground_accelerate = 200f;
    [SerializeField] private float ground_friction = 50f;
    [SerializeField] private float stop_treshold = 1f;
    // [SerializeField] private float max_velocity_air = 12f;
    [SerializeField] private float terminal_velocity = 100f;
    [SerializeField] private float skii_control = 0.5f;
    [SerializeField] private float skii_sticky_treshold = 1f;
    [SerializeField] private float skii_sticky_lift = 0.51f;
    [SerializeField] private float skii_target_distance = 0.5f;
    [SerializeField] private float skii_uplift = 50f;
    [SerializeField] private float skii_downlift = 50f;
    [SerializeField] private float skii_lift_cutoff = 5f;
    [SerializeField] private float skii_boost = 25f;
    [SerializeField] private float skii_boost_treshold = 15f;
    [SerializeField] private float air_control = 0.2f;
    [SerializeField] private float groundedTimeBuffer = 0.25f;
    [SerializeField] private float jump_speed = 4f;
    [SerializeField] private bool autoHop = true;
    [HideInInspector] public float xMouseSensitivity = 1.0f;
    [HideInInspector] public float yMouseSensitivity = 1.0f;
    private Transform playerView;
    private float rotX = 0.0f;
    private float rotY = 0.0f;
    public Keybinds keybinds;
    [SerializeField] ParticleSystem skiiParticle;
    [SerializeField] AudioSource skiiSound;
    [SerializeField] AudioSource boostAS;
    [SerializeField] float skiiSoundVolume = 0.02f;
    [SerializeField] float skiiSoundVolumeRate = 0.5f;
    [SerializeField] AudioSource walkingSound;
    [SerializeField] AudioSource jumpSound;
    [SerializeField] AudioClip[] stepAudioClips;
    [SerializeField] AudioClip[] jumpAudioClips;
    [SerializeField] AudioClip skiiBoostSound;
    [SerializeField] float walkingSoundVolume = 1f;
    [SerializeField] float walkingSoundVolumeRate = 10f;
    [SerializeField] float stepInterval = 0.3f;
    [SerializeField] float jumpInterval = 0.2f;
    public static Rigidbody playerRB;
    private bool wishJump = false;
    private bool skiiInput = false;
    private bool groundedBufferedByTime = false;
    private bool groundedBufferedByDistance = false;
    private bool skiiBufferedByTime = false;
    private float groundedTimer;
    private jetpack_script jet;
    private bool grounded;
    private bool anyGrounded;
    private Vector3 lastJumpableNormal;
    private float stepTimer;
    private float jumpTimer;
    private bool skiiBoostDone;
    private bool jetJumpDone;
    Vector3 jetVector;
    Vector3 input;
    Vector3 currentVelocity;
    Vector3 lastFramePosition;
    bool allowNextJump = true;
    float timescale;
    public static RB_Controller instance;
    private bool skiiParticleisPlaying = false;
    void Start()
    {
        instance = this;
        playerRB = GetComponent<Rigidbody>();
        playerView = Camera.main.transform;
        jet = GetComponent<jetpack_script>();
        groundedTimer += groundedTimeBuffer + 1f;
    }

    public void Unground()
    {
        allowNextJump = false;
        grounded = false;
        groundedBufferedByTime = false;
        groundedBufferedByDistance = false;
        groundedTimer += groundedTimeBuffer;
    }

    public bool ControllerState()
    {
        return controller_enabled;
    }

    // Update is called once per frame
    void Update()
    {
        MouseInput();
        jetVector = jet.JetMovement();
        input = GetInputAxes();
        JumpInput();
        SkiiInput();

        if (!grounded)
            groundedTimer += Time.deltaTime;

        groundedBufferedByDistance = CheckIfGrounded();
        groundedBufferedByTime = groundedTimer <= groundedTimeBuffer;
        skiiBufferedByTime = skiiInput && groundedBufferedByTime;
        anyGrounded = grounded || groundedBufferedByTime || groundedBufferedByDistance;
        stepTimer += Time.deltaTime;
        jumpTimer += Time.deltaTime;

        if (Input.GetKeyUp(keybinds.keybindsProfile.skiiString))
        {
            skiiBoostDone = false;
        }

#if UNITY_EDITOR
        if (Input.GetKeyDown(KeyCode.Z))
        {
            timescale = 0.1f;
            timescale = Mathf.Clamp01(timescale + 0.01f);
            if (timescale != Time.timeScale)
            {
                Time.timeScale = timescale;
                Time.fixedDeltaTime = 0.02F * Time.timeScale;
            }
        }
        else if (Input.GetKeyUp(KeyCode.Z))
        {
            timescale = 1f;
            timescale = Mathf.Clamp01(timescale);
            if (timescale != Time.timeScale)
            {
                Time.timeScale = timescale;
                Time.fixedDeltaTime = 0.02F * Time.timeScale;
            }
        }
#endif

        if (GlobalModifiers.jetJump)
        if (jetVector != Vector3.zero)
        if (!skiiInput)
        {
            wishJump = true;
        }

        if (GlobalModifiers.jetJump)
        if (Input.GetKeyDown(keybinds.keybindsProfile.jetString))
        {
            wishJump = true;
        }

        if (allowNextJump)
        if (anyGrounded && wishJump)
        {
            Unground();
            Jump();
        }

        if (anyGrounded && jetVector == Vector3.zero)
        {
            GameStats.groundTime += Time.deltaTime;
        }
    }
    void LateUpdate()
    {
        MovementFX();
        // MouseInput();

        Vector3 displacement = transform.position - lastFramePosition;
        currentVelocity = displacement / Time.deltaTime;
        lastFramePosition = transform.position;
    }

    void FixedUpdate()
    {
        playerRB.AddForce(GlobalModifiers.playerGravity * Time.fixedDeltaTime * Vector3.down, ForceMode.VelocityChange);
        playerRB.AddForce(jetVector, ForceMode.VelocityChange);
        // Vector3 dampen = (input * 50f - playerRB.velocity) * Time.fixedDeltaTime;

        if (grounded && jetVector == Vector3.zero && !wishJump)
        {
            if (!skiiInput)
            {
                // playerRB.AddForce(dampen, ForceMode.VelocityChange);
                // Vector3 wishSpeed = GetInputAxesNonNormalized() * speed;

                if (input != Vector3.zero)
                {
                    playerRB.AddForce(ground_accelerate * Time.fixedDeltaTime * input, ForceMode.VelocityChange);
                }
                else
                {
                    if (playerRB.linearVelocity.magnitude > stop_treshold)
                    {
                        playerRB.AddForce(-1f * ground_friction * Time.fixedDeltaTime * playerRB.linearVelocity.normalized, ForceMode.VelocityChange);
                    }
                    else
                    {
                        playerRB.Sleep();
                    }
                }

                if (input != Vector3.zero)
                    SoftSpeedCap();
                
                    // playerRB.velocity = HardSpeedCap(playerRB.velocity, max_velocity_ground);
            }

            SkiAccel();
        }
        
        LegionsLikeSkiing();

        if (grounded && skiiInput || groundedBufferedByTime && skiiInput  || groundedBufferedByDistance && skiiInput)
        {
            if (!wishJump)
            {
                playerRB.linearVelocity = VectorShiftLateral(playerRB.linearVelocity, GetInputAxesNonNormalized() * skii_control, true);

                SkiBoost();

                GameStats.skiTime += Time.fixedDeltaTime;
            }
        }
        else
        if (!grounded && !groundedBufferedByTime)
        {
            // if (HorizontalVelocityMagnitude() <= max_passive_airvel)
                playerRB.linearVelocity = VectorShiftLateral(playerRB.linearVelocity, input * air_control, true);
            // else
            //     playerRB.velocity = VectorShiftLateral(playerRB.velocity, input * air_control, true);

            TerminalVelocity(terminal_velocity);
            GameStats.airTime += Time.fixedDeltaTime;
        }

        GameStats.totalDistanceTraveled += Time.fixedDeltaTime * playerRB.linearVelocity.magnitude;
        GameStats.verticalDistanceTraveled += Time.fixedDeltaTime * Mathf.Abs(playerRB.linearVelocity.y);
        GameStats.horizontalDistanceTraveled += Time.fixedDeltaTime * new Vector3(playerRB.linearVelocity.x, 0f, playerRB.linearVelocity.z).magnitude;
    }
    public float HorizontalVelocityMagnitude()
    {
        return new Vector2(playerRB.linearVelocity.x, playerRB.linearVelocity.z).magnitude;
    }
    void TerminalVelocity(float terminal_velocity)
    {
        if (playerRB.linearVelocity.y < -1f * terminal_velocity)
        {
            playerRB.linearVelocity = new Vector3(playerRB.linearVelocity.x, -1f * terminal_velocity, playerRB.linearVelocity.z); 
        }
    }
    void LegionsLikeSkiing()
    {
        if (GlobalModifiers.smootherSki)
        if (jetVector == Vector3.zero)
        if (skiiInput && groundedBufferedByDistance || skiiInput && groundedBufferedByTime)
        {
            float startingMagnitude = playerRB.linearVelocity.magnitude;

            float distanceDifference = skii_target_distance - DistanceToGround();
            float skiiLift = 1f;

            if (Mathf.Abs(playerRB.linearVelocity.y) < skii_lift_cutoff)
            {
                if (distanceDifference > 0)
                {
                    skiiLift = distanceDifference * skii_uplift;
                }
                else
                {
                    skiiLift = distanceDifference * skii_downlift;
                }
            }

            Vector3 force = skiiLift * Time.fixedDeltaTime * Vector3.up;
            playerRB.AddForce(force, ForceMode.VelocityChange);

            playerRB.linearVelocity = playerRB.linearVelocity.normalized * startingMagnitude;
        }
    }
    void SkiAccel()
    {
        if (skiiInput)
        if (GlobalModifiers.skiiAccel)
        {
            if (GetInputAxes() != Vector3.zero)
            if (playerRB.linearVelocity.magnitude <= max_velocity_ground * 3f)
            {
                playerRB.AddForce(0.2f * ground_accelerate * Time.fixedDeltaTime * GetInputAxes(), ForceMode.VelocityChange);
            }
        }
    }
    void SkiBoost()
    {
        if (!skiiBoostDone)
        if (GlobalModifiers.skiiBoost)
        if (Input.GetKey(keybinds.keybindsProfile.skiiString))
        if (playerRB.linearVelocity.magnitude <= skii_boost_treshold)
        // if (playerRB.velocity.magnitude >= max_velocity_ground * 0.5f)
        // if (Vector3.Dot(playerRB.velocity, input) > 0)
        {
                // if (skiiBoostSound != null)
                //     boostAS.PlayOneShot(skiiBoostSound, 0.5f);
                    
            if (GetInputAxes() != Vector3.zero)
                playerRB.linearVelocity = input * skii_boost;
            else
            {
                Vector3 cameraForward = Camera.main.transform.forward;
                cameraForward.y = 0;
                cameraForward.Normalize();
                playerRB.linearVelocity = cameraForward * skii_boost;
            }
                
                skiiBoostDone = true;
        }        
    }
    void OnGUI()
    {
        return;
        // Calculate the position for the first line of debug text above the center of the screen
        float lineHeight = GUI.skin.label.CalcSize(new GUIContent("Debug")).y; // Calculate the height of a single line of text
        float totalHeight = 3 * lineHeight; // Total height for 3 lines of text
        Vector2 startingPosition = new Vector2((Screen.width - 200) / 2, (Screen.height - totalHeight) / 2); // Adjust the starting position for multiple lines

        // First line of debug text
        string debugString1 = DistanceToGround().ToString("F2");
        GUI.Label(new Rect(startingPosition.x, startingPosition.y, 200, lineHeight), debugString1);

        // Second line of debug text
        string debugString2 = playerRB.linearVelocity.y.ToString("F2");
        GUI.Label(new Rect(startingPosition.x, startingPosition.y + lineHeight, 200, lineHeight), debugString2);

        // Third line of debug text
        string debugString3 = "More debug info";
        GUI.Label(new Rect(startingPosition.x, startingPosition.y + 2 * lineHeight, 200, lineHeight), debugString3);
    }
    Vector3 VectorShift(Vector3 initialVector, Vector3 shiftVector, bool preserveY = false)
    {
        float startingY = initialVector.y;
        Vector3 finalVector;
        // float startingMagnitude = initialVector.magnitude;
        float startingMagnitude = Mathf.Max(initialVector.magnitude, max_passive_airvel);
        Vector3 combinedVector = initialVector + shiftVector;
        
        if (combinedVector.magnitude > startingMagnitude)
            finalVector = combinedVector.normalized * startingMagnitude;
        else
            finalVector = combinedVector;

        if (GlobalModifiers.jetUpModifier != 1f || GlobalModifiers.jetLateralModifier != 0.2f || preserveY)
            finalVector = new(finalVector.x, startingY, finalVector.z);

        return finalVector;
    }

    Vector3 VectorShiftLateral(Vector3 initialVector, Vector3 shiftVector, bool preserveY = false)
    {
        float startingY = initialVector.y;
        initialVector.y = 0f;
        Vector3 finalVector;
        // float startingMagnitude = initialVector.magnitude;
        float startingMagnitude = Mathf.Max(initialVector.magnitude, max_passive_airvel);
        Vector3 combinedVector = initialVector + shiftVector;
        
        if (combinedVector.magnitude > startingMagnitude)
            finalVector = combinedVector.normalized * startingMagnitude;
        else
            finalVector = combinedVector;

        // if (GlobalModifiers.jetUpModifier != 1f || GlobalModifiers.jetLateralModifier != 0.2f || preserveY)
        finalVector = new(finalVector.x, startingY, finalVector.z);

        return finalVector;
    }

    Vector3 HardSpeedCap(Vector3 velocity, float limit)
    {
        if (velocity.magnitude > limit)
        {
            velocity = velocity.normalized * limit;
        }

        return velocity;
    }

    void SoftSpeedCap()
    {
        if (playerRB.linearVelocity.magnitude > max_velocity_ground)
            playerRB.linearVelocity = 0.64f * playerRB.linearVelocity;
    }

    public Vector3 GetInputAxes()
    {
        Vector3 wishdir = new(keybinds.horizontalAxis, 0, keybinds.verticalAxis);
        wishdir = playerView.TransformDirection(wishdir);
        wishdir.y = 0f;
        wishdir = wishdir.normalized;
        return wishdir;
    }
    public Vector3 GetInputAxesNonNormalized()
    {
        Vector3 wishdir = new Vector3(keybinds.horizontalAxis, 0, keybinds.verticalAxis);
        wishdir = playerView.TransformDirection(wishdir);
        wishdir.y = 0f;
        return wishdir;
    }
    float DistanceToGround(float offset = 1f)
    {
        float distanceToFeet = 100f;

        int terrainLayerMask = 1 << 10; // Shift the bit corresponding to layer 10

        // Cast a ray from the position with the offset downward to the terrain layer
        if (Physics.Raycast(transform.position + Vector3.up * offset, Vector3.down, out RaycastHit hit, 10000f, terrainLayerMask))
        {
            // Calculate the distance between the position and the point of contact with the terrain
            distanceToFeet = transform.position.y - hit.point.y - offset;
        }

        return distanceToFeet;
    }
    bool CheckIfGrounded(float groundedThreshold = 0.5f, float offset = 1f)
    {
        if (!skiiInput)
            return DistanceToGround(offset) < groundedThreshold;
        else
            return DistanceToGround(offset) < groundedThreshold + skii_target_distance;
    }
    void OnCollisionEnter(Collision hit)
    {
        if (hit.gameObject.CompareTag("World"))
        {
            grounded = true;
            allowNextJump = true;

            foreach (ContactPoint contact in hit.contacts)
            {
                lastJumpableNormal = contact.normal;
            }
        }

        if (wishJump)
        {

        }

        if (skiiInput)
        {

        }

        groundedTimer = 0f;
    }

    void OnCollisionExit(Collision hit) 
    {
        if (hit.gameObject.CompareTag("World"))
        {
            grounded = false;
        }
    }

    void OnCollisionStay(Collision hit)
    {
        if (hit.gameObject.CompareTag("World"))
        {
            grounded = true;
            allowNextJump = true;

            foreach (ContactPoint contact in hit.contacts)
            {
                lastJumpableNormal = contact.normal;
            }
        }

        // if (wishJump)
        // {
        //     Jump();
        // }
    }

    private void Jump()
    {
        playerRB.AddForce(PlayerJump(GetInputAxes()), ForceMode.VelocityChange);

        if (jumpTimer > jumpInterval)
        {
            PlayOneOfClips(jumpSound, jumpAudioClips);
            jumpTimer = 0f;
        }

        GameStats.jumps++;
    }
    public static float CalculateSensitivity(float distance, float dpi, bool isInches = false)
    {
        float factor = isInches ? 2.54f : 1f; // Convert inches to centimeters if necessary
        float sensitivity = 360 / (distance * factor * 2 * Mathf.PI * dpi);
        return sensitivity;
    }

    private void MouseInput(float multiplier = 1f)
    {
        if (Time.timeScale == 0)
        {
            return;
        }

        yMouseSensitivity = SettingsData.setting_sens;
        xMouseSensitivity = SettingsData.setting_sens;

        // yMouseSensitivity = CalculateSensitivity(10, 800) * 10000;
        // xMouseSensitivity = yMouseSensitivity;

        if (SettingsData.invert_y)
        { yMouseSensitivity *= -1; }

        /* Camera rotation stuff, mouse controls this shit */
        // rotX -= Input.GetAxisRaw("Mouse Y") * yMouseSensitivity * Time.deltaTime * 2.4f;
        // rotY += Input.GetAxisRaw("Mouse X") * xMouseSensitivity * Time.deltaTime * 2.4f;
        rotX -= Input.GetAxisRaw("Mouse Y") * yMouseSensitivity * 0.02f * multiplier;
        rotY += Input.GetAxisRaw("Mouse X") * xMouseSensitivity * 0.02f * multiplier;

        float maximumXRot = 89f;
        // Clamp the X rotation
        if (rotX < -maximumXRot)
            rotX = -maximumXRot;
        else if (rotX > maximumXRot)
            rotX = maximumXRot;

        // playerRB.MoveRotation(Quaternion.Euler(0, rotY, 0));
        // transform.rotation = Quaternion.Euler(0, rotY, 0); // Rotates the collider
        // playerView.rotation = Quaternion.Euler(0, rotY, 0); // Rotates the collider
        
        playerView.rotation = Quaternion.Euler(rotX, rotY, 0); // Rotates the camera
        // Quaternion targetRotation = Quaternion.Euler(rotX, rotY, 0);
        // playerView.rotation = Quaternion.Lerp(playerView.rotation, targetRotation, 0.5f);
    }

    Vector3 PlayerJump(Vector3 moveDirection)
    {
        float impulse = jump_speed;
        float surfaceDirection = Vector3.Dot(lastJumpableNormal, Vector3.up);
        float orientation = Vector3.Dot(lastJumpableNormal, moveDirection);
        Vector3 jump = impulse * surfaceDirection * Vector3.up;
        
        if (moveDirection == Vector3.zero)
        {
            // Vector3 rightVector = Vector3.Cross(lastJumpableNormal, Vector3.up);
            // Vector3 slope = Quaternion.AngleAxis(-90f, rightVector) * lastJumpableNormal;
            // Vector3 horizontalSlope = new(slope.x, 0f, slope.z);
           
            // Vector3 horizontalSlope = new(lastJumpableNormal.x, 0f, lastJumpableNormal.z);
            // float noMoveOrientation = 1 - surfaceDirection;
            // jump += impulse * noMoveOrientation * horizontalSlope.normalized;
            jump += impulse * new Vector3(lastJumpableNormal.x, 0f, lastJumpableNormal.z);
        }
        else
        if (orientation > 0)
        {
            jump += impulse * orientation * moveDirection;
        }

        return jump;
    }

    void MovementFX()
    {
        if (
        groundedBufferedByDistance && 
        !skiiInput && 
        playerRB.linearVelocity.magnitude <= 20f && 
        playerRB.linearVelocity.magnitude >= 4f && 
        GetInputAxes() != Vector3.zero &&
        stepTimer >= stepInterval)
        {
            walkingSound.PlayOneShot(stepAudioClips[Random.Range(0, stepAudioClips.Length)], Random.Range(0.8f, 1.2f));
            stepTimer = 0f;
        }

        if (skiiInput && groundedBufferedByTime || skiiInput && groundedBufferedByDistance)
        {
            if (!wishJump)
            {
                skiiSound.volume += skiiSoundVolumeRate * Time.deltaTime;
                skiiSound.volume = Mathf.Clamp(skiiSound.volume, 0f, skiiSoundVolume);

                if (skiiParticleisPlaying == false) // && skiiParticle.isPlaying == false)
                {
                    skiiParticleisPlaying = true;
                    skiiParticle.Play();
                }
            }
        }
        else
        {
            skiiSound.volume -= skiiSoundVolumeRate * Time.deltaTime;
            skiiSound.volume = Mathf.Clamp(skiiSound.volume, 0f, skiiSoundVolume);

            if (skiiParticleisPlaying == true) // && skiiParticle.isPlaying == true)
            {
                skiiParticleisPlaying = false;
                skiiParticle.Stop();
            }
        }
    }

    void PlayOneOfClips(AudioSource source, AudioClip[] clips)
    {
        source.PlayOneShot(clips[Random.Range(0, clips.Length)], Random.Range(0.8f, 1.2f));
    }

    void AdjustVolume(AudioSource source, float maxVolume, float changeRate)
    {
            source.volume += changeRate * Time.deltaTime;
            source.volume = Mathf.Clamp(source.volume, 0f, maxVolume);
    }

    void SkiiInput()
    {
        if (Input.GetKey(keybinds.keybindsProfile.skiiString))
        {
            skiiInput = true;
        }
        else
        {
            skiiInput = false;
        }
    }

    void JumpInput()
    {
        if (autoHop)
        { wishJump = Input.GetKey(keybinds.keybindsProfile.jumpString); skiiInput = wishJump; }
        else if (Input.GetKeyDown(keybinds.keybindsProfile.jumpString))
        { wishJump = true; }
        else if (Input.GetKeyUp(keybinds.keybindsProfile.jumpString))
        { wishJump = false; }
    }
}
